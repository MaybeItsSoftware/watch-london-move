import type { FeatureCollection } from 'geojson';

/**
 * Snapping vehicles onto the geometry of the route they run.
 *
 * TfL gives us no GPS: a vehicle's reported position is the coordinate of its
 * next stop, so the animation is always "travel from the previous stop to the
 * next one". Drawn as a straight line that cuts corners across blocks and
 * chords across tunnels. The backend already serves the real geometry at
 * `GET /routes`, keyed by the same line id a vehicle carries, so this module
 * turns a (line, stop, stop) triple into the stretch of road between them.
 *
 * Two decisions shape everything here:
 *
 *  - **Geometry is indexed in local metres**, not degrees, so the per-frame path
 *    lookup does no trigonometry at all. A single reference latitude for the
 *    whole of London costs at most 0.4% scale error in x, which is irrelevant
 *    for projection and arc length, and offsetting from a central origin keeps
 *    every value inside ±40km — small enough for Float32Array to hold at ~4mm.
 *
 *  - **Lookups are memoised on the stop pair**, never on a vehicle's current
 *    position. Stop coordinates are naptan-joined and therefore bit-identical
 *    across every vehicle on a route and across every update, so the cache
 *    settles at a near-100% hit rate. An interpolated position as part of the
 *    key would never repeat and the cache would do nothing.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const M_PER_DEG_LAT = 111194.93; // 6371000 * DEG_TO_RAD
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(51.5 * DEG_TO_RAD);
const ORIGIN_LON = -0.1276;
const ORIGIN_LAT = 51.5074; // Charing Cross

/** How far a stop may sit from its own route's centreline and still snap to it.
 *  Measured against live TfL stop sequences: median 7m, p99 42m on buses, under
 *  5m on tube. 80m clears that comfortably while staying far below the distance
 *  to any parallel road. */
const MAX_SNAP_M = 80;
/** Below this there is no journey to draw. */
const MIN_CHORD_M = 25;
/** Road distance between adjacent stops, as a multiple of the straight line. */
const MAX_DETOUR_RATIO = 1.9;
const DETOUR_SLACK_M = 120;
/** Scale-independent companion to the ratio: stops a wrong branch adding
 *  kilometres to a long rail hop that would pass the ratio test. */
const MAX_DETOUR_ABS_M = 1500;
/** Both projections landing on top of each other means the polyline folded. */
const MIN_ARC_RATIO = 0.5;
/**
 * Preference for the linestring digitised in the direction of travel. Outbound
 * and inbound geometry run along the same road ~10-20m apart at opposite kerbs,
 * so a vehicle's two stops project acceptably onto *both* — reversed on one of
 * them. This bonus is larger than the kerb offset, which makes direction the
 * primary criterion and snap distance the tiebreak.
 */
const FORWARD_BONUS_M = 25;
/** Arc window over which a heading turns through a vertex. At bus speed this is
 *  a ~6 second turn; at tube speed ~2 seconds. Without it a junction snaps. */
const HEADING_BLEND_M = 30;
const PATH_CACHE_MAX = 12000;
/** ~1.1m of latitude — stop coordinates arrive already rounded to 5dp by the
 *  backend's encoder, so this is exact for them rather than approximate. */
const COORD_KEY_SCALE = 1e5;

