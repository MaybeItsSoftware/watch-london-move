#!/usr/bin/env node
/**
 * One soak sample against the deployed backend, judged rather than printed.
 *
 *   METRICS_TOKEN=… node scripts/soak-check.js [--json] [--url https://…]
 *
 * Written for the URA bus-feed migration: the question a sample has to answer is
 * not "what are the numbers" but "is this still safe to leave running". So every
 * check carries its own verdict and the process exits non-zero if any of them
 * fail, which is what makes it usable from a timer.
 *
 * Three of these are abort signals rather than things to tune — a changed feed
 * shape, a frozen feed, or a fleet that has collapsed. They are marked as such,
 * and they are the reason this exists instead of a dashboard nobody reads at
 * 3am.
 */
const DEFAULT_URL = 'https://watch-london-move-production.up.railway.app';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const urlArg = args.indexOf('--url');
const base = urlArg !== -1 ? args[urlArg + 1] : process.env.BACKEND_URL || DEFAULT_URL;
const token = process.env.METRICS_TOKEN;

if (!token) {
  console.error('METRICS_TOKEN is required — /health reports liveness only without it.');
  process.exit(2);
}

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

/**
 * @param {string} name
 * @param {string} verdict  pass | warn | fail
 * @param {string} detail   what was actually seen
 * @param {string} [why]    why it matters, shown only when not passing
 */
function check(name, verdict, detail, why) {
  return { name, verdict, detail, why };
}

