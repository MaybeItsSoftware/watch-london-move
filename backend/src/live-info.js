// Per-stop arrivals and network line status, served from here rather than asked
// of TfL by the device.
//
// The app used to call api.tfl.gov.uk directly for both, which put every user's
// IP address in front of TfL on every stop tap and every minute of line status —
// contradicting the privacy policy, which says TfL never sees the user. Going
// through the backend also means the requests carry TFL_APP_KEY and share one
// upstream budget, instead of each device spending TfL's anonymous allowance.

/** The modes whose line status the map shows. Everything the legend lists. */
const STATUS_MODES = 'tube,overground,dlr,elizabeth-line,tram';

/**
 * NaPTAN and hub ids are short and alphanumeric (`940GZZLUOXC`, `490000077E`,
 * `HUBZWL`). Checked before the id reaches a URL so a request cannot steer the
 * upstream path, and so junk never costs a TfL call.
 */
const STOP_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/** More than the panel draws (8), so a vehicle that departs between polls leaves spares. */
const MAX_ARRIVALS = 20;

function isValidStopId(id) {
  return typeof id === 'string' && STOP_ID_PATTERN.test(id);
}

/**
 * The fields the stop panel reads, and nothing else. A busy interchange answers
 * with 60+ rows of ~30 keys each; the panel draws eight rows of seven. Egress is
 * the hosting bill, so the trim is the point rather than a tidy-up.
 */
function trimArrivals(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter((row) => row && typeof row.lineId === 'string' && Number.isFinite(row.timeToStation))
    .sort((a, b) => a.timeToStation - b.timeToStation)
    .slice(0, MAX_ARRIVALS)
    .map((row) => ({
      id: String(row.id ?? `${row.vehicleId}-${row.lineId}`),
      lineId: row.lineId,
      lineName: row.lineName ?? row.lineId,
      destinationName: row.destinationName ?? '',
      timeToStation: row.timeToStation,
      ...(row.platformName ? { platformName: row.platformName } : {}),
      ...(row.towards ? { towards: row.towards } : {}),
    }));
}

/**
 * Every status a line reports, not just the first. A line with part closure on
 * one branch and good service on the rest answers with both, in no promised
 * order — so the client has to see them all to pick the worst.
 */
function trimLineStatuses(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }
  return lines
    .filter((line) => line && typeof line.id === 'string')
    .map((line) => ({
      id: line.id,
      lineStatuses: (Array.isArray(line.lineStatuses) ? line.lineStatuses : []).map((status) => ({
        statusSeverity: status.statusSeverity,
        statusSeverityDescription: status.statusSeverityDescription,
        ...(status.reason ? { reason: status.reason } : {}),
      })),
    }));
}

/**
 * Short-lived caches in front of the two TfL calls.
 *
 * Line status is one response for the whole network, so every client is served
 * the same copy and TfL sees one request a minute however many people are
 * watching. Arrivals are per stop and cached briefly, which collapses the
 * common case of several people looking at the same busy station.
 *
 * `fetchJson(path)` resolves to the parsed body and rejects with an axios-style
 * error (`error.response.status`) on failure — TflClient.getJsonWithRetry in
 * production, a stub in the tests.
 */
class LiveInfo {
  constructor({
    fetchJson,
    lineStatusTtlMs = 60000,
    arrivalsTtlMs = 10000,
    maxCachedStops = 500,
    now = Date.now,
  }) {
    this.fetchJson = fetchJson;
    this.lineStatusTtlMs = lineStatusTtlMs;
    this.arrivalsTtlMs = arrivalsTtlMs;
    this.maxCachedStops = maxCachedStops;
    this.now = now;

    this.lineStatus = null;
    this.lineStatusAt = 0;
    this.lineStatusInFlight = null;

    // stopId -> { at, arrivals } or { at, pending }. Insertion-ordered, so the
    // oldest entry is the first key when the cache needs trimming.
    this.arrivals = new Map();
  }

