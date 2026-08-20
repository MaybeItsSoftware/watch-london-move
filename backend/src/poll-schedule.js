// When to poll TfL, and when not to bother.
//
// The poller used to run unconditionally: a ~10s whole-network fetch, an ~80MB
// JSON.parse and a reduce over ~120,000 rows, every 15 seconds, forever. On a
// deployment measured at 133 polls against zero connected clients that is the
// single largest waste in the service — it is most of the compute bill, spent
// for nobody.
//
// The decision is pure and lives here rather than inline in server.js so it can
// be tested. server.js owns the timers; this owns the policy.

/**
 * Milliseconds to wait before the next poll, or `null` to suspend polling
 * entirely until a client arrives.
 *
 * Suspending is only reachable when idleIntervalMs is 0 or less, which is the
 * setting to use alongside a platform that sleeps idle containers: there is no
 * point holding a process awake to refresh data nobody is reading.
 */
function pollDelayMs({ connectedClients, activeIntervalMs, idleIntervalMs }) {
  if (connectedClients > 0) {
    return activeIntervalMs;
  }
  if (!Number.isFinite(idleIntervalMs) || idleIntervalMs <= 0) {
    return null;
  }
  return idleIntervalMs;
}

/**
 * Whether a client arriving should force a refresh rather than wait out the
 * timer it has just landed in the middle of.
 *
 * Without this, the first visitor after a quiet spell would be served whatever
 * the idle cadence last collected — up to five minutes stale by default, and
 * arbitrarily stale if polling was suspended. Vehicles would sit motionless on
 * the map until the next cycle, which reads as a broken app rather than a cold
 * one. The threshold is the *active* interval, so a client joining an already
 * busy service never triggers a redundant fetch.
 */
function shouldRefreshOnConnect({ lastPollAtMs, nowMs, activeIntervalMs }) {
  if (lastPollAtMs === null || lastPollAtMs === undefined) {
    return true;
  }
  return nowMs - lastPollAtMs > activeIntervalMs;
}

module.exports = { pollDelayMs, shouldRefreshOnConnect };
