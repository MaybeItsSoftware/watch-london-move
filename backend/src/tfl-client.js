const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Worker, isMainThread } = require('worker_threads');
// The .js extensions are load-bearing: stream-json v3 declares "./*": "./src/*"
// in its export map, which substitutes literally and does not resolve
// extensions, so the extensionless specifier fails at require time.
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/stream-array.js');
const { canonicalizeStationName } = require('./canonicalization');
const { createUraRowReader, uraRequestUrl } = require('./ura-feed');
const { vehicleTypeForLine } = require('./lines');

const logger = pino({ name: 'tfl-client' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TfL suffixes a stop's `commonName` with what kind of place it is, but leaves
// an arrival's `stationName` bare. Stripping it first lets canonicalization put
// back whichever suffix that mode actually uses — it appends " Station" for the
// tube and nothing for tram, DLR, Elizabeth or Overground.
const STOP_KIND_SUFFIX = / (?:Underground Station|DLR Station|Rail Station|Tram Stop)$/;

/**
 * A rail stop as it should read on screen. The same station reaches us spelled
 * two ways depending on which field it came out of — "Wimbledon" in an arrival's
 * `stationName`, "Wimbledon Tram Stop" in the stop index's `commonName` — and a
 * vehicle's next-stop line is now built from both, so they have to be normalised
 * through one place or the panel changes wording as the vehicle moves along it.
 */
function railStationName(name, lineId) {
  return canonicalizeStationName((name || '').replace(STOP_KIND_SUFFIX, ''), lineId);
}

function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

class TflClient {
  constructor(config) {
    this.config = config;
    this.http = axios.create({
      baseURL: config.tflApiBaseUrl,
      timeout: 15000,
      // The whole-network bus feed is ~90MB of JSON (~8MB on the wire, gzipped
      // by default), well past axios' default body ceiling.
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      params: {
        ...(config.tflAppId ? { app_id: config.tflAppId } : {}),
        ...(config.tflAppKey ? { app_key: config.tflAppKey } : {}),
      },
    });

    // A second client, because URA rejects the credentials the Unified API
    // requires: any request carrying app_id/app_key answers HTTP 400. Verified
    // live — without a key 200, with one 400. Since TFL_APP_KEY is unset on a
    // laptop and set in production, sharing `this.http` would pass every local
    // test and fail only once deployed.
    this.uraHttp = axios.create({
      baseURL: this.config.uraBaseUrl,
      timeout: this.config.uraTimeoutMs,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        // URA is undocumented and unauthenticated, so this is the only way TfL
        // can attribute the traffic or get in touch about it.
        'User-Agent': 'watch-london-move (+https://github.com/MaybeItsSoftware/watch-london-move)',
      },
    });
    /** Feed clock from the last URA header row, for skew reporting. */
    this.uraFeedClockMs = null;
    /** Lowercased TfL bus line ids, for the URA route allowlist. Null until loaded. */
    this.busLineAllowlist = null;
    this.busLineAllowlistAt = 0;
    this.uraStats = null;

    this.cache = {
      bus: { at: 0, data: [], failedLines: [] },
      train: { at: 0, data: [], failedLines: [] },
    };

    // naptanId -> { lat, lon, name }. Arrivals carry no coordinates of their own,
    // so every vehicle is positioned by joining its next stop against this index.
    this.stopPoints = new Map();
    this.stopPointsExpiresAt = 0;
    this.stopPointsInFlight = null;
    // Bumped whenever the index is replaced, so the worker thread can tell
    // whether its mirror is current without comparing 33,000 entries.
    this.stopsEpoch = 0;

    // See bus-feed-worker.js. Spawned lazily on the first whole-network poll
    // rather than at construction: a deployment tracking a named subset of
    // routes never uses the mode endpoint and should not carry a second thread
    // for it, and the worker is useless before the stop index exists anyway.
    this.busWorker = null;
    this.busWorkerEpoch = -1;
    this.busWorkerPending = new Map();
    this.busWorkerRequestId = 0;
    this.busWorkerDisabled = false;
    this.busWorkerClosing = false;
  }

  /**
   * The worker thread, spawned on first use. Returns null when the worker is
   * turned off or has failed, which is the signal to run the feed in process.
   *
   * A failure disables it permanently rather than retrying: the reasons a worker
   * cannot start (no `worker_threads`, a missing file, a memory ceiling) do not
   * heal between polls, and retrying every cycle would add a spawn to the very
   * path this exists to keep quiet.
   */
  ensureBusWorker() {
    if (this.busWorkerDisabled || !this.config.busFeedWorker || !isMainThread) {
      return null;
    }
    if (this.busWorker) {
      return this.busWorker;
    }

    try {
      const worker = new Worker(path.join(__dirname, 'bus-feed-worker.js'), {
        workerData: { config: this.config },
      });
      // Unref'd so a stuck 60-second feed request can never hold the process
      // open past the platform's kill timeout. The server's emit interval is a
      // module-level timer, so the event loop is never resting on this alone.
      worker.unref();
      worker.on('message', ({ requestId, vehicles, error }) => {
        const pending = this.busWorkerPending.get(requestId);
        if (!pending) {
          return;
        }
        this.busWorkerPending.delete(requestId);
        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(vehicles);
        }
      });
      worker.on('error', (error) => this.failBusWorker(error));
      worker.on('exit', (code) => {
        // `terminate()` resolves with a non-zero code, so a shutdown would
        // otherwise log itself as a failure on the way out.
        if (code !== 0 && !this.busWorkerClosing) {
          this.failBusWorker(new Error(`bus feed worker exited with code ${code}`));
        }
      });
      this.busWorker = worker;
      logger.info('Bus feed worker started');
      return worker;
    } catch (error) {
      this.failBusWorker(error);
      return null;
    }
  }

  /** Tear the worker down and fall back to the in-process path from here on. */
  failBusWorker(error) {
    if (this.busWorkerDisabled) {
      return;
    }
    this.busWorkerDisabled = true;
    logger.warn({ err: error?.message }, 'Bus feed worker failed; falling back to in-process parsing');
    for (const pending of this.busWorkerPending.values()) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.busWorkerPending.clear();
    const worker = this.busWorker;
    this.busWorker = null;
    this.busWorkerEpoch = -1;
    worker?.terminate().catch(() => {});
  }

  /** For `/health`: `off` was never asked for, `fallback` means it was and could
   *  not be had, which is worth being able to see rather than infer from a stall. */
  busFeedWorkerState() {
    if (!this.config.busFeedWorker) {
      return 'off';
    }
    if (this.busWorkerDisabled) {
      return 'fallback';
    }
    return this.busWorker ? 'running' : 'idle';
  }

  /** Called from the server's shutdown path so a stuck fetch cannot hold the
   *  process open past the platform's kill timeout. */
  close() {
    const worker = this.busWorker;
    this.busWorkerClosing = true;
    this.busWorker = null;
    return worker ? worker.terminate().then(() => undefined) : Promise.resolve();
  }

  getStopPointCount() {
    return this.stopPoints.size;
  }

  // The index is ~33k stops network-wide, far too many to send at once, and
  // only useful to a client zoomed in far enough to read the names. Callers pass
  // the box they are looking at and take a hard cap: a request for too wide an
  // area is answered with nothing rather than with an arbitrary subset, so the
  // client can tell "no stops here" from "too many to draw".
  getStopsInBounds({ west, south, east, north }, limit = 400) {
    const stops = [];
    for (const [id, stop] of this.stopPoints) {
      if (stop.lat < south || stop.lat > north || stop.lon < west || stop.lon > east) {
        continue;
      }
      if (stops.length >= limit) {
        return { stops: [], truncated: true };
      }
      stops.push({ id, lat: stop.lat, lon: stop.lon, name: stop.name });
    }
    return { stops, truncated: false };
  }

  // /Line/{id}/StopPoints does not accept comma-separated ids, so this costs one
  // request per line. It runs in small groups to avoid a burst against the rate
  // limit, and only once per stopPointCacheMs since stop coordinates are static.
  async ensureStopPoints() {
    if (this.stopPoints.size > 0 && Date.now() < this.stopPointsExpiresAt) {
      return this.stopPoints;
    }

    // Bus and train fetches run concurrently and would otherwise each kick off a
    // full load, doubling the startup burst — share one in-flight load instead.
    if (!this.stopPointsInFlight) {
      this.stopPointsInFlight = this.loadStopPoints().finally(() => {
        this.stopPointsInFlight = null;
      });
    }

    return this.stopPointsInFlight;
  }

  // Stop coordinates barely change, so a restart should not cost another 28
  // requests. Failures here are non-fatal: worst case we rebuild from the API.
  // The cached index only covers the line set it was built for, so it is keyed by
  // that set: switching between a bus subset and the whole network must rebuild
  // rather than silently reuse an index missing most of London's stops.
  stopPointCacheKey() {
    const lines = this.config.allBusLines ? ['bus:all'] : [...this.config.busLines].sort();
    return [...[...this.config.trainLines].sort(), ...lines].join(',');
  }

  readStopPointCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.stopPointCachePath, 'utf8'));
      if (!raw?.builtAt || !Array.isArray(raw.stops) || raw.stops.length === 0) {
        return null;
      }
      if (raw.key !== this.stopPointCacheKey()) {
        return null;
      }
      if (Date.now() - raw.builtAt >= this.config.stopPointCacheMs) {
        return null;
      }
      return { builtAt: raw.builtAt, index: new Map(raw.stops) };
    } catch {
      return null;
    }
  }

  writeStopPointCache(index) {
    try {
      fs.mkdirSync(path.dirname(this.config.stopPointCachePath), { recursive: true });
      fs.writeFileSync(
        this.config.stopPointCachePath,
        JSON.stringify({ builtAt: Date.now(), key: this.stopPointCacheKey(), stops: [...index] }),
      );
    } catch (error) {
      logger.warn({ err: error.message }, 'Could not persist stop point cache');
    }
  }

  static collectStops(index, stops) {
    (Array.isArray(stops) ? stops : []).forEach((stop) => {
      if (stop?.naptanId && Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
        index.set(stop.naptanId, { lat: stop.lat, lon: stop.lon, name: stop.commonName });
      }
    });
  }

  // London has ~640 bus routes across ~20k stops. Per-line StopPoints would cost
  // one request per route; the mode endpoint covers every bus stop in ~20 pages.
  // Pages are fetched one at a time so this one-off build never bursts.
  async loadBusStopPoints(index) {
    let page = 1;
    let collected = 0;
    let total = Infinity;

    while (collected < total) {
      let response;
      try {
        // eslint-disable-next-line no-await-in-loop -- deliberate: paces the burst
        response = await this.getJsonWithRetry(
          `/StopPoint/Mode/bus?page=${page}`,
          this.config.retryCount,
          this.config.retryBaseDelayMs,
        );
      } catch (error) {
        logger.warn({ err: error.message, page }, 'Bus stop point page failed');
        return false;
      }

      const stops = response?.stopPoints;
      if (!Array.isArray(stops) || stops.length === 0) {
        // A short page before the declared total means the feed cut us off.
        return collected > 0 && collected >= total;
      }

      TflClient.collectStops(index, stops);
      collected += stops.length;
      total = Number.isFinite(response.total) ? response.total : collected;
      page += 1;

      if (collected < total) {
        // eslint-disable-next-line no-await-in-loop -- deliberate: paces the burst
        await sleep(this.config.stopPointPagePaceMs);
      }
    }

    return true;
  }

  async loadStopPoints() {
    const cached = this.readStopPointCache();
    if (cached) {
      this.stopPoints = cached.index;
      this.stopsEpoch += 1;
      this.stopPointsExpiresAt = cached.builtAt + this.config.stopPointCacheMs;
      logger.info({ stops: cached.index.size }, 'Stop point index loaded from cache');
      return this.stopPoints;
    }

    const now = Date.now();
    // Rail lines are few enough to fetch per line; so are bus routes when an
    // explicit subset was configured. The whole bus network goes via the mode
    // endpoint below instead.
    const lineIds = [...new Set([...this.config.trainLines, ...this.config.busLines])];
    const index = new Map();
    const failedLines = [];

    for (const group of chunk(lineIds, this.config.linesPerRequest)) {
      // eslint-disable-next-line no-await-in-loop -- deliberate: paces the burst
      const settled = await Promise.allSettled(
        group.map((lineId) =>
          this.getJsonWithRetry(
            `/Line/${encodeURIComponent(lineId)}/StopPoints`,
            this.config.retryCount,
            this.config.retryBaseDelayMs,
          ),
        ),
      );

      settled.forEach((result, i) => {
        if (result.status !== 'fulfilled') {
          failedLines.push(group[i]);
          return;
        }
        TflClient.collectStops(index, result.value);
      });
    }

    const busStopsComplete = this.config.allBusLines ? await this.loadBusStopPoints(index) : true;

    if (index.size === 0) {
      // Keep any previously built index rather than losing the ability to position.
      logger.error({ failedLines }, 'Stop point index came back empty; keeping previous index');
      return this.stopPoints;
    }

    this.stopPoints = index;
    this.stopsEpoch += 1;
    // Only persist and fully trust a complete index — a partial one would freeze
    // its gaps in place for the whole TTL, so retry it soon instead.
    const complete = failedLines.length === 0 && busStopsComplete;
    this.stopPointsExpiresAt = now + (complete ? this.config.stopPointCacheMs : this.config.stopPointRetryMs);
    if (complete) {
      this.writeStopPointCache(index);
    }

    logger.info({ stops: index.size, failedLines, busStopsComplete, complete }, 'Stop point index built');
    return index;
  }

  /**
   * When this vehicle is due at its next stop, as an absolute epoch millisecond.
   *
   * `timeToStation` is seconds *from when TfL computed it*, which is not when we
   * read it: the whole-network bus feed alone takes ~10s to transfer, and it then
   * sits in a cache window before being emitted. Carrying a relative countdown
   * through that pipeline means it arrives already spent, which made every glide
   * too slow and every vehicle late. An absolute deadline survives the trip.
   *
   * `fetchedAtMs` is the instant the request *started*, which is the right basis
   * for the derived fallbacks — the response body describes the world as of
   * roughly then, not as of when the last byte landed.
   */
  static expectedArrivalMs(item, fetchedAtMs) {
    // URA reports an absolute epoch instant, so there is nothing to triangulate
    // and no clock skew to reason about. The Unified feed has no such field, so
    // rail and the old bus path fall through to the logic below unchanged.
    if (Number.isFinite(item.expectedArrivalMs)) {
      return item.expectedArrivalMs;
    }
    const ttlMs = Number.isFinite(item.timeToStation) ? item.timeToStation * 1000 : null;
    const derived = ttlMs === null ? null : fetchedAtMs + ttlMs;

    // Cross-checking against our own arithmetic catches TfL's placeholder dates
    // ("0001-01-01T00:00:00") and a genuinely skewed clock in one comparison. Two
    // minutes is far wider than any transfer lag and far narrower than a garbage
    // timestamp, so a disagreement means the field is not usable.
    const absolute = Date.parse(item.expectedArrival);
    if (Number.isFinite(absolute) && (derived === null || Math.abs(absolute - derived) <= 120000)) {
      return absolute;
    }

    // Second choice: TfL's own record of when it computed the prediction.
    const inserted = Date.parse(item.timestamp);
    if (Number.isFinite(inserted) && ttlMs !== null && Math.abs(inserted - fetchedAtMs) <= 120000) {
      return inserted + ttlMs;
    }

    return derived;
  }

  /**
   * Of two candidate arrivals for the same vehicle, is the first the better
   * description of where it is heading *now*?
   *
   * An arrival still ahead of us always beats one already behind, and among
   * those ahead the soonest wins — that is the stop being approached. When every
   * prediction has expired the vehicle has run off the end of what TfL told us,
   * so the latest one is the furthest along its route and the closest thing to
   * its last known position.
   */
  static isBetterArrival(candidate, incumbent, nowMs) {
    const candidateAhead = candidate >= nowMs;
    const incumbentAhead = incumbent >= nowMs;
    if (candidateAhead !== incumbentAhead) {
      return candidateAhead;
    }
    return candidateAhead ? candidate < incumbent : candidate > incumbent;
  }

  /**
   * Total order over one vehicle's candidate rows, ranking them exactly as
   * `isBetterArrival` compares a pair: stops still ahead first and soonest
   * first, then the expired ones latest-first.
   *
   * Ties return 0 rather than an arbitrary side. `isBetterArrival` answers
   * "strictly better?", so two rows sharing a deadline make it false both ways;
   * turning that into 1 both ways would be an inconsistent comparator and would
   * let the engine reorder equals. Sorting is stable, so 0 keeps feed order for
   * equals — which is what the previous single-incumbent loop did, and what
   * makes element 0 provably the same row it used to pick.
   *
   * A row we cannot time is a last resort: it positions the vehicle, but any row
   * with a real prediction describes it better, so nulls sort to the back.
   */
  static compareArrivals(a, b, nowMs) {
    if (a.dueAt === b.dueAt) {
      return 0;
    }
    if (a.dueAt === null) {
      return 1;
    }
    if (b.dueAt === null) {
      return -1;
    }
    return TflClient.isBetterArrival(a.dueAt, b.dueAt, nowMs) ? -1 : 1;
  }

  /**
   * A vehicle appears once per upcoming stop, so the raw feed has ~8 rows per
   * vehicle. One of them positions it; the next few describe where it is going.
   *
   * Picking the smallest `timeToStation` is the obvious choice and the wrong
   * one. TfL serves predictions about 70 seconds after computing them, so the
   * nearest stop by that measure is usually one the vehicle has *already passed*
   * — measured against the live feed, that mis-places 46% of Central line trains
   * and leaves them parked on a platform they have left. Comparing absolute
   * arrival times against the clock instead picks the stop genuinely still
   * ahead, which is both where the vehicle is going and the far end of the
   * stretch of track or road it is currently on.
   *
   * Returns `{ item, schedule }` per vehicle, `item === schedule[0]`, with the
   * schedule capped at `scheduleStops` rows *including* that first one — so the
   * default of 3 puts two further stops on the wire and 1 reproduces the old
   * single-stop result. The tail is cut at the first row that is not strictly
   * later than the one before it, which drops the expired rows behind the
   * vehicle without a second pass: they sort latest-first, so the very first of
   * them already fails the test. Cost is one sort of ~8 elements per vehicle.
   */
  /**
   * Incremental form of `nearestStopArrivals`, so the whole-network feed can be
   * reduced as it arrives rather than after the entire array exists in memory.
   *
   * The batch version is now a thin wrapper over this, so both paths share one
   * implementation and cannot drift.
   */
  static arrivalAccumulator(nowMs, scheduleStops = 1) {
    const byVehicle = new Map();
    // TfL sends roughly eight predictions per vehicle and we keep at most
    // `scheduleStops` of them, so this never truncates a real response — it
    // exists so one malformed vehicle with thousands of rows cannot reintroduce
    // the unbounded growth that streaming is here to remove.
    const cap = Math.max(scheduleStops * 4, 24);

    return {
      add(item) {
        const key = item?.vehicleId || item?.id;
        if (!key || !item?.naptanId) {
          return;
        }
        const entry = { dueAt: TflClient.expectedArrivalMs(item, nowMs), item };
        const rows = byVehicle.get(key);
        if (!rows) {
          byVehicle.set(key, [entry]);
          return;
        }
        rows.push(entry);
        if (rows.length > cap) {
          rows.sort((a, b) => TflClient.compareArrivals(a, b, nowMs));
          rows.length = cap;
        }
      },
      size: () => byVehicle.size,
      finish: () => TflClient.selectSchedules(byVehicle, nowMs, scheduleStops),
    };
  }

  static nearestStopArrivals(arrivals, nowMs, scheduleStops = 1) {
    const accumulator = TflClient.arrivalAccumulator(nowMs, scheduleStops);
    arrivals.forEach((item) => accumulator.add(item));
    return accumulator.finish();
  }

  // How far past due every one of a vehicle's predictions may be before the
  // vehicle is dropped rather than placed.
  static get ALL_EXPIRED_GRACE_MS() {
    return 180000;
  }

  static selectSchedules(byVehicle, nowMs, scheduleStops) {
    const results = [];
    for (const rows of byVehicle.values()) {
      rows.sort((a, b) => TflClient.compareArrivals(a, b, nowMs));

      // When every prediction has expired, compareArrivals falls through to
      // "the latest one is the furthest along" — a sensible last-known-position
      // guess under the Unified feed, which serves predictions ~70s stale. Under
      // URA it is a trap: URA drops passed stops at source, so if nothing is left
      // in the future the data is junk, and that branch would send every vehicle
      // to the far end of its route at once. Drop them and let prune reclaim.
      const soonest = rows[0].dueAt;
      if (Number.isFinite(soonest) && soonest < nowMs - TflClient.ALL_EXPIRED_GRACE_MS) {
        continue;
      }

      const schedule = [rows[0].item];
      const seen = new Set([rows[0].item.naptanId]);
      let previousDueAt = rows[0].dueAt;

      for (let i = 1; i < rows.length && schedule.length < scheduleStops; i += 1) {
        const { dueAt, item } = rows[i];
        if (previousDueAt === null || dueAt === null || dueAt <= previousDueAt) {
          break;
        }
        previousDueAt = dueAt;
        // The same stop can appear twice (two platforms of one station, a bus
        // route that doubles back); a repeat would give the client a zero-length
        // leg to travel, so keep the first and carry on down the list.
        if (!seen.has(item.naptanId)) {
          seen.add(item.naptanId);
          schedule.push(item);
        }
      }

      results.push({ item: schedule[0], schedule });
    }

    return results;
  }

  /**
   * What the bus feed did last cycle. The single lastPollVehicles total cannot
   * show a bus-side regression while rail is healthy, and the whole point of the
   * soak is to notice one.
   */
  busFeedStats() {
    const ageMs = this.cache.bus.at > 0 ? Date.now() - this.cache.bus.at : null;
    return {
      source: this.config.busFeedSource,
      vehicles: this.cache.bus.data.length,
      ageMs,
      // Our clock minus URA's own. A skew that grows rather than jitters means a
      // frozen feed whose predictions all still look like the future.
      clockSkewMs: this.uraFeedClockMs === null ? null : Date.now() - this.uraFeedClockMs,
      rows: this.uraStats?.arrivals ?? null,
      dropped: this.uraStats?.dropped ?? null,
      // Non-zero means TfL changed the response shape. That is an abort signal,
      // not a tuning one.
      unknownRows: this.uraStats?.unknownRows ?? null,
      lineNames: new Set(this.cache.bus.data.map((v) => v.line_name)).size,
    };
  }

  getFailedLines() {
    return [...new Set([...this.cache.bus.failedLines, ...this.cache.train.failedLines])];
  }

  // Lines are requested in small batches to stay inside TfL's rate limit, and each
  // batch is settled independently so one bad line id (or one 429) takes down only
  // its own batch rather than the whole cycle.
  async fetchArrivalsByLine(lineIds, mapArrivals) {
    const groups = chunk(lineIds, this.config.linesPerRequest);
    // Stamped before the requests go out, so `expectedArrivalMs` dates its
    // fallbacks from when the batch was asked for rather than when it answered.
    const fetchedAtMs = Date.now();

    const settled = await Promise.allSettled(
      groups.map(async (group) => {
        const arrivals = await this.getJsonWithRetry(
          `/Line/${group.map(encodeURIComponent).join(',')}/Arrivals`,
          this.config.retryCount,
          this.config.retryBaseDelayMs,
        );

        // A batched response mixes every line in the group together, so split it
        // back out by lineId before handing each line to the mapper.
        const byLine = new Map(group.map((lineId) => [lineId, []]));
        (Array.isArray(arrivals) ? arrivals : []).forEach((item) => {
          // Only fall back to the requested id when the batch is unambiguous —
          // guessing a line for an unlabelled record would mislabel the vehicle.
          const lineId = item?.lineId || (group.length === 1 ? group[0] : null);
          if (!lineId) {
            return;
          }
          if (!byLine.has(lineId)) {
            byLine.set(lineId, []);
          }
          byLine.get(lineId).push(item);
        });

        return [...byLine].flatMap(([lineId, items]) => mapArrivals(lineId, items, fetchedAtMs));
      }),
    );

    const vehicles = [];
    const failedLines = [];

    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        vehicles.push(...result.value);
        return;
      }

      failedLines.push(...groups[index]);
      logger.warn(
        {
          lines: groups[index],
          status: result.reason?.response?.status,
          message: result.reason?.response?.data?.message || result.reason?.message,
        },
        'Line arrivals batch failed; continuing with remaining batches',
      );
    });

    return { vehicles, failedLines };
  }

  async getJsonWithRetry(url, retries, delayMs, options) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.http.get(url, options);
        return response.data;
      } catch (error) {
        const status = error?.response?.status;
        // 4xx other than 429 (e.g. 404 for an unrecognised line id) will never
        // succeed on retry — fail fast instead of burning the backoff budget.
        const retryable = !status || status >= 500 || status === 429;
        if (attempt === retries || !retryable) {
          throw error;
        }

        const retryAfter = Number(error?.response?.headers?.['retry-after']);
        // Cap the wait: honouring a 60s Retry-After inside a 15s poll cycle just
        // stalls the whole cycle. Better to give up and catch the next poll.
        const requested = status === 429 && retryAfter ? retryAfter * 1000 : delayMs * 2 ** attempt;
        const waitTime = Math.min(requested, this.config.maxRetryWaitMs);

        logger.warn({ url, attempt, status, waitTime }, 'Retrying TfL request');
        await sleep(waitTime);
      }
    }

    return [];
  }

  // The set of bus routes changes rarely; callers cache the result.
  /**
   * The set of line names URA rows are accepted under, lowercased.
   *
   * URA answers for more than TfL's bus network: Tramlink runs through it as
   * routes T2 and T3, which the Unified bus feed omits entirely. Those trams
   * already reach the map through the rail path, so without this they arrive a
   * second time wearing bus livery — the same vehicle drawn twice, in two
   * colours, a few metres apart.
   *
   * Also protects the route-geometry join: a line name with no matching TfL id
   * has no path to snap to, so its vehicles would silently fall back to gliding
   * in straight lines. Refreshed on the stop-index TTL because the bus network
   * changes about as often.
   */
  async busLineNames() {
    const now = Date.now();
    if (this.busLineAllowlist && now < this.busLineAllowlistAt) {
      return this.busLineAllowlist;
    }
    try {
      const ids = await this.fetchBusLineIds();
      if (ids.length > 0) {
        this.busLineAllowlist = new Set(ids.map((id) => String(id).toLowerCase()));
        this.busLineAllowlistAt = now + this.config.stopPointCacheMs;
      }
    } catch (error) {
      // Never fatal: an empty allowlist would drop the entire fleet, which is a
      // far worse failure than letting four trams through.
      logger.warn({ err: error.message }, 'Could not refresh the bus line allowlist');
    }
    return this.busLineAllowlist;
  }

  async fetchBusLineIds() {
    const lines = await this.getJsonWithRetry(
      '/Line/Mode/bus',
      this.config.retryCount,
      this.config.retryBaseDelayMs,
    );
    return (Array.isArray(lines) ? lines : []).map((line) => line?.id).filter(Boolean);
  }

  /**
   * The vehicle's next few stops, positioned and timed, index 0 being the stop
   * it is heading for right now — the same one the record's own `lat`/`lon`/
   * `station_name`/`expected_arrival_ms` describe.
   *
   * That first entry is deliberately redundant. It keeps "where the vehicle is"
   * and "where it goes next" derived from one list rather than from two code
   * paths that could drift apart, and it gives the encoder a single thing to
   * slice.
   *
   * Truncated at the first stop we cannot place or time rather than skipping it.
   * The client consumes this as a queue of legs to glide along, so a hole in the
   * middle would not lose one stop, it would send the vehicle down the wrong leg
   * for the rest of the list.
   */
  /**
   * Where this arrival's stop is.
   *
   * The index wins over the feed's own coordinates, which is the opposite of what
   * it looks like it should be. URA carries per-stop latitude and longitude inline
   * and they are usually excellent — median deviation from TfL's surveyed index is
   * 0.6m, p99 82m. But a handful are catastrophically wrong: two stops report a
   * shared sentinel 30-45km from where they are, and that sentinel sits *inside*
   * any sane London bounding box, so a plausibility filter cannot catch it. A bus
   * routed through one would cross the map and back on every poll.
   *
   * So inline coordinates are the fallback for stops the index has never heard of,
   * not the primary. The Unified feed carries no coordinates at all, so its rows
   * always take the index path and rail is unaffected.
   */
  static stopFor(item, stopPoints) {
    const indexed = stopPoints?.get(item.naptanId);
    if (indexed) {
      return indexed;
    }
    if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
      return { lat: item.lat, lon: item.lon, name: item.stationName || '' };
    }
    return null;
  }

  static buildSchedule(items, stopPoints, fetchedAtMs, formatName = (name) => name) {
    const schedule = [];
    // Rows for the same vehicle can span both directions of a route — 19.7% of
    // vehicles, and 4.5% within the first three arrivals, which is exactly what
    // scheduleStops slices. The return-journey stops have later times, so they
    // pass the increasing-time and duplicate-stop guards and get appended, giving
    // the client a leg queue that runs to the terminus and then teleports back
    // down the outbound route. Anchor on the first row's direction instead.
    const direction = items[0]?.directionId ?? null;
    for (const item of items) {
      if (direction !== null && (item.directionId ?? null) !== direction) {
        break;
      }
      const stop = TflClient.stopFor(item, stopPoints);
      const dueAtMs = TflClient.expectedArrivalMs(item, fetchedAtMs);
      if (!stop || !Number.isFinite(dueAtMs)) {
        break;
      }
      schedule.push({
        naptan: item.naptanId,
        lat: stop.lat,
        lon: stop.lon,
        // The stop index holds `commonName`, which for rail is the full
        // "Seven Sisters Underground Station". The record's own `station_name`
        // is already tidied, so the rest of the list has to be tidied the same
        // way or the info panel changes wording as the vehicle moves along it.
        name: formatName(stop.name || ''),
        due_at_ms: dueAtMs,
      });
    }
    return schedule;
  }

  static busVehicle(item, lineId, stopPoints, source, fetchedAtMs, schedule = [item]) {
    const stop = TflClient.stopFor(item, stopPoints);
    if (!stop) {
      return null;
    }
    // Never a position-derived id. The old fallback keyed on the stop, so a bus
    // minted a fresh id every time it moved: the store treats that as a new
    // vehicle plus a stale removal, leaving a trail of phantoms each living out
    // staleVehicleMs. URA's own fleet number is always present when a
    // registration is not, and a row with neither is not a vehicle we can track.
    const identity = item.vehicleId
      || (item.uraVehicleId !== null && item.uraVehicleId !== undefined ? `ura-${item.uraVehicleId}` : null);
    if (!identity) {
      return null;
    }
    return {
      id: `bus-${identity}`,
      type: 'bus',
      line_name: item.lineName || lineId,
      lat: stop.lat,
      lon: stop.lon,
      heading: Number(item.bearing) || 0,
      destination: item.destinationName || item.towards || 'Unknown',
      station_name: stop.name,
      time_to_station: Number.isFinite(item.timeToStation) ? item.timeToStation : null,
      expected_arrival_ms: TflClient.expectedArrivalMs(item, fetchedAtMs),
      // Always set, never conditional: `StateStore.upsertVehicles` merges each
      // record over the previous one, so an omitted field is not "unchanged",
      // it is last poll's stop list kept forever.
      schedule: TflClient.buildSchedule(schedule, stopPoints, fetchedAtMs),
      route_group: 'bus',
      source,
    };
  }

  /**
   * One request for every bus in London. The response replaces the ~130 per-line
   * requests the same coverage would otherwise cost each cycle, but it is ~80MB
   * of JSON — a `JSON.parse` that blocks the event loop for 180ms on a fast
   * laptop and appreciably longer on a shared vCPU, plus a reduce over ~120,000
   * rows, on a cadence every connected client would feel as a stall.
   *
   * So by default none of it happens here: the request, the parse and the reduce
   * are all done in a worker thread and only the few thousand canonical records
   * come back. `BUS_FEED_WORKER=false`, or any failure to start the thread, runs
   * the identical code in process instead.
   */
  async fetchAllBusArrivals(stopPoints, fetchedAtMs) {
    const worker = this.ensureBusWorker();
    if (!worker) {
      return this.fetchAllBusArrivalsInProcess(stopPoints, fetchedAtMs);
    }

    // The mirror is only re-sent when the index has actually been rebuilt, which
    // is about once a day: it is ~33,000 entries, and a structured clone of that
    // on every poll would put back a good part of the main-thread cost this is
    // here to remove.
    if (this.busWorkerEpoch !== this.stopsEpoch) {
      worker.postMessage({ type: 'stops', epoch: this.stopsEpoch, entries: [...stopPoints] });
      this.busWorkerEpoch = this.stopsEpoch;
    }

    const requestId = (this.busWorkerRequestId += 1);
    const result = new Promise((resolve, reject) => {
      this.busWorkerPending.set(requestId, { resolve, reject });
    });
    worker.postMessage({ type: 'fetch', requestId, fetchedAtMs, epoch: this.stopsEpoch });

    try {
      return await result;
    } catch (error) {
      // A worker that answered with an error is still healthy — a 429 from TfL
      // reaches us this way — so this does not disable it. The caller already
      // treats a throw here as "keep the previous snapshot".
      this.busWorkerPending.delete(requestId);
      throw error;
    }
  }

  /**
   * The whole-network feed as a stream, reduced row by row.
   *
   * The buffered path holds three large things at once: the ~8MB gzipped body,
   * the ~90MB string it inflates to, and the ~120,000-object array that string
   * parses into. Only the last is useful, and only a few thousand records
   * survive the reduce — so peak memory, not steady state, is what sized this
   * service at 4GB, and on a platform billing actual usage that peak is paid for
   * every cycle.
   *
   * Streaming keeps one row in flight at a time. The accumulator holds bounded
   * per-vehicle state and everything else is collectable as it passes.
   *
   * Falls back to the buffered path on any streaming failure: this runs on the
   * worker thread where a throw costs the whole poll, and a slightly heavy poll
   * beats no data at all.
   */
  async fetchAllBusArrivalsStreaming(fetchedAtMs) {
    const response = await this.http.get('/Mode/bus/Arrivals?count=-1', {
      responseType: 'stream',
      timeout: this.config.busFeedTimeoutMs,
    });

    const accumulator = TflClient.arrivalAccumulator(fetchedAtMs, this.config.scheduleStops);
    const pipeline = chain([response.data, parser(), streamArray()]);

    await new Promise((resolve, reject) => {
      pipeline.on('data', ({ value }) => accumulator.add(value));
      pipeline.on('end', resolve);
      pipeline.on('error', reject);
      response.data.on('error', reject);
    });

    return accumulator.finish();
  }

  /** The whole-network feed, read on whichever thread calls this. Invoked
   *  directly by bus-feed-worker.js, and by the dispatcher above as a fallback. */
  async fetchAllBusArrivalsInProcess(stopPoints, fetchedAtMs) {
    let reduced;
    try {
      reduced = await this.fetchAllBusArrivalsStreaming(fetchedAtMs);
    } catch (error) {
      this.streamingFailures = (this.streamingFailures || 0) + 1;
      const arrivals = await this.getJsonWithRetry(
        '/Mode/bus/Arrivals?count=-1',
        this.config.retryCount,
        this.config.retryBaseDelayMs,
        { timeout: this.config.busFeedTimeoutMs },
      );
      reduced = TflClient.nearestStopArrivals(
        Array.isArray(arrivals) ? arrivals : [],
        fetchedAtMs,
        this.config.scheduleStops,
      );
    }

    return reduced
      .map(({ item, schedule }) =>
        TflClient.busVehicle(item, item.lineId, stopPoints, 'tfl-mode-arrivals', fetchedAtMs, schedule),
      )
      .filter(Boolean);
  }

  /**
   * The whole network from URA, reduced row by row.
   *
   * Rejects rather than returning a partial fleet: the caller caches whatever
   * this resolves with, so half a fleet would be cached as though it were real
   * and then served until it aged out.
   */
  async fetchUraBusArrivals(stopPoints, fetchedAtMs) {
    const response = await this.uraHttp.get(uraRequestUrl(this.config), {
      responseType: 'stream',
      // axios' own timeout covers the response headers, not a body that stalls
      // part-way through; this bounds the whole read.
      signal: AbortSignal.timeout(this.config.uraTimeoutMs),
    });

    const allowed = await this.busLineNames();
    const accumulator = TflClient.arrivalAccumulator(fetchedAtMs, this.config.scheduleStops);
    let rejectedLines = 0;
    const reader = createUraRowReader({
      onArrival: (arrival) => {
        if (allowed && !allowed.has(String(arrival.lineName).toLowerCase())) {
          rejectedLines += 1;
          return;
        }
        accumulator.add(arrival);
      },
      onHeader: (clockMs) => { this.uraFeedClockMs = clockMs; },
    });

    await new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        try {
          reader.push(chunk);
        } catch (error) {
          response.data.destroy();
          reject(error);
        }
      });
      response.data.on('end', resolve);
      response.data.on('error', reject);
    });
    this.uraStats = { ...reader.end(), rejectedLines };

    return accumulator
      .finish()
      .map(({ item, schedule }) =>
        TflClient.busVehicle(item, item.lineName, stopPoints, 'tfl-ura', fetchedAtMs, schedule),
      )
      .filter(Boolean);
  }

  async fetchBusArrivals() {
    const now = Date.now();
    if (now - this.cache.bus.at < this.config.busCacheWindowMs) {
      // A feed that has been failing for longer than a vehicle's stale window has
      // nothing worth serving. Returning the cached array instead would restamp
      // last_seen_at on every record in upsertVehicles, so prune could never fire
      // and the map would show a frozen fleet indefinitely with nothing raised.
      if (this.cache.bus.at > 0 && now - this.cache.bus.at > this.config.staleVehicleMs) {
        return [];
      }
      return this.cache.bus.data;
    }

    const stopPoints = await this.ensureStopPoints();

    if (this.config.busFeedSource === 'ura') {
      try {
        const vehicles = await this.fetchUraBusArrivals(stopPoints, now);
        const previous = this.cache.bus.data.length;
        const floor = Math.floor(previous * this.config.busFeedMinRetainedFraction);
        if (vehicles.length === 0 || (previous > 0 && vehicles.length < floor)) {
          // A 200 carrying nothing usable is not success. URA answers with only a
          // header row when it has no data, and a field-mapping slip makes every
          // row fail the naptan guard — neither throws, so without this the map
          // blanks and the empty result is cached as truth.
          logger.warn(
            { vehicles: vehicles.length, previous },
            'URA returned an implausibly small fleet; keeping previous snapshot',
          );
          this.cache.bus.failedLines = ['bus (ura, implausible)'];
          return this.cache.bus.data;
        }
        this.cache.bus = { at: now, data: vehicles, failedLines: [] };
        return vehicles;
      } catch (error) {
        logger.warn({ err: error.message }, 'URA bus arrivals failed; keeping previous snapshot');
        this.cache.bus.failedLines = ['bus (ura)'];
        return this.cache.bus.data;
      }
    }

    if (this.config.allBusLines) {
      try {
        const vehicles = await this.fetchAllBusArrivals(stopPoints, now);
        this.cache.bus = { at: now, data: vehicles, failedLines: [] };
        return vehicles;
      } catch (error) {
        // One request covers everything, so its failure would blank every bus on
        // the map — keep the previous snapshot and try again next cycle.
        logger.warn({ err: error.message }, 'Whole-network bus arrivals failed; keeping previous snapshot');
        this.cache.bus.failedLines = ['bus (all routes)'];
        return this.cache.bus.data;
      }
    }

    const { vehicles, failedLines } = await this.fetchArrivalsByLine(
      this.config.busLines,
      (lineId, arrivals, fetchedAtMs) =>
        TflClient.nearestStopArrivals(arrivals, fetchedAtMs, this.config.scheduleStops)
          .map(({ item, schedule }) =>
            TflClient.busVehicle(item, lineId, stopPoints, 'tfl-line-arrivals', fetchedAtMs, schedule),
          )
          .filter(Boolean),
    );

    this.cache.bus.failedLines = failedLines;

    if (failedLines.length === this.config.busLines.length && this.config.busLines.length > 0) {
      // Every line failed — keep the previous snapshot rather than blanking the map.
      return this.cache.bus.data;
    }

    this.cache.bus = { at: now, data: vehicles, failedLines };
    return vehicles;
  }

  async fetchTrainArrivals() {
    const now = Date.now();
    if (now - this.cache.train.at < this.config.trainCacheWindowMs) {
      return this.cache.train.data;
    }

    const stopPoints = await this.ensureStopPoints();

    const { vehicles, failedLines } = await this.fetchArrivalsByLine(
      this.config.trainLines,
      (lineId, arrivals, fetchedAtMs) =>
        TflClient.nearestStopArrivals(arrivals, fetchedAtMs, this.config.scheduleStops)
          .map(({ item, schedule }) => {
            const stop = stopPoints.get(item.naptanId);
            if (!stop) {
              return null;
            }
            return {
              id: `${lineId}-${item.vehicleId || `${item.id || item.naptanId}`}`,
              type: vehicleTypeForLine(lineId),
              line_name: item.lineName || lineId,
              lat: stop.lat,
              lon: stop.lon,
              heading: Number(item.bearing) || 0,
              destination: item.destinationName || item.towards || 'Unknown',
              station_name: railStationName(item.stationName, lineId),
              time_to_station: Number.isFinite(item.timeToStation) ? item.timeToStation : null,
              expected_arrival_ms: TflClient.expectedArrivalMs(item, fetchedAtMs),
              // See the note in `busVehicle`: this must be present on every
              // record, because an absent field survives the store's merge.
              schedule: TflClient.buildSchedule(schedule, stopPoints, fetchedAtMs, (name) =>
                railStationName(name, lineId),
              ),
              route_group: lineId,
              source: 'tfl-line-arrivals',
            };
          })
          .filter(Boolean),
    );

    this.cache.train.failedLines = failedLines;

    if (failedLines.length === this.config.trainLines.length && this.config.trainLines.length > 0) {
      return this.cache.train.data;
    }

    this.cache.train = { at: now, data: vehicles, failedLines };
    return vehicles;
  }

  async fetchUnifiedVehicles() {
    const [buses, trains] = await Promise.all([this.fetchBusArrivals(), this.fetchTrainArrivals()]);
    return [...buses, ...trains];
  }
}

module.exports = {
  TflClient,
};
