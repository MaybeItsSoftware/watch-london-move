const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { vehicleTypeForLine } = require('./lines');

const logger = pino({ name: 'route-sequences' });

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

function isCoordPair(point) {
  return Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  if (dx === 0 && dy === 0) {
    return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  }
  return (
    Math.abs(dy * point[0] - dx * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) /
    Math.hypot(dx, dy)
  );
}

function douglasPeucker(points, tolerance) {
  if (points.length <= 2) {
    return points;
  }

  let maxDistance = 0;
  let maxIndex = 0;
  const last = points.length - 1;
  for (let i = 1; i < last; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points[last]);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance <= tolerance) {
    return [points[0], points[last]];
  }

  const left = douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
  const right = douglasPeucker(points.slice(maxIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

class RouteSequences {
  constructor(config, tflClient) {
    this.config = config;
    this.tflClient = tflClient;
    // lineId -> MultiLineString coordinates ([[[lon,lat],...],...]).
    this.lines = new Map();
    this.expiresAt = 0;
    this.complete = false;
    this.inFlight = null;
    this.geoJsonMemo = null;
  }

  isLoaded() {
    return this.lines.size > 0;
  }

  getLoadedLineCount() {
    return this.lines.size;
  }

  isComplete() {
    return this.complete;
  }

  async ensure() {
    // expiresAt is the retry window when the last load was partial or empty, the
    // full TTL when it was complete — so a bad load re-fetches soon, not in 7 days.
    if (Date.now() < this.expiresAt) {
      return this.lines;
    }

    if (!this.inFlight) {
      this.inFlight = this.load().finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  // Staleness is judged by the caller: an expired cache still seeds the resume
  // set so the map keeps showing last week's geometry while this week's loads.
  readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.routeSequenceCachePath, 'utf8'));
      if (!raw?.builtAt || !raw.lines || Object.keys(raw.lines).length === 0) {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  writeCache(lines, complete, emptyLines) {
    try {
      fs.mkdirSync(path.dirname(this.config.routeSequenceCachePath), { recursive: true });
      fs.writeFileSync(
        this.config.routeSequenceCachePath,
        JSON.stringify({
          builtAt: Date.now(),
          complete,
          emptyLines: [...(emptyLines ?? [])],
          lines: Object.fromEntries(lines),
        }),
      );
    } catch (error) {
      logger.warn({ err: error.message }, 'Could not persist route sequence cache');
    }
  }

  // TfL quirk: `lineStrings` is an array of JSON-encoded strings, each of which
  // parses to an array of linestrings — so it needs a parse plus one flatten.
  parseLineStrings(response) {
    const raw = Array.isArray(response?.lineStrings) ? response.lineStrings : [];
    const linestrings = [];

    raw.forEach((encoded) => {
      let parsed;
      try {
        parsed = JSON.parse(encoded);
      } catch {
        return;
      }
      (Array.isArray(parsed) ? parsed : []).forEach((linestring) => {
        if (!Array.isArray(linestring) || linestring.length < 2 || !linestring.every(isCoordPair)) {
          return;
        }
        linestrings.push(
          douglasPeucker(
            linestring.map((point) => [point[0], point[1]]),
            this.config.routeSimplifyToleranceDeg,
          ),
        );
      });
    });

    return linestrings;
  }

  async fetchLine(lineId) {
    const directions = ['outbound', 'inbound'];
    const coordinates = [];

    for (const direction of directions) {
      const response = await this.tflClient.getJsonWithRetry(
        `/Line/${encodeURIComponent(lineId)}/Route/Sequence/${direction}?serviceType=Regular&excludeCrowding=true`,
        this.config.retryCount,
        this.config.retryBaseDelayMs,
      );
      coordinates.push(...this.parseLineStrings(response));
    }

    // An empty result is a real answer, not a failure: plenty of bus routes have
    // no Regular-service geometry. The caller records it so it is not retried.
    return coordinates;
  }

  // Every line whose geometry we want: rail always, plus either the configured
  // bus subset or — by default — every bus route TfL lists.
  async targetLineIds() {
    const busLines = this.config.allBusLines
      ? await this.tflClient.fetchBusLineIds().catch((error) => {
          logger.warn({ err: error.message }, 'Could not list bus routes; loading rail geometry only');
          return [];
        })
      : this.config.busLines;
    return [...new Set([...this.config.trainLines, ...busLines])];
  }

  async load() {
    const now = Date.now();
    const cached = this.readCache();
    const fresh = cached ? now - cached.builtAt < this.config.routeSequenceCacheMs : false;

    // Whatever the cache holds is served straight away — even when stale, old
    // geometry beats an empty map while the rebuild runs.
    const loaded = new Map(cached ? Object.entries(cached.lines) : []);
    if (loaded.size > 0) {
      this.lines = loaded;
      this.geoJsonMemo = null;
    }

    const lineIds = await this.targetLineIds();
    // Lines TfL has no geometry for are remembered so a partial-cache resume does
    // not re-ask for them every retry window forever.
    const empty = new Set(fresh && Array.isArray(cached?.emptyLines) ? cached.emptyLines : []);
    // A fresh-but-partial cache resumes where it left off; a stale one refetches
    // everything so the geometry actually gets refreshed.
    const pending = fresh
      ? lineIds.filter((lineId) => !loaded.has(lineId) && !empty.has(lineId))
      : lineIds;
    const failedLines = [];

    // Coverage, not a stored flag, decides whether the cache is usable: widening
    // the tracked line set (a subset of bus routes to all of them) must invalidate
    // a cache that was "complete" for the narrower set.
    if (fresh && pending.length === 0) {
      this.expiresAt = cached.builtAt + this.config.routeSequenceCacheMs;
      this.complete = true;
      logger.info({ lines: loaded.size }, 'Route sequences loaded from cache');
      return this.lines;
    }

    logger.info(
      { pending: pending.length, alreadyLoaded: loaded.size, total: lineIds.length },
      'Building route geometry',
    );

    const groups = chunk(pending, this.config.linesPerRequest);
    for (const [groupIndex, group] of groups.entries()) {
      // eslint-disable-next-line no-await-in-loop -- deliberate: paces the burst
      const settled = await Promise.allSettled(group.map((lineId) => this.fetchLine(lineId)));

      settled.forEach((result, i) => {
        if (result.status !== 'fulfilled') {
          failedLines.push(group[i]);
        } else if (result.value.length > 0) {
          loaded.set(group[i], result.value);
        } else {
          empty.add(group[i]);
        }
      });

      // Publish and checkpoint as we go: at ~640 routes this build runs for many
      // minutes, so routes should appear progressively and a restart should not
      // start over from nothing.
      this.lines = loaded;
      this.geoJsonMemo = null;
      if ((groupIndex + 1) % this.config.routeCheckpointEvery === 0) {
        this.writeCache(loaded, false, empty);
      }

      // Route loading must never crowd out the arrivals polling budget, so each
      // group waits before the next regardless of how fast TfL answered.
      // eslint-disable-next-line no-await-in-loop
      await sleep(this.config.routeFetchPaceMs);
    }

    if (loaded.size === 0) {
      logger.error({ failedLines }, 'Route sequence load came back empty; keeping previous data');
      this.expiresAt = now + this.config.routeSequenceRetryMs;
      return this.lines;
    }

    this.lines = loaded;
    this.geoJsonMemo = null;
    // A gap-free set is trusted for the full TTL; a partial one is persisted too
    // (so the next run resumes rather than restarts) but retried sooner.
    this.complete = failedLines.length === 0;
    this.expiresAt = now + (this.complete ? this.config.routeSequenceCacheMs : this.config.routeSequenceRetryMs);
    this.writeCache(loaded, this.complete, empty);

    logger.info(
      { lines: loaded.size, empty: empty.size, failed: failedLines.length, complete: this.complete },
      'Route sequences built',
    );
    return this.lines;
  }

  getRoutesGeoJSON() {
    if (!this.geoJsonMemo) {
      this.geoJsonMemo = {
        type: 'FeatureCollection',
        features: [...this.lines].map(([lineId, coordinates]) => ({
          type: 'Feature',
          properties: { line: lineId, mode: vehicleTypeForLine(lineId) },
          geometry: { type: 'MultiLineString', coordinates },
        })),
      };
    }
    return this.geoJsonMemo;
  }
}

module.exports = {
  RouteSequences,
};
