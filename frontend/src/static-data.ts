import type { FeatureCollection } from 'geojson';
import { BACKEND_URL } from './config';
import manifest from './static-data-manifest.json';
import type { Bounds } from './types';

/**
 * Route geometry and stop markers, resolved from the build instead of the wire.
 *
 * These two datasets were the whole of a cold start's ~5.2MB: the network's
 * route geometry (662 lines, 121,405 vertices, 2.33MB) fetched once, and slices
 * of a 33k-stop index re-fetched on every camera settle above zoom 15. Neither
 * changes more than a few times a year — the backend's own TTL on routes is
 * 7 days — and egress at $0.02/GB is the hosting bill's dominant line. Both now
 * ship in the build: `npm run static-data` writes them into public/data/, so on
 * web they come off the immutable static host and on native they are already
 * inside the app binary, and the backend serves neither.
 *
 * What the backend is still needed for is the gap between releases. A shipped
 * binary is pinned to whatever geometry existed when it was built, so this
 * module asks `GET /routes/version` — a few hundred bytes — in the background
 * and only pulls the 2.3MB collection when the backend reports a *newer* build
 * than the manifest baked into this bundle.
 *
 * The third path is the one that has to keep working: a dev checkout, or any
 * build where the generate script was never run, has no bundled copy and falls
 * back to exactly what this used to do.
 */

/** Give up on a backend that has answered nothing but errors for this long. */
const ROUTES_GIVE_UP_MS = 5 * 60 * 1000;
/** Cadence for topping up geometry the backend is still assembling. */
const ROUTES_REFRESH_MS = 60 * 1000;
const ROUTES_BACKOFF_START_MS = 5000;
const ROUTES_BACKOFF_MAX_MS = 30000;

const hasBundledRoutes = manifest.routes.lines > 0;
const hasBundledStops = manifest.stops.count > 0;

/**
 * `vite.config.ts` sets `base: './'` so one bundle serves both the web and the
 * Capacitor WebView, whose origin is `capacitor://localhost` on iOS and
 * `https://localhost` on Android. That makes BASE_URL a relative `'./'`, which
 * only means anything resolved against the document — a hardcoded `/data/...`
 * would leave the app bundle entirely on native and 404 under any web deploy
 * that is not at a domain root. The version query is the manifest's, imported
 * rather than fetched, so it is baked into the hashed JS chunk: cache busting
 * that is always correct and costs no round trip to establish.
 */
function dataUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}${path}?v=${manifest.builtAt}`, document.baseURI).href;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Route geometry
// ---------------------------------------------------------------------------

type RoutesVersion = {
  builtAt: number;
  complete: boolean;
  lines: number;
};

/**
 * Resolve route geometry, calling `onCollection` every time a better collection
 * is available — the bundled copy first, then anything newer the backend has.
 * Returns a cancel function; nothing is delivered after it is called.
 */
export function startRouteGeometry(onCollection: (collection: FeatureCollection) => void): () => void {
  let cancelled = false;
  let timer: number | undefined;
  let featureCount = 0;
  let giveUpAt = Date.now() + ROUTES_GIVE_UP_MS;
  let backoffMs = ROUTES_BACKOFF_START_MS;

  const later = (run: () => void, delayMs: number) => {
    timer = window.setTimeout(run, delayMs);
  };

  /**
   * A backend that restarted with a cold cache serves a growing partial set for
   * several minutes. Handing a smaller collection to the map than the one
   * already drawn would blank most of the network, which is precisely what a
   * shipped app topping up from a just-deployed backend would otherwise do.
   */
  const adopt = (collection: FeatureCollection): boolean => {
    const count = collection?.features?.length ?? 0;
    if (count === 0 || count < featureCount) {
      return false;
    }
    featureCount = count;
    giveUpAt = Date.now() + ROUTES_GIVE_UP_MS;
    onCollection(collection);
    return true;
  };

  const onFailure = (retry: () => void) => {
    if (cancelled || Date.now() > giveUpAt) {
      return;
    }
    // Something is already on screen, so there is no hurry and no user waiting;
    // only a load with nothing to show backs off exponentially.
    if (featureCount > 0) {
      later(retry, ROUTES_REFRESH_MS);
      return;
    }
    later(retry, backoffMs);
    backoffMs = Math.min(backoffMs * 2, ROUTES_BACKOFF_MAX_MS);
  };

  /** The pre-bundle behaviour, kept whole: 503 while the backend assembles
   *  geometry, a partial set drawn immediately, topped up until it is complete. */
  const fetchFromBackend = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/routes`);
      if (!response.ok) {
        throw new Error(`routes not ready (HTTP ${response.status})`);
      }
      const complete = response.headers.get('X-Routes-Complete') === 'true';
      const collection = (await response.json()) as FeatureCollection;
      if (cancelled) {
        return;
      }
      adopt(collection);
      if (!complete) {
        later(fetchFromBackend, ROUTES_REFRESH_MS);
      }
    } catch {
      onFailure(fetchFromBackend);
    }
  };

  /**
   * The whole point of the version endpoint: two numbers decide whether this
   * session pays 2.3MB. `no-store` because a cached answer would pin a long-
   * lived WebView to the build it first saw.
   */
  const checkForNewerGeometry = async () => {
    try {
      const version = await fetchJson<RoutesVersion>(`${BACKEND_URL}/routes/version`, {
        cache: 'no-store',
      });
      if (cancelled || !(version.builtAt > manifest.builtAt)) {
        return;
      }
      await fetchFromBackend();
    } catch {
      // 503 (still assembling), 404 (a backend without the endpoint yet), or no
      // network. The bundled copy is correct either way, so this retries on the
      // slow cadence and stops caring once giveUpAt passes.
      onFailure(checkForNewerGeometry);
    }
  };

  const start = async () => {
    if (hasBundledRoutes) {
      try {
        const collection = await fetchJson<FeatureCollection>(dataUrl(manifest.routes.path));
        if (cancelled) {
          return;
        }
        if (adopt(collection)) {
          void checkForNewerGeometry();
          return;
        }
      } catch {
        // The manifest says there should be a bundled copy and there is not, so
        // the build is inconsistent — a map with no routes is much worse than
        // the download, so fall through to fetching it.
        if (cancelled) {
          return;
        }
      }
    }
    void fetchFromBackend();
  };

  void start();

  return () => {
    cancelled = true;
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

export type StopRecord = {
  id: string;
  lat: number;
  lon: number;
  name: string;
};

/**
 * ~1.1km of latitude. The stops layer only draws above zoom 15, where a viewport
 * spans a couple of hundredths of a degree, so a query touches a handful of
 * cells holding ~25 stops each — against 33,082 for the linear scan this
 * replaces, which ran on every camera settle.
 */
const STOP_CELL_DEG = 0.01;

type StopIndex = {
  buckets: Map<string, StopRecord[]>;
  all: StopRecord[];
};

let stopIndex: StopIndex | null = null;
let stopIndexLoad: Promise<StopIndex | null> | null = null;

const cellKey = (lat: number, lon: number) =>
  `${Math.floor(lat / STOP_CELL_DEG)}:${Math.floor(lon / STOP_CELL_DEG)}`;

function buildStopIndex(stops: StopRecord[]): StopIndex {
  const buckets = new Map<string, StopRecord[]>();
  for (const stop of stops) {
    const key = cellKey(stop.lat, stop.lon);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(stop);
    } else {
      buckets.set(key, [stop]);
    }
  }
  return { buckets, all: stops };
}

