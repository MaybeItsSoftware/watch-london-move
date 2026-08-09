import { IS_NATIVE } from './lifecycle';

/**
 * Service worker registration. Web only, and deliberately so.
 *
 * The native shell is skipped outright rather than allowed to fail. iOS serves
 * the app from `capacitor://localhost`, which is not an http(s) origin, so
 * registration rejects and logs an error on every cold start of a shipped app.
 * Android is the worse case: `https://localhost` *is* a secure context, so
 * registration can succeed and leave a worker sitting in front of Capacitor's
 * asset loader, caching files that already live in the app bundle. Neither
 * platform needs it — `cap sync` copies `dist/` into the binary, so the native
 * apps are offline-first by construction.
 */

/** `?sw=off` unregisters and wipes every cache, then reloads clean. */
const KILL_PARAM = 'sw';
const KILL_VALUE = 'off';
/**
 * Suppresses re-registration for the rest of the tab's session after `?sw=off`.
 *
 * Without it the reload immediately reinstalls the worker, which is fine when
 * the fault was a stale cache but useless when the fault is the worker itself.
 * sessionStorage rather than localStorage deliberately: an escape hatch that
 * survives closing the tab is a foot-gun that silently turns the feature off
 * forever for anyone who ever used it once.
 */
const KILL_FLAG = 'wlm-sw-off';

declare global {
  interface Window {
    /** Console-reachable twin of `?sw=off`, for when the URL bar is not the
     *  convenient way in. */
    __wlmResetSW?: () => Promise<void>;
  }
}

export function registerServiceWorker(): void {
  // A worker registered against the dev server would cache Vite's unbundled
  // module graph and hot-update endpoints, which is a slow, confusing way to
  // break HMR.
  if (import.meta.env.DEV || IS_NATIVE || !('serviceWorker' in navigator)) {
    return;
  }

  window.__wlmResetSW = resetServiceWorker;

  if (new URLSearchParams(window.location.search).get(KILL_PARAM) === KILL_VALUE) {
    void killAndReload();
    return;
  }

  if (sessionStorage.getItem(KILL_FLAG)) {
    return;
  }

  // After `load`, so installing the worker and precaching the shell does not
  // contend for bandwidth with the cold start it is supposed to be speeding up
  // — MapLibre's style, its glyphs and 2.2 MB of JS are all in flight before
  // this point. The first visit is uncontrolled either way; the worker only
  // starts intercepting on the next one.
  window.addEventListener('load', () => {
    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    navigator.serviceWorker
      .register(new URL('sw.js', base), {
        // `base: './'` in vite.config.ts means the app may be served from a
        // subdirectory as easily as from a web root, so scope is the document's
        // own directory rather than `/`. That is also the widest scope the
        // browser would allow a worker at `<base>sw.js` to claim, so the two
        // agree by construction and no Service-Worker-Allowed header is needed.
        scope: base.href,
        // Without this the browser may satisfy the worker-script request from
        // the HTTP cache for up to 24h, which pins a broken deploy in place for
        // exactly as long as it is most painful.
        updateViaCache: 'none',
      })
      .catch((error: unknown) => {
        // Nothing downstream depends on the worker — the app works without it,
        // it just pays full egress. Not worth surfacing to the user.
        console.warn('[sw] registration failed', error);
      });
  });
}

/** Unregister every worker on this scope and drop every cache it owns. */
async function resetServiceWorker(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  // Only this app's caches: on a shared origin, `caches.keys()` may well list
  // somebody else's.
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith('wlm-')).map((name) => caches.delete(name)),
  );
}

async function killAndReload(): Promise<void> {
  sessionStorage.setItem(KILL_FLAG, '1');
  await resetServiceWorker().catch(() => {});

  // Strip the parameter so the reload lands on a normal URL — otherwise a
  // bookmark or a back button re-arms the kill switch forever.
  const url = new URL(window.location.href);
  url.searchParams.delete(KILL_PARAM);
  window.location.replace(url);
}