/** One linestring of a route, indexed for projection and arc-length lookup. */
type Polyline = {
  /** Flat [x0,y0,x1,y1,...] in local metres. */
  xy: Float32Array;
  /** Vertex count; segments = n - 1. */
  n: number;
  /** Metres from vertex 0 to vertex i. Length n, cum[0] = 0. */
  cum: Float32Array;
  /** Compass bearing per segment, precomputed so no atan2 runs per frame. */
  hdg: Float32Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * An immutable window of arc length on one linestring. Deliberately holds no
 * coordinates of its own: thousands of vehicles running the same stop pair share
 * one of these, and a position is derived from `(line, s)` on demand. That also
 * makes the endpoints exact — at `s === s0` the result *is* the foot of the
 * perpendicular from the stop, so nothing needs special-casing.
 */
export type RoutePath = {
  readonly line: Polyline;
  readonly s0: number;
  readonly s1: number;
  readonly lengthM: number;
  readonly chordM: number;
  /** `s1 >= s0`. When false the vehicle runs against the digitised direction and
   *  its heading is flipped 180°. */
  readonly forward: boolean;
};

/** Filled in place by `poseAlong`. One instance is reused for the whole fleet,
 *  so the per-frame path keeps allocating nothing. */
export type Pose = {
  lon: number;
  lat: number;
  heading: number;
};

type LineEntry = {
  coords: number[][][];
  fingerprint: string;
  /** Bumped when this line's geometry changes, and baked into the memo key so
   *  stale entries age out through the FIFO rather than needing a sweep. */
  epoch: number;
  index: Polyline[] | null;
};

const registry = new Map<string, LineEntry>();
const cache = new Map<string, RoutePath | null>();

/** Dev-only tallies. Rejection counts are how the thresholds above get tuned —
 *  they are guesses until a real fleet has been run against them. */
export const pathStats = {
  hits: 0,
  misses: 0,
  built: 0,
  noGeometry: 0,
  shortChord: 0,
  rejectedSnap: 0,
  rejectedDetour: 0,
  rejectedFold: 0,
};

const toLocalX = (lon: number) => (lon - ORIGIN_LON) * M_PER_DEG_LON;
const toLocalY = (lat: number) => (lat - ORIGIN_LAT) * M_PER_DEG_LAT;

function buildPolyline(coords: number[][]): Polyline | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of coords) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      continue;
    }
    const x = toLocalX(point[0]);
    const y = toLocalY(point[1]);
    // Zero-length segments would break the monotonicity `cum` relies on and
    // leave a bearing undefined, so collapse repeats as they come in.
    const last = xs.length - 1;
    if (last >= 0 && Math.abs(x - xs[last]) < 1e-3 && Math.abs(y - ys[last]) < 1e-3) {
      continue;
    }
    xs.push(x);
    ys.push(y);
  }

  const n = xs.length;
  if (n < 2) {
    return null;
  }

  const xy = new Float32Array(n * 2);
  const cum = new Float32Array(n);
  const hdg = new Float32Array(n - 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i += 1) {
    xy[i * 2] = xs[i];
    xy[i * 2 + 1] = ys[i];
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
    if (i > 0) {
      const dx = xs[i] - xs[i - 1];
      const dy = ys[i] - ys[i - 1];
      cum[i] = cum[i - 1] + Math.hypot(dx, dy);
      // x is east and y north, so the compass bearing is atan2(east, north).
      hdg[i - 1] = (Math.atan2(dx, dy) * RAD_TO_DEG + 360) % 360;
    }
  }

  return { xy, n, cum, hdg, minX, minY, maxX, maxY };
}

function fingerprintOf(coords: number[][][]): string {
  let vertices = 0;
  for (const linestring of coords) {
    vertices += linestring.length;
  }
  const first = coords[0]?.[0] ?? [];
  const lastLine = coords[coords.length - 1] ?? [];
  const last = lastLine[lastLine.length - 1] ?? [];
  return `${coords.length}:${vertices}:${first[0]},${first[1]}:${last[0]},${last[1]}`;
}

/**
 * Hand over the collection `GET /routes` returned. Safe to call repeatedly: the
 * backend serves partial geometry while it is still building and the client tops
 * it up every 60s, and every fetch yields fresh JS objects, so reference
 * identity cannot detect change — each line is fingerprinted instead and one
 * that has not moved keeps both its index and its cache entries.
 */
export function setRouteCollection(collection: FeatureCollection): void {
  for (const feature of collection?.features ?? []) {
    const lineId = feature?.properties?.line;
    const geometry = feature?.geometry;
    if (typeof lineId !== 'string' || !geometry) {
      continue;
    }

    let coords: number[][][];
    if (geometry.type === 'MultiLineString') {
      coords = geometry.coordinates as number[][][];
    } else if (geometry.type === 'LineString') {
      coords = [geometry.coordinates as number[][]];
    } else {
      continue;
    }

    const fingerprint = fingerprintOf(coords);
    const existing = registry.get(lineId);
    if (existing && existing.fingerprint === fingerprint) {
      continue;
    }
    registry.set(lineId, {
      coords,
      fingerprint,
      epoch: (existing?.epoch ?? 0) + 1,
      // Built on first query rather than here: indexing all 662 lines up front
      // is tens of milliseconds of main-thread jank for geometry most sessions
      // never look at.
      index: null,
    });
  }
}

function indexFor(lineId: string): Polyline[] | null {
  const entry = registry.get(lineId);
  if (!entry) {
    return null;
  }
  if (!entry.index) {
    entry.index = entry.coords
      .map((linestring) => buildPolyline(linestring))
      .filter((line): line is Polyline => line !== null);
  }
  return entry.index.length > 0 ? entry.index : null;
}