async function main() {
  const started = Date.now();
  const response = await fetch(`${base}/health`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  const wakeMs = Date.now() - started;
  if (!response.ok) {
    console.error(`/health answered ${response.status}`);
    process.exit(1);
  }
  const h = await response.json();
  if (!h.metrics) {
    console.error('No metrics in the response — is METRICS_TOKEN correct?');
    process.exit(2);
  }

  const feed = h.busFeed ?? {};
  const m = h.metrics;
  const checks = [];

  // ── abort signals ──────────────────────────────────────────────────────────

  // Non-zero means URA answered with a shape we did not ask for. Mapping it
  // anyway would put longitude into the line name and keep running, so the
  // parser refuses — but a refusal that nobody notices is just an outage.
  checks.push(
    feed.unknownRows === null || feed.unknownRows === undefined
      ? check('feed shape', WARN, 'no URA stats yet (source may be unified)')
      : feed.unknownRows === 0
        ? check('feed shape', PASS, '0 unrecognised rows')
        : check('feed shape', FAIL, `${feed.unknownRows} unrecognised rows`,
            'ABORT: TfL has changed the response shape. Set BUS_FEED_SOURCE=unified.'),
  );

  // Measured at fetch time by the server, not derived here from the last poll's
  // timestamp: the poller backs off when nobody is connected, so a read-time
  // figure measures idleness and false-alarms overnight. Real lag is ~100ms.
  const skew = feed.clockSkewMs;
  checks.push(
    skew === null || skew === undefined
      ? check('feed clock', WARN, 'not reported')
      : Math.abs(skew) < 120000
        ? check('feed clock', PASS, `${Math.round(skew / 1000)}s behind our clock`)
        : check('feed clock', FAIL, `${Math.round(skew / 1000)}s behind our clock`,
            'ABORT: the feed appears frozen — predictions are stale but still look future-dated.'),
  );

  // The fleet collapsing is the failure the retention guard exists to catch; if
  // it shows up here the guard did not fire.
  checks.push(
    feed.vehicles > 3000
      ? check('fleet size', PASS, `${feed.vehicles} buses`)
      : feed.vehicles > 500
        ? check('fleet size', WARN, `${feed.vehicles} buses — low, check the hour`,
            'Night service is legitimately ~2,000. Below that at midday is not.')
        : check('fleet size', FAIL, `${feed.vehicles} buses`,
            'ABORT: the fleet has collapsed.'),
  );

  // ── health, not aborts ─────────────────────────────────────────────────────

  // Route names that do not join to a TfL bus id have no geometry to snap to,
  // so their vehicles glide in straight lines — invisible until someone looks.
  checks.push(
    feed.lineNames >= 500
      ? check('route coverage', PASS, `${feed.lineNames} routes`)
      : feed.lineNames >= 300
        ? check('route coverage', WARN, `${feed.lineNames} routes — expected ~540 by day`)
        : check('route coverage', FAIL, `${feed.lineNames} routes`,
            'Most of the network is missing.'),
  );

  const dropped = feed.dropped ?? {};
  const droppedTotal = Object.values(dropped).reduce((sum, n) => sum + (n || 0), 0);
  checks.push(
    droppedTotal === 0
      ? check('row drops', PASS, 'none')
      : check('row drops', WARN, JSON.stringify(dropped),
          'A rising trend means the feed is changing under us.'),
  );

  // The headline win. If this is not far below the Unified baseline of ~49s,
  // the migration is not doing what it was for.
  checks.push(
    m.lastPollLatencyMs < 15000
      ? check('poll latency', PASS, `${m.lastPollLatencyMs}ms`)
      : check('poll latency', WARN, `${m.lastPollLatencyMs}ms`,
          'Unified baseline was ~49s; URA alone should be ~1-2s plus rail.'),
  );

  checks.push(
    m.pollFailures === 0
      ? check('poll failures', PASS, '0')
      : check('poll failures', WARN, `${m.pollFailures} of ${m.polls}`,
          'URA is unauthenticated, so a throttle has no key to raise.'),
  );

  // Churn: vehicles flickering in and out cost their heading each time they
  // return, because resolveHeading has no previous record to fall back on.
  checks.push(
    m.prunedLastPoll < feed.vehicles * 0.1
      ? check('churn', PASS, `${m.prunedLastPoll} pruned last poll`)
      : check('churn', WARN, `${m.prunedLastPoll} pruned of ${feed.vehicles}`,
          'Vehicles are flickering in and out; each return costs its heading.'),
  );

  // How long since the last poll is a separate question from feed lag, and it is
  // only a fault if somebody is connected: with no clients the poller suspends
  // deliberately, and an hours-old fleet is the design working, not failing.
  const ageSec = feed.ageMs === null || feed.ageMs === undefined ? null : Math.round(feed.ageMs / 1000);
  checks.push(
    ageSec === null
      ? check('feed age', WARN, 'not reported')
      : m.connectedClients === 0
        ? check('feed age', PASS, `${ageSec}s — idle, poller suspended`)
        : ageSec < 120
          ? check('feed age', PASS, `${ageSec}s with ${m.connectedClients} client(s)`)
          : check('feed age', FAIL, `${ageSec}s stale with ${m.connectedClients} client(s) connected`,
              'ABORT: clients are being served a fleet that is not being refreshed.'),
  );

  checks.push(
    h.routeLoadComplete
      ? check('route geometry', PASS, `${h.routeLinesLoaded} lines, complete`)
      : check('route geometry', WARN, `${h.routeLinesLoaded} lines, still building`,
          'Expected briefly after a deploy; persistent means no cache volume.'),
  );

  const worst = checks.some((c) => c.verdict === FAIL)
    ? FAIL
    : checks.some((c) => c.verdict === WARN)
      ? WARN
      : PASS;

  if (asJson) {
    console.log(JSON.stringify({ at: new Date().toISOString(), verdict: worst, wakeMs, source: feed.source, checks }, null, 2));
  } else {
    const mark = { pass: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
    console.log(`soak ${new Date().toISOString()}  source=${feed.source ?? '?'}  wake=${wakeMs}ms`);
    for (const c of checks) {
      console.log(`${mark[c.verdict]} ${c.name.padEnd(16)} ${c.detail}`);
      if (c.why) console.log(`       ${' '.repeat(16)} ${c.why}`);
    }
    console.log(`verdict: ${worst.toUpperCase()}`);
  }

  process.exit(worst === FAIL ? 1 : 0);
}

main().catch((error) => {
  console.error('soak check failed:', error.message);
  process.exit(1);
});