function ensureStopIndex(): Promise<StopIndex | null> {
  if (stopIndex) {
    return Promise.resolve(stopIndex);
  }
  if (!hasBundledStops) {
    return Promise.resolve(null);
  }
  if (!stopIndexLoad) {
    stopIndexLoad = fetchJson<{ stops: StopRecord[] }>(dataUrl(manifest.stops.path))
      .then((payload) => {
        stopIndex = buildStopIndex(payload.stops ?? []);
        return stopIndex;
      })
      .catch(() => {
        // Cleared so a transient failure does not condemn the session to the
        // per-pan HTTP path forever; the next camera settle tries again.
        stopIndexLoad = null;
        return null;
      });
  }
  return stopIndexLoad;
}

function queryStopIndex(index: StopIndex, bounds: Bounds): StopRecord[] {
  const minY = Math.floor(bounds.south / STOP_CELL_DEG);
  const maxY = Math.floor(bounds.north / STOP_CELL_DEG);
  const minX = Math.floor(bounds.west / STOP_CELL_DEG);
  const maxX = Math.floor(bounds.east / STOP_CELL_DEG);
  const cells = (maxY - minY + 1) * (maxX - minX + 1);

  const within = (stop: StopRecord) =>
    stop.lat >= bounds.south &&
    stop.lat <= bounds.north &&
    stop.lon >= bounds.west &&
    stop.lon <= bounds.east;

  // A box wider than the network is cheaper to answer by scanning every stop
  // than by walking its cells: a whole-world bounds would be 600M empty lookups.
  if (cells > index.buckets.size) {
    return index.all.filter(within);
  }

  const found: StopRecord[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const bucket = index.buckets.get(`${y}:${x}`);
      if (!bucket) {
        continue;
      }
      for (const stop of bucket) {
        if (within(stop)) {
          found.push(stop);
        }
      }
    }
  }
  return found;
}

/**
 * Stops inside a box. Answered from the bundled index when there is one — no
 * request at all — and from `GET /stops` otherwise. `null` means the lookup
 * failed and the caller should try again rather than draw an empty map.
 *
 * The bundled path has no equivalent of the backend's 400-stop cap. That cap
 * existed to stop a wide box turning into a huge response body; with the whole
 * index already in memory there is no body, and returning what is actually there
 * is strictly better than the "too many, here is nothing" the client used to get.
 */
export async function loadStops(bounds: Bounds): Promise<StopRecord[] | null> {
  const index = await ensureStopIndex();
  if (index) {
    return queryStopIndex(index, bounds);
  }

  const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].join(',');
  try {
    const payload = await fetchJson<{ stops: StopRecord[] }>(`${BACKEND_URL}/stops?bbox=${bbox}`);
    return payload.stops ?? [];
  } catch {
    return null;
  }
}
