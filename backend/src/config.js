const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

function parseCsv(raw) {
  return (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const trainLines = parseCsv(
  process.env.TFL_TRAIN_LINES ||
    'bakerloo,central,circle,district,elizabeth,hammersmith-city,jubilee,metropolitan,northern,piccadilly,victoria,waterloo-city,lioness,mildmay,windrush,weaver,suffragette,liberty,dlr,tram',
);

const tflAppKey = process.env.TFL_APP_KEY || '';

// Every London bus route by default. Per-line polling would need ~130 requests a
// cycle for that, far past even the keyed rate limit, so the whole-network
// endpoints (/Mode/bus/Arrivals, /StopPoint/Mode/bus) are used instead — one
// arrivals request covers all ~640 routes. Set TFL_BUS_LINES to a comma list to
// poll a named subset per line instead.
const busLines = parseCsv(process.env.TFL_BUS_LINES);
const allBusLines = busLines.length === 0;

// The native apps are Capacitor WebViews, whose origin is fixed by the platform
// rather than by anything we deploy: capacitor://localhost on iOS and
// https://localhost on Android (both set in frontend/capacitor.config.ts).
//
// Always allowed rather than left to CORS_ORIGIN. They are constants of the
// platform, not deployment config, so making them opt-in means every new
// environment — and every stale local .env — silently locks the apps out with
// no signal beyond a client that never connects. Nothing is given away: CORS
// protects browsers, and no web page can forge these origins.
const NATIVE_ORIGINS = ['capacitor://localhost', 'https://localhost'];

const corsOrigins = [
  ...new Set([...parseCsv(process.env.CORS_ORIGIN || 'http://localhost:5173'), ...NATIVE_ORIGINS]),
];

// Clamped rather than trusted: this is a per-vehicle multiplier on the payload,
// so a stray "50" in an environment file would quietly multiply egress for every
// connected client. A blank or unparseable value falls back to the default the
// same way the numeric settings below do.
const requestedScheduleStops = Number(process.env.SCHEDULE_STOPS || 3);
const scheduleStops = Number.isFinite(requestedScheduleStops)
  ? Math.min(5, Math.max(1, Math.round(requestedScheduleStops)))
  : 3;

module.exports = {
  port: Number(process.env.PORT || 4010),
  corsOrigins,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  // Costs no TfL traffic — deltas carry only the vehicles that changed, and the
  // change rate is set by the poll cadence, so this splits the same changes
  // across more messages rather than sending more of them. Halves how long a
  // revised arrival sits in the emit queue.
  emitIntervalMs: Number(process.env.EMIT_INTERVAL_MS || 5000),
  // The whole-network bus feed is ~8MB gzipped, so it refreshes on its own
  // slower cadence (every other poll) rather than every cycle.
  busCacheWindowMs: Number(process.env.BUS_CACHE_WINDOW_MS || (allBusLines ? 25000 : 10000)),
  trainCacheWindowMs: Number(process.env.TRAIN_CACHE_WINDOW_MS || 10000),
  // The whole-network feed takes ~10s to transfer, well past the default timeout.
  busFeedTimeoutMs: Number(process.env.BUS_FEED_TIMEOUT_MS || 60000),
  // TfL accepts comma-separated line ids on /Line/{ids}/Arrivals, but 404s the
  // whole request if any one id is bad — so batch in small groups to keep both
  // the request count and the blast radius of a bad id low.
  linesPerRequest: Math.max(1, Number(process.env.TFL_LINES_PER_REQUEST || 5)),
  // Stop coordinates are effectively static, so the index is built once and reused.
  stopPointCacheMs: Number(process.env.STOP_POINT_CACHE_MS || 24 * 60 * 60 * 1000),
  // /StopPoint/Mode/bus is paginated at 1000 stops a page — ~33 pages for London,
  // fetched one at a time so the one-off build never bursts past the rate limit.
  stopPointPageSize: Number(process.env.STOP_POINT_PAGE_SIZE || 1000),
  stopPointPagePaceMs: Number(process.env.STOP_POINT_PAGE_PACE_MS || (tflAppKey ? 250 : 1400)),
  stopPointCachePath: process.env.STOP_POINT_CACHE_PATH || path.join(__dirname, '..', '.cache', 'stop-points.json'),
  // A partially built index retries on this shorter window rather than the full TTL.
  stopPointRetryMs: Number(process.env.STOP_POINT_RETRY_MS || 5 * 60 * 1000),
  retryCount: Number(process.env.RETRY_COUNT || 3),
  retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 1000),
  maxRetryWaitMs: Number(process.env.MAX_RETRY_WAIT_MS || 10000),
  // A vehicle that stops appearing in arrivals has reached its destination (or the
  // feed lost it) — without pruning it sits frozen on the map forever.
  staleVehicleMs: Number(process.env.STALE_VEHICLE_MS || 90000),
  // Deltas can silently diverge on a dropped packet; a periodic full snapshot
  // resynchronises every client without them having to ask. This is a count of
  // emit ticks, not a duration, so it tracks emitIntervalMs: both were halved
  // and doubled together to keep a full snapshot landing about once a minute.
  // Fulls are by far the expensive message.
  fullEmitEveryN: Math.max(1, Number(process.env.FULL_EMIT_EVERY_N || 12)),
  // How far a vehicle's predicted arrival must move before it earns a delta of
  // its own. Position alone does not cover it: a vehicle glides to its next stop
  // and then has nothing to do until that stop changes, while TfL is quietly
  // revising when it gets there. 0 disables the trigger entirely.
  arrivalRevisionMs: Number(process.env.ARRIVAL_REVISION_MS || 15000),
  // How many upcoming stops each vehicle carries, counting the one it is heading
  // for now. TfL already sends ~8 predictions per vehicle and we were discarding
  // seven of them, so the extra stops cost no requests and no parsing — only
  // three numbers each on the wire. Their point is the gap between polls: a
  // client given one stop finishes its glide and freezes there for the rest of
  // the cycle, while one given the next few keeps a queue of legs to run.
  // Clamped to 1..5 above. 1 restores the single-stop behaviour exactly; past
  // ~5 the predictions are far enough out that TfL revises them faster than a
  // client can reach them, so the bytes buy nothing.
  scheduleStops,
  routeSequenceCachePath:
    process.env.ROUTE_SEQUENCE_CACHE_PATH || path.join(__dirname, '..', '.cache', 'route-sequences.json'),
  routeSequenceCacheMs: Number(process.env.ROUTE_SEQUENCE_CACHE_MS || 7 * 24 * 60 * 60 * 1000),
  routeSequenceRetryMs: Number(process.env.ROUTE_SEQUENCE_RETRY_MS || 10 * 60 * 1000),
  // Route sequence loading shares the rate limit budget with arrivals polling, so
  // it paces itself much harder when running keyless. Each group costs
  // linesPerRequest x 2 requests (one per direction), so keyless pacing keeps
  // that under the ~50/min ceiling alongside polling.
  routeFetchPaceMs: Number(process.env.ROUTE_FETCH_PACE_MS || (tflAppKey ? 1500 : 14000)),
  // Every bus route's geometry is ~640 lines x 2 directions, so the build is
  // checkpointed to disk this often and resumes there after a restart.
  routeCheckpointEvery: Math.max(1, Number(process.env.ROUTE_CHECKPOINT_EVERY || 5)),
  routeSimplifyToleranceDeg: Number(process.env.ROUTE_SIMPLIFY_TOLERANCE_DEG || 0.00008),
  // The whole-network bus feed's request, its ~80MB JSON.parse and the reduce
  // over ~120,000 rows all run on a worker thread, so a poll no longer stalls
  // every connected client for the duration. Set to `false` to run it in
  // process — the code path is identical, it just blocks the event loop. See
  // bus-feed-worker.js.
  busFeedWorker: process.env.BUS_FEED_WORKER !== 'false',
  // socket.io leaves permessage-deflate off by default. These payloads are
  // repetitive JSON with clustered coordinates and compress about 6-8x, which
  // on a workload that is almost entirely egress is worth the CPU.
  compression: process.env.WS_COMPRESSION !== 'false',
  // Below this a message costs more in deflate framing than it saves.
  compressionThresholdBytes: Number(process.env.WS_COMPRESSION_THRESHOLD || 512),
  // Separate from the socket setting above: perMessageDeflate never touches the
  // HTTP routes, and Fly's proxy does not compress application responses, so
  // without this /stops and /snapshot go out as raw JSON. /routes does not rely
  // on it — it serves precompressed buffers of its own.
  httpCompression: process.env.HTTP_COMPRESSION !== 'false',
  // Higher than the socket threshold because an HTTP response pays the encoding
  // headers and a decompressor setup once for the whole body rather than
  // amortising them over a stream of frames.
  httpCompressionThresholdBytes: Number(process.env.HTTP_COMPRESSION_THRESHOLD || 1024),
  // Grid cell for viewport subscriptions. 0.05 deg is ~5.5km across London,
  // so a phone-sized viewport lands on a handful of cells while the ~150 cells
  // covering the network stay few enough to serialise per emit tick.
  tileSizeDeg: Number(process.env.TILE_SIZE_DEG || 0.05),
  // A viewport needing more cells than this is treated as "send everything"
  // rather than being clipped, which would leave holes in the map.
  maxViewportTiles: Math.max(1, Number(process.env.MAX_VIEWPORT_TILES || 240)),
  // How long a new socket is given to declare a viewport before it is assumed
  // to want the whole network. Long enough for a client to finish setting up
  // its map, short enough not to look like a stall.
  viewportGraceMs: Number(process.env.VIEWPORT_GRACE_MS || 3000),
  // Details are per-selection, so a request for hundreds of ids is a client
  // trying to rebuild the old firehose one round trip at a time.
  maxDetailIds: Math.max(1, Number(process.env.MAX_DETAIL_IDS || 50)),
  trainLines,
  busLines,
  allBusLines,
  tflApiBaseUrl: process.env.TFL_API_BASE_URL || 'https://api.tfl.gov.uk',
  tflAppId: process.env.TFL_APP_ID || '',
  tflAppKey,
};