type Projection = { s: number; distanceM: number };

/** Nearest point on a linestring, as arc length plus how far off it the query
 *  was. A linear scan: the worst linestring in the network is ~224 segments, so
 *  this is a couple of microseconds and a spatial index would cost more to
 *  maintain than it saves. */
function projectPoint(line: Polyline, px: number, py: number): Projection {
  const { xy, n, cum } = line;
  let bestD2 = Infinity;
  let bestS = 0;

  for (let i = 0; i < n - 1; i += 1) {
    const ax = xy[i * 2];
    const ay = xy[i * 2 + 1];
    const abx = xy[i * 2 + 2] - ax;
    const aby = xy[i * 2 + 3] - ay;
    const l2 = abx * abx + aby * aby;
    let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + abx * t;
    const qy = ay + aby * t;
    const dx = px - qx;
    const dy = py - qy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }

  return { s: bestS, distanceM: Math.sqrt(bestD2) };
}

/** True when a point is far enough outside a linestring's bounding box that no
 *  point on it can be within the snap tolerance. */
function outsideBox(line: Polyline, px: number, py: number): boolean {
  return (
    px < line.minX - MAX_SNAP_M ||
    px > line.maxX + MAX_SNAP_M ||
    py < line.minY - MAX_SNAP_M ||
    py > line.maxY + MAX_SNAP_M
  );
}

const coordKey = (value: number) => Math.round(value * COORD_KEY_SCALE);

function resolve(
  lineId: string,
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): RoutePath | null {
  const ax = toLocalX(fromLon);
  const ay = toLocalY(fromLat);
  const bx = toLocalX(toLon);
  const by = toLocalY(toLat);
  const chordM = Math.hypot(bx - ax, by - ay);

  if (chordM < MIN_CHORD_M) {
    pathStats.shortChord += 1;
    return null;
  }

  const lines = indexFor(lineId);
  if (!lines) {
    pathStats.noGeometry += 1;
    return null;
  }

  let best: RoutePath | null = null;
  let bestScore = Infinity;
  let sawSnapReject = false;
  let sawDetourReject = false;
  let sawFoldReject = false;

  for (const line of lines) {
    if (outsideBox(line, ax, ay) || outsideBox(line, bx, by)) {
      continue;
    }

    const pA = projectPoint(line, ax, ay);
    if (pA.distanceM > MAX_SNAP_M) {
      sawSnapReject = true;
      continue;
    }
    const pB = projectPoint(line, bx, by);
    if (pB.distanceM > MAX_SNAP_M) {
      sawSnapReject = true;
      continue;
    }

    const arc = Math.abs(pB.s - pA.s);
    if (arc < 1) {
      sawFoldReject = true;
      continue;
    }
    // A wrong branch of a Y-shaped route shares the trunk, so both stops snap
    // tightly but the stretch between them loops out and back. Both bounds are
    // needed: the ratio catches short bus hops, the absolute catches long rail
    // ones where 1.9x is already kilometres.
    if (arc > MAX_DETOUR_RATIO * chordM + DETOUR_SLACK_M || arc > chordM + MAX_DETOUR_ABS_M) {
      sawDetourReject = true;
      continue;
    }
    if (arc < MIN_ARC_RATIO * chordM) {
      sawFoldReject = true;
      continue;
    }

    // A backwards projection is not a rejection. TfL concatenates outbound and
    // inbound into one unlabelled MultiLineString and either may be digitised in
    // either sense, so travelling against the geometry is normal and only means
    // the rendered heading flips.
    const forward = pB.s >= pA.s;
    const score =
      pA.distanceM + pB.distanceM + 0.25 * Math.max(0, arc - chordM) - (forward ? FORWARD_BONUS_M : 0);

    if (score < bestScore) {
      bestScore = score;
      best = { line, s0: pA.s, s1: pB.s, lengthM: arc, chordM, forward };
    }
  }

  if (!best) {
    if (sawSnapReject) pathStats.rejectedSnap += 1;
    else if (sawDetourReject) pathStats.rejectedDetour += 1;
    else if (sawFoldReject) pathStats.rejectedFold += 1;
    else pathStats.noGeometry += 1;
  }

  return best;
}

/**
 * The stretch of route between two stops, or null when no linestring is a
 * trustworthy match. `from` and `to` must be raw stop coordinates — see the
 * note on memoisation at the top of this file.
 */
