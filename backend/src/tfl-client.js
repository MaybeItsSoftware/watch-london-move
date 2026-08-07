const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { canonicalizeStationName } = require('./canonicalization');
const { vehicleTypeForLine } = require('./lines');

const logger = pino({ name: 'tfl-client' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    this.cache = {
      bus: { at: 0, data: [], failedLines: [] },
      train: { at: 0, data: [], failedLines: [] },
    };

    // naptanId -> { lat, lon, name }. Arrivals carry no coordinates of their own,
    // so every vehicle is positioned by joining its next stop against this index.
    this.stopPoints = new Map();
    this.stopPointsExpiresAt = 0;
    this.stopPointsInFlight = null;
  }

  getStopPointCount() {
    return this.stopPoints.size;
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

  // A vehicle appears once per upcoming stop, so the raw feed has ~8 rows per
  // vehicle. Keep only the nearest stop — that is where the vehicle is heading now.
  static nearestStopArrivals(arrivals) {
    const byVehicle = new Map();

    arrivals.forEach((item) => {
      const key = item?.vehicleId || item?.id;
      if (!key || !item?.naptanId) {
        return;
      }
      const timeToStation = Number.isFinite(item.timeToStation) ? item.timeToStation : Infinity;
      const best = byVehicle.get(key);
      if (!best || timeToStation < best.timeToStation) {
        byVehicle.set(key, { timeToStation, item });
      }
    });

    return [...byVehicle.values()].map((entry) => entry.item);
  }

  getFailedLines() {
    return [...new Set([...this.cache.bus.failedLines, ...this.cache.train.failedLines])];
  }

  // Lines are requested in small batches to stay inside TfL's rate limit, and each
  // batch is settled independently so one bad line id (or one 429) takes down only
  // its own batch rather than the whole cycle.
  async fetchArrivalsByLine(lineIds, mapArrivals) {
    const groups = chunk(lineIds, this.config.linesPerRequest);

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

        return [...byLine].flatMap(([lineId, items]) => mapArrivals(lineId, items));
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
  async fetchBusLineIds() {
    const lines = await this.getJsonWithRetry(
      '/Line/Mode/bus',
      this.config.retryCount,
      this.config.retryBaseDelayMs,
    );
    return (Array.isArray(lines) ? lines : []).map((line) => line?.id).filter(Boolean);
  }

  static busVehicle(item, lineId, stopPoints, source) {
    const stop = stopPoints.get(item.naptanId);
    if (!stop) {
      return null;
    }
    return {
      id: `bus-${item.vehicleId || `${lineId}-${item.naptanId}`}`,
      type: 'bus',
      line_name: item.lineName || lineId,
      lat: stop.lat,
      lon: stop.lon,
      heading: Number(item.bearing) || 0,
      destination: item.destinationName || item.towards || 'Unknown',
      station_name: stop.name,
      time_to_station: Number.isFinite(item.timeToStation) ? item.timeToStation : null,
      route_group: 'bus',
      source,
    };
  }

  // One request for every bus in London. The response is large (~90MB of JSON,
  // ~8MB gzipped, a few hundred ms to parse) but it replaces the ~130 per-line
  // requests the same coverage would otherwise cost each cycle.
  async fetchAllBusArrivals(stopPoints) {
    const arrivals = await this.getJsonWithRetry(
      '/Mode/bus/Arrivals?count=-1',
      this.config.retryCount,
      this.config.retryBaseDelayMs,
      { timeout: this.config.busFeedTimeoutMs },
    );

    return TflClient.nearestStopArrivals(Array.isArray(arrivals) ? arrivals : [])
      .map((item) => TflClient.busVehicle(item, item.lineId, stopPoints, 'tfl-mode-arrivals'))
      .filter(Boolean);
  }

  async fetchBusArrivals() {
    const now = Date.now();
    if (now - this.cache.bus.at < this.config.busCacheWindowMs) {
      return this.cache.bus.data;
    }

    const stopPoints = await this.ensureStopPoints();

    if (this.config.allBusLines) {
      try {
        const vehicles = await this.fetchAllBusArrivals(stopPoints);
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

    const { vehicles, failedLines } = await this.fetchArrivalsByLine(this.config.busLines, (lineId, arrivals) =>
      TflClient.nearestStopArrivals(arrivals)
        .map((item) => TflClient.busVehicle(item, lineId, stopPoints, 'tfl-line-arrivals'))
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

    const { vehicles, failedLines } = await this.fetchArrivalsByLine(this.config.trainLines, (lineId, arrivals) =>
      TflClient.nearestStopArrivals(arrivals)
        .map((item) => {
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
            station_name: canonicalizeStationName((item.stationName || '').replace(' Underground Station', ''), lineId),
            time_to_station: Number.isFinite(item.timeToStation) ? item.timeToStation : null,
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
