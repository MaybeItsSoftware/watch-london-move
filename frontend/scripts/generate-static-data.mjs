/**
 * Bakes the two effectively-static datasets into the build so a cold start does
 * not pay for them.
 *
 *   npm run static-data                             # against http://localhost:4010
 *   STATIC_DATA_BACKEND_URL=https://… npm run static-data
 *
 * Writes, all three committed to the repo so CI and a fresh clone build without
 * a live backend:
 *
 *   public/data/routes.json      the /routes FeatureCollection, coordinates 5dp
 *   public/data/stops.json       every stop in the network, coordinates 5dp
 *   src/static-data-manifest.json
 *
 * Measured against the live network (662 lines, 121,405 vertices, 33,118 stops):
 * routes 2.69MB -> 2.06MB and stops 2.48MB -> 1.85MB, purely from the rounding
 * below. Both land in dist/data/, which is what `cap sync` copies into the app
 * binary, so on native this is downloaded exactly never.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendUrl = (
  process.env.STATIC_DATA_BACKEND_URL ||
  process.env.VITE_BACKEND_URL ||
  'http://localhost:4010'
).replace(/\/$/, '');

/**
 * 5 decimal places, ~1.1m — the same precision the backend's wire encoder
 * already rounds vehicle positions to (COORD_PRECISION in backend/src/schema.js).
 * Route geometry arrives Douglas-Peucker simplified at 0.00008 deg (~9m) and
 * stop coordinates are building-entrance points, so this is lossless against
 * anything either dataset actually claims to know; the digits it removes are
 * TfL's float64 noise. Worth 23% of both files.
 */
const COORD_PRECISION = 1e5;
const roundCoord = (value) => Math.round(value * COORD_PRECISION) / COORD_PRECISION;

/**
 * `getStopsInBounds` answers a box holding more than 400 stops with an empty
 * array and `truncated: true` — deliberately, so a client can tell "nothing
 * here" from "too many to draw". Shipping a silently short stop set is the
 * failure mode this whole function exists to avoid, so a truncated box is never
 * accepted: it is quartered and re-asked until every leaf answers untruncated.
 *
 * The alternative was reading backend/.cache/stop-points.json directly. Rejected:
 * that file is backend-internal (its name comes from config, its entries are a
 * Map dump rather than the object shape you would guess, and it is TTL-gated),
 * and it only exists on a machine that has run the backend — this script has to
 * work against a deployed one too. Completeness is asserted below against
 * /health instead, which is a stronger guarantee than trusting either source.
 */
const STOPS_ROOT_BBOX = { west: -2, south: 50, east: 2, north: 53.5 };
/**
 * TfL's stop index carries a handful of stops with no surveyed entrance,
 * reported as 0,0 — 36 of 33,118 when this was written, all bus stops. They fall
 * outside the root box above (Null Island is in the Gulf of Guinea) and would
 * render there if they did not, so they are deliberately never harvested. They
 * are still *counted*, because that is what lets the completeness assertion stay
 * an equality: a fuzzy tolerance would hide a real gap of the same size.
 */
const STOPS_NULL_ISLAND_BBOX = { west: -1e-4, south: -1e-4, east: 1e-4, north: 1e-4 };
/** A box this small holding >400 stops would mean 400 of them within ~10m of
 *  each other; hitting it means something is wrong, not that we should recurse
 *  further. */
const STOPS_MIN_CELL_DEG = 1e-4;
const STOPS_CONCURRENCY = 8;

