/**
 * The single place a client-side failure is funnelled through.
 *
 * There was previously nowhere: a render throw left a white screen, a rejected
 * promise left nothing at all, and neither reached anybody. Having one entry
 * point means wiring up a real service later is a change to `send` rather than a
 * hunt for throw sites.
 *
 * Two sinks, both optional and both off unless configured. Forwarding a user's
 * errors to a third party is a privacy decision — and, for the store builds, a
 * disclosure one — so with neither set this is exactly a console log plus the
 * dedupe below.
 *
 * `VITE_SENTRY_DSN` is the one CI wires up; `VITE_ERROR_ENDPOINT` stays as a
 * plain-POST escape hatch for anywhere Sentry is not wanted.
 */

import { IS_NATIVE } from './lifecycle';

const ENDPOINT = import.meta.env.VITE_ERROR_ENDPOINT || '';
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || '';
// Set from the release tag by CI, and must match what sentry-cli associates the
// uploaded source maps with, or the stack traces stay minified.
const SENTRY_RELEASE = import.meta.env.VITE_SENTRY_RELEASE || 'dev';
/**
 * Derived at runtime, deliberately, rather than inlined at build time.
 *
 * The web deploy and the two store builds all run the *same* bundle from the
 * same tag, and one source-map upload is meant to cover all three. Baking the
 * platform in would change the bundle's bytes, change its content hash, and
 * leave the native builds pointing at maps uploaded for filenames that no
 * longer exist — silently, and only visible as unsymbolicated stack traces
 * weeks later. IS_NATIVE costs nothing and keeps the three byte-identical.
 */
const SENTRY_ENVIRONMENT = IS_NATIVE ? 'native' : 'web';

/**
 * Loaded on first error, never at startup.
 *
 * The SDK is ~30KB gzipped, and this is a map that fights for every kilobyte of
 * a cold start — MapLibre alone is already 273KB. A session that never errors is
 * the overwhelming majority, and it should not pay for the ones that do.
 *
 * The trade is real and worth stating: initialising at the moment of the first
 * error means Sentry has no breadcrumbs from before it, so reports carry the
 * stack and our own context but not the click-by-click history. Given the
 * bundle-size constraint here that is the right way round, but it is why a
 * report from this app looks thinner than one from a normally-instrumented app.
 */
let sentryPromise: Promise<typeof import('@sentry/react')> | null = null;

function loadSentry(): Promise<typeof import('@sentry/react')> {
  if (!sentryPromise) {
    sentryPromise = import('@sentry/react').then((Sentry) => {
      Sentry.init({
        dsn: SENTRY_DSN,
        release: SENTRY_RELEASE,
        environment: SENTRY_ENVIRONMENT,
        // Crash reporting only. Tracing would sample a 60Hz render loop and
        // session replay would record a full-screen map, both of which cost
        // exactly the bandwidth this project spends its time minimising.
        tracesSampleRate: 0,
        // The dedupe below already bounds volume; leaving Sentry's own
        // transport buffering on top of it just delays reports.
        maxBreadcrumbs: 20,
      });
      return Sentry;
    });
  }
  return sentryPromise;
}

/**
 * Errors here are overwhelmingly *repeating* errors: the render loop runs at up
 * to 60Hz and the socket reconnects on a timer, so a single broken assumption
 * produces thousands of identical reports a minute. Unbounded, the reporter
 * becomes a heavier load than the bug — on the network, and on whatever is
 * receiving it. Both limits below exist for that, not for tidiness.
 */
const MAX_REPORTS_PER_SESSION = 25;
const DEDUPE_WINDOW_MS = 60_000;

const lastSeen = new Map<string, number>();
let sent = 0;

export type ErrorContext = {
  /** Where it came from: 'render', 'unhandledrejection', 'window.onerror', … */
  source: string;
  /** Anything cheap and non-identifying that helps place it. */
  detail?: Record<string, unknown>;
};

function fingerprint(error: unknown, context: ErrorContext): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Message and origin, not the stack: minified frames differ between builds and
  // would defeat the dedupe on exactly the errors that repeat most.
  return `${context.source}|${message}`;
}

/** True if this exact failure has not been reported inside the dedupe window. */
function shouldSend(key: string, now: number): boolean {
  if (sent >= MAX_REPORTS_PER_SESSION) {
    return false;
  }
  const previous = lastSeen.get(key);
  if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) {
    return false;
  }
  lastSeen.set(key, now);
  return true;
}

function sendToSentry(error: unknown, context: ErrorContext): void {
  if (!SENTRY_DSN) {
    return;
  }
  void loadSentry()
    .then((Sentry) => {
      Sentry.captureException(error, {
        tags: { source: context.source },
        extra: context.detail,
      });
    })
    // Silent: a reporter that reports its own failures is a loop.
    .catch(() => {});
}

function send(payload: Record<string, unknown>): void {
  if (!ENDPOINT) {
    return;
  }
  const body = JSON.stringify(payload);
  // sendBeacon survives the page going away, which is where the interesting
  // errors tend to happen; fetch with keepalive is the fallback for WebViews
  // that do not implement it.
  if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
    return;
  }
  // Failure here is deliberately silent: a reporter that reports its own
  // transport failures is a loop.
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

export function reportError(error: unknown, context: ErrorContext): void {
  // Always local, regardless of dedupe or endpoint: the developer console is
  // the one sink that is always present and always wanted.
  console.error(`[${context.source}]`, error, context.detail ?? {});

  const key = fingerprint(error, context);
  if (!shouldSend(key, Date.now())) {
    return;
  }
  sent += 1;

  sendToSentry(error, context);

  send({
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'UnknownError',
    stack: error instanceof Error ? error.stack : undefined,
    source: context.source,
    detail: context.detail,
    // Enough to correlate a report with a build and a platform, and nothing that
    // identifies a person: no URL query, no storage, no ids.
    userAgent: navigator.userAgent,
    at: new Date().toISOString(),
  });
}

/**
 * Catches what React cannot: throws outside the component tree — rAF callbacks,
 * socket handlers, the interpolation loop — and rejected promises nobody awaited.
 * The error boundary handles render-time failures; between them the app has no
 * silent failure modes left.
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, {
      source: 'window.onerror',
      detail: { filename: event.filename, line: event.lineno, column: event.colno },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { source: 'unhandledrejection' });
  });
}