  /**
   * The cached network status, refreshed at most once per TTL. On a failed
   * refresh the last good copy is served rather than an error: status that is a
   * minute stale is still far more useful than none.
   */
  async getLineStatus() {
    if (this.lineStatus && this.now() - this.lineStatusAt < this.lineStatusTtlMs) {
      return this.lineStatus;
    }
    if (!this.lineStatusInFlight) {
      this.lineStatusInFlight = this.fetchJson(`/Line/Mode/${STATUS_MODES}/Status`)
        .then((body) => {
          this.lineStatus = trimLineStatuses(body);
          this.lineStatusAt = this.now();
          return this.lineStatus;
        })
        .catch((error) => {
          if (this.lineStatus) {
            return this.lineStatus;
          }
          throw error;
        })
        .finally(() => {
          this.lineStatusInFlight = null;
        });
    }
    return this.lineStatusInFlight;
  }

  /** Whether `stopId` would be answered from cache, so the caller can skip the upstream budget. */
  hasFreshArrivals(stopId) {
    const entry = this.arrivals.get(stopId);
    return Boolean(entry && (entry.pending || this.now() - entry.at < this.arrivalsTtlMs));
  }

  async getArrivals(stopId) {
    const entry = this.arrivals.get(stopId);
    if (entry?.pending) {
      return entry.pending;
    }
    if (entry && this.now() - entry.at < this.arrivalsTtlMs) {
      return entry.arrivals;
    }

    const pending = this.fetchJson(`/StopPoint/${encodeURIComponent(stopId)}/Arrivals`)
      .then((body) => {
        const arrivals = trimArrivals(body);
        this.remember(stopId, { at: this.now(), arrivals });
        return arrivals;
      })
      .catch((error) => {
        // Not cached: the next poll should try again rather than replay a failure.
        this.arrivals.delete(stopId);
        throw error;
      });
    this.remember(stopId, { at: this.now(), pending });
    return pending;
  }

  remember(stopId, entry) {
    this.arrivals.delete(stopId);
    this.arrivals.set(stopId, entry);
    // Bounded, because the key is chosen by the caller: without a ceiling a
    // client walking the stop index would grow this until the process fell over.
    while (this.arrivals.size > this.maxCachedStops) {
      this.arrivals.delete(this.arrivals.keys().next().value);
    }
  }
}

/**
 * The two routes, mounted by server.js.
 *
 * `clientLimit` is the per-client HTTP budget every other route spends.
 * `upstream` is a single global bucket in front of TfL itself: the per-client
 * limiter caps each address, but many addresses each asking for a different
 * stop would otherwise add up to a burst that spends the key's quota — which the
 * vehicle poller needs far more than any one stop panel does.
 */
function registerLiveInfoRoutes(app, { liveInfo, clientLimit, upstream, logger }) {
  app.get('/line-status', clientLimit, async (_req, res) => {
    try {
      const lines = await liveInfo.getLineStatus();
      // Every client gets the same body, so a shared cache in front may serve it.
      res.set('Cache-Control', 'public, max-age=30');
      res.json({ lines });
    } catch (error) {
      logger?.warn({ err: error.message }, 'Line status unavailable');
      res.set('Cache-Control', 'no-store');
      res.status(502).json({ error: 'line status unavailable' });
    }
  });

  app.get('/stops/:id/arrivals', clientLimit, async (req, res) => {
    const stopId = req.params.id;
    if (!isValidStopId(stopId)) {
      res.status(400).json({ error: 'invalid stop id' });
      return;
    }
    if (!liveInfo.hasFreshArrivals(stopId) && !upstream.take('tfl')) {
      const retryAfterSec = Math.max(1, upstream.retryAfterSec('tfl'));
      res.set('Retry-After', String(retryAfterSec));
      res.status(503).json({ error: 'busy', retryAfterSec });
      return;
    }
    try {
      const arrivals = await liveInfo.getArrivals(stopId);
      res.set('Cache-Control', 'no-store');
      res.json({ arrivals });
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404 || status === 400) {
        res.status(404).json({ error: 'unknown stop' });
        return;
      }
      logger?.warn({ err: error.message, stopId, status }, 'Stop arrivals unavailable');
      res.status(502).json({ error: 'arrivals unavailable' });
    }
  });
}

module.exports = {
  LiveInfo,
  registerLiveInfoRoutes,
  isValidStopId,
  trimArrivals,
  trimLineStatuses,
};