async function fetchJson(path, init) {
  const response = await fetch(`${backendUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`GET ${path} -> HTTP ${response.status}`);
  }
  return { body: await response.json(), headers: response.headers };
}

async function harvestStops() {
  const byId = new Map();
  let requests = 0;
  let queue = [STOPS_ROOT_BBOX];

  while (queue.length > 0) {
    const next = [];
    for (let i = 0; i < queue.length; i += STOPS_CONCURRENCY) {
      const batch = queue.slice(i, i + STOPS_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (box) => {
          requests += 1;
          const { body } = await fetchJson(
            `/stops?bbox=${box.west},${box.south},${box.east},${box.north}`,
          );
          return { box, body };
        }),
      );

      for (const { box, body } of results) {
        if (!body.truncated) {
          // Boxes are inclusive on every edge, so a stop on a split line comes
          // back from both children — keyed by id, which makes that a no-op.
          for (const stop of body.stops) {
            byId.set(stop.id, stop);
          }
          continue;
        }
        const midLon = (box.west + box.east) / 2;
        const midLat = (box.south + box.north) / 2;
        if (box.east - box.west < STOPS_MIN_CELL_DEG) {
          throw new Error(
            `/stops still truncated at ${box.west},${box.south},${box.east},${box.north}`,
          );
        }
        next.push(
          { west: box.west, south: box.south, east: midLon, north: midLat },
          { west: midLon, south: box.south, east: box.east, north: midLat },
          { west: box.west, south: midLat, east: midLon, north: box.north },
          { west: midLon, south: midLat, east: box.east, north: box.north },
        );
      }
    }
    queue = next;
  }

  return { stops: [...byId.values()], requests };
}

function quantizeRoutes(collection) {
  let vertices = 0;
  for (const feature of collection.features ?? []) {
    const geometry = feature.geometry;
    const linestrings =
      geometry?.type === 'MultiLineString'
        ? geometry.coordinates
        : geometry?.type === 'LineString'
          ? [geometry.coordinates]
          : [];
    for (const linestring of linestrings) {
      vertices += linestring.length;
      for (const point of linestring) {
        point[0] = roundCoord(point[0]);
        point[1] = roundCoord(point[1]);
      }
    }
  }
  return vertices;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)}MB`;
const shrink = (from, to) =>
  `${mb(from)} -> ${mb(to)} (-${(((from - to) / from) * 100).toFixed(1)}%)`;

async function main() {
  console.log(`Backend: ${backendUrl}`);

  // Read first, and fail on a backend that is still assembling: a partial route
  // set frozen into a release is invisible until someone notices a whole mode
  // missing from the map.
  const { body: health } = await fetchJson('/health');
  const expectedStops = health?.metrics?.stopPoints ?? 0;
  if (!health?.routeLoadComplete) {
    throw new Error(
      `backend route geometry is incomplete (${health?.routeLinesLoaded ?? 0} lines); ` +
        'wait for it to finish building and re-run',
    );
  }

  const routesResponse = await fetch(`${backendUrl}/routes`);
  if (!routesResponse.ok) {
    throw new Error(`GET /routes -> HTTP ${routesResponse.status}`);
  }
  if (routesResponse.headers.get('X-Routes-Complete') !== 'true') {
    throw new Error('GET /routes reported X-Routes-Complete: false');
  }
  const rawRoutes = await routesResponse.text();
  const routes = JSON.parse(rawRoutes);
  const vertices = quantizeRoutes(routes);
  const routesJson = JSON.stringify(routes);
  console.log(
    `routes: ${routes.features.length} lines, ${vertices} vertices, ` +
      shrink(Buffer.byteLength(rawRoutes), Buffer.byteLength(routesJson)),
  );

  const { stops, requests } = await harvestStops();
  // Sorted so a regeneration that found the same stops writes a byte-identical
  // file: /stops walks a Map in the order TfL happened to answer 28 line
  // requests in, which does not survive a backend restart, and without this
  // every run would land in review as a 1.8MB diff.
  stops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const normalize = (round) => ({
    stops: stops.map((stop) => ({
      id: stop.id,
      lat: round ? roundCoord(stop.lat) : stop.lat,
      lon: round ? roundCoord(stop.lon) : stop.lon,
      name: stop.name,
    })),
  });
  const rawStopsBytes = Buffer.byteLength(JSON.stringify(normalize(false)));
  const stopsJson = JSON.stringify(normalize(true));
  console.log(
    `stops: ${stops.length} stops from ${requests} bbox requests, ` +
      shrink(rawStopsBytes, Buffer.byteLength(stopsJson)),
  );

  const { body: nullIsland } = await fetchJson(
    `/stops?bbox=${STOPS_NULL_ISLAND_BBOX.west},${STOPS_NULL_ISLAND_BBOX.south},` +
      `${STOPS_NULL_ISLAND_BBOX.east},${STOPS_NULL_ISLAND_BBOX.north}`,
  );
  const uncoordinated = nullIsland.truncated ? -1 : nullIsland.stops.length;
  if (expectedStops > 0 && stops.length + uncoordinated !== expectedStops) {
    throw new Error(
      `harvested ${stops.length} stops (+${uncoordinated} uncoordinated) but the backend's ` +
        `index holds ${expectedStops}; the root bbox does not cover the whole network`,
    );
  }
  if (uncoordinated > 0) {
    console.log(`stops: skipped ${uncoordinated} with no surveyed coordinates`);
  }

  // The manifest's builtAt is the *backend's* route build time where the backend
  // can report one, not this script's clock: the client compares it against
  // GET /routes/version to decide whether a top-up is worth 2MB, and generation
  // time would make a build look newer than the data it actually contains.
  let builtAt = Date.now();
  try {
    const { body: version } = await fetchJson('/routes/version', { cache: 'no-store' });
    if (Number.isFinite(version?.builtAt)) {
      builtAt = version.builtAt;
    }
  } catch {
    console.log('note: /routes/version unavailable, stamping the manifest with the clock');
  }

  await mkdir(join(root, 'public', 'data'), { recursive: true });
  await writeFile(join(root, 'public', 'data', 'routes.json'), routesJson);
  await writeFile(join(root, 'public', 'data', 'stops.json'), stopsJson);
  await writeFile(
    join(root, 'src', 'static-data-manifest.json'),
    `${JSON.stringify(
      {
        builtAt,
        routes: {
          path: 'data/routes.json',
          bytes: Buffer.byteLength(routesJson),
          lines: routes.features.length,
        },
        stops: {
          path: 'data/stops.json',
          bytes: Buffer.byteLength(stopsJson),
          count: stops.length,
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log(`manifest builtAt ${new Date(builtAt).toISOString()}`);
}

main().catch((error) => {
  console.error(`generate-static-data failed: ${error.message}`);
  process.exit(1);
});
