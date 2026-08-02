const axios = require('axios');
const pino = require('pino');
const { canonicalizeStationName } = require('./canonicalization');

const logger = pino({ name: 'tfl-client' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TflClient {
  constructor(config) {
    this.config = config;
    this.http = axios.create({
      baseURL: config.tflApiBaseUrl,
      timeout: 15000,
      params: {
        ...(config.tflAppId ? { app_id: config.tflAppId } : {}),
        ...(config.tflAppKey ? { app_key: config.tflAppKey } : {}),
      },
    });

    this.cache = {
      bus: { at: 0, data: [] },
      train: { at: 0, data: [] },
    };
  }

  async getJsonWithRetry(url, retries, delayMs) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.http.get(url);
        return response.data;
      } catch (error) {
        const status = error?.response?.status;
        if (attempt === retries) {
          throw error;
        }

        const retryAfter = Number(error?.response?.headers?.['retry-after']);
        const waitTime = status === 429 && retryAfter ? retryAfter * 1000 : delayMs * 2 ** attempt;

        logger.warn({ url, attempt, status, waitTime }, 'Retrying TfL request');
        await sleep(waitTime);
      }
    }

    return [];
  }

  async fetchBusArrivals() {
    const now = Date.now();
    if (now - this.cache.bus.at < this.config.busCacheWindowMs) {
      return this.cache.bus.data;
    }

    const results = await Promise.all(
      this.config.busLines.map(async (lineId) => {
        const arrivals = await this.getJsonWithRetry(`/Line/${encodeURIComponent(lineId)}/Arrivals`, this.config.retryCount, this.config.retryBaseDelayMs);
        return arrivals
          .filter((item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon))
          .map((item) => ({
            id: `bus-${item.vehicleId || `${lineId}-${item.naptanId}`}`,
            type: 'bus',
            line_name: item.lineName || lineId,
            lat: item.lat,
            lon: item.lon,
            heading: Number.isFinite(item.heading) ? item.heading : 0,
            destination: item.destinationName || item.towards || 'Unknown',
            route_group: 'bus',
            source: 'tfl-line-arrivals',
          }));
      }),
    );

    const flattened = results.flat();
    this.cache.bus = { at: now, data: flattened };
    return flattened;
  }

  async fetchTrainArrivals() {
    const now = Date.now();
    if (now - this.cache.train.at < this.config.trainCacheWindowMs) {
      return this.cache.train.data;
    }

    const results = await Promise.all(
      this.config.trainLines.map(async (lineId) => {
        const arrivals = await this.getJsonWithRetry(`/Line/${encodeURIComponent(lineId)}/Arrivals`, this.config.retryCount, this.config.retryBaseDelayMs);
        return arrivals
          .filter((item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon))
          .map((item) => ({
            id: `${lineId}-${item.vehicleId || `${item.id || item.naptanId}`}`,
            type: lineId === 'london-overground' ? 'overground' : lineId,
            line_name: item.lineName || lineId,
            lat: item.lat,
            lon: item.lon,
            heading: Number.isFinite(item.heading) ? item.heading : 0,
            destination: item.destinationName || item.towards || 'Unknown',
            station_name: canonicalizeStationName((item.stationName || '').replace(' Underground Station', ''), lineId),
            route_group: lineId,
            source: 'tfl-line-arrivals',
          }));
      }),
    );

    const flattened = results.flat();
    this.cache.train = { at: now, data: flattened };
    return flattened;
  }

  async fetchUnifiedVehicles() {
    const [buses, trains] = await Promise.all([this.fetchBusArrivals(), this.fetchTrainArrivals()]);
    return [...buses, ...trains];
  }
}

module.exports = {
  TflClient,
};