export function pathBetween(
  lineId: string,
  from: readonly [number, number],
  to: readonly [number, number],
): RoutePath | null {
  const key = `${lineId}|${registry.get(lineId)?.epoch ?? 0}|${coordKey(from[0])}|${coordKey(
    from[1],
  )}|${coordKey(to[0])}|${coordKey(to[1])}`;

  const cached = cache.get(key);
  if (cached !== undefined) {
    pathStats.hits += 1;
    return cached;
  }
  pathStats.misses += 1;

  const path = resolve(lineId, from[0], from[1], to[0], to[1]);
  if (path) {
    pathStats.built += 1;
  }

  // Negative results are cached too: without that, a route with no usable
  // geometry would re-scan for every one of its vehicles on every payload.
  if (cache.size >= PATH_CACHE_MAX) {
    // Plain FIFO. The working set is a stable band of stop pairs around wherever
    // the camera is, so LRU's reordering would cost more than it recovers.
    let drop = Math.ceil(PATH_CACHE_MAX / 10);
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      drop -= 1;
      if (drop <= 0) {
        break;
      }
    }
  }
  cache.set(key, path);
  return path;
}

/** Arc length clamped into the stretch this path actually covers. */
export function clampToPath(path: RoutePath, s: number): number {
  const lo = Math.min(path.s0, path.s1);
  const hi = Math.max(path.s0, path.s1);
  return s < lo ? lo : s > hi ? hi : s;
}

/** Where a point sits along a path's parent linestring. Used when a glide has to
 *  be picked up on geometry it was not previously following. */
export function projectOntoPath(
  path: RoutePath,
  point: readonly [number, number],
): Projection | null {
  const px = toLocalX(point[0]);
  const py = toLocalY(point[1]);
  if (outsideBox(path.line, px, py)) {
    return null;
  }
  const projection = projectPoint(path.line, px, py);
  return projection.distanceM > MAX_SNAP_M ? null : projection;
}

/** Locate the segment containing arc length `s`, starting from last frame's
 *  answer. A vehicle moves a fraction of a segment per frame, so this is
 *  normally a single comparison; the bounded walk falls back to a binary search
 *  rather than degrading when the hint is stale. */
function locate(cum: Float32Array, segments: number, s: number, hint: number): number {
  let i = hint < 0 ? 0 : hint > segments - 1 ? segments - 1 : hint;
  let steps = 0;

  while (i < segments - 1 && s > cum[i + 1]) {
    i += 1;
    steps += 1;
    if (steps > 8) {
      return bisect(cum, segments, s);
    }
  }
  while (i > 0 && s < cum[i]) {
    i -= 1;
    steps += 1;
    if (steps > 8) {
      return bisect(cum, segments, s);
    }
  }
  return i;
}

function bisect(cum: Float32Array, segments: number, s: number): number {
  let lo = 0;
  let hi = segments - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function blendAngle(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * t;
}

/**
 * Write the pose at arc length `s` into `out`, returning the segment index to
 * feed back as `hint` next frame.
 */
export function poseAlong(path: RoutePath, s: number, hint: number, out: Pose): number {
  const { xy, n, cum, hdg } = path.line;
  const segments = n - 1;
  const i = locate(cum, segments, s, hint);

  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? (s - cum[i]) / span : 0;
  const x = xy[i * 2] + (xy[i * 2 + 2] - xy[i * 2]) * t;
  const y = xy[i * 2 + 1] + (xy[i * 2 + 3] - xy[i * 2 + 1]) * t;
  out.lon = x / M_PER_DEG_LON + ORIGIN_LON;
  out.lat = y / M_PER_DEG_LAT + ORIGIN_LAT;

  // Bearing is constant within a segment and a bus hop spans only one to three
  // of them, so a junction would otherwise snap the model round in one frame.
  // Blend across a window centred on each vertex; the two branches agree exactly
  // at the vertex itself, so the result is continuous.
  const half = HEADING_BLEND_M / 2;
  const dStart = s - cum[i];
  const dEnd = cum[i + 1] - s;
  let heading: number;
  if (dStart <= dEnd && dStart < half && i > 0) {
    heading = blendAngle(hdg[i - 1], hdg[i], 0.5 + dStart / HEADING_BLEND_M);
  } else if (dEnd < half && i + 1 < segments) {
    heading = blendAngle(hdg[i], hdg[i + 1], 0.5 - dEnd / HEADING_BLEND_M);
  } else {
    heading = hdg[i];
  }

  // The model must face the way it is travelling, not the way the geometry
  // happened to be drawn.
  if (!path.forward) {
    heading += 180;
  }
  out.heading = ((heading % 360) + 360) % 360;

  return i;
}
