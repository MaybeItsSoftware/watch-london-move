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

const isProduction = process.env.NODE_ENV === 'production';

// Collected rather than logged: config is loaded by the worker thread and by
// the tests, neither of which should be standing up a logger. server.js prints
// them once at boot.
//
// These are all cases where the default is safe for a laptop and wrong for a
// deployment, and where the symptom is silence — a web client that never
// connects, a route build that crawls — rather than an error anyone can trace
// back to a missing variable.
const warnings = [];
// Presence is not the test. Unset is one way to end up allowing only the Vite
// dev server; explicitly setting CORS_ORIGIN to a localhost URL — copied from
// .env.example, which is exactly where a deployment's variables get copied
// from — is the other, and it looks configured. Both fail the same way: the
// deployed web app is refused while the native apps keep working, so there is
// no obvious signal that anything is wrong.
const browserOrigins = corsOrigins.filter((origin) => !NATIVE_ORIGINS.includes(origin));
const isLoopback = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
if (isProduction && browserOrigins.every(isLoopback)) {
  warnings.push(
    browserOrigins.length === 0
      ? 'CORS_ORIGIN allows no browser origins at all: the deployed web app will be refused by CORS. The native apps are unaffected — their origins are always allowed — so this fails silently. Set CORS_ORIGIN to the web origin.'
      : 'CORS_ORIGIN allows only loopback origins (' +
        browserOrigins.join(', ') +
        '), so the deployed web app will be refused by CORS. The native apps are unaffected, so this fails silently. Set CORS_ORIGIN to the real web origin.',
  );
}
if (isProduction && !tflAppKey) {
  warnings.push(
    'TFL_APP_KEY is unset, so TfL applies its anonymous rate limit: route geometry loads about ten times slower and polling is likelier to be throttled.',
  );
}
if (isProduction && !process.env.METRICS_TOKEN) {
  warnings.push(
    'METRICS_TOKEN is unset, so /health reports liveness only. Set it to read bandwidth, cost and poll metrics in production.',
  );
}

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
  // What the poller does when nobody is connected.
  //
  // A cycle costs a ~10s whole-network fetch, an ~80MB JSON.parse and a reduce
  // over ~120,000 rows, and it ran unconditionally — on one deployment, 133
  // polls against zero clients. Nothing was reading any of it. At hobby traffic
  // that is most of the compute bill.
  //
  // Five minutes keeps the fleet roughly warm so a returning visitor sees a
  // populated map immediately. Set to 0 to suspend polling entirely while idle,
  // which is the setting to pair with a platform that sleeps idle containers —
  // a client arriving always forces a refresh anyway (see poll-schedule.js).
  idlePollIntervalMs: Number(process.env.IDLE_POLL_INTERVAL_MS || 300000),
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
  // --- Bus source ---
  // 'ura' | 'unified'. TfL's Countdown/URA interface serves the same predictions
  // as /Mode/bus/Arrivals for a fraction of the cost — measured on the whole
  // network, 2.07MB on the wire against 8.07MB, and 12MB to parse against 90MB,
  // with identical route coverage. It is also a 2012 interface TfL no longer
  // documents, so 'unified' stays one restart away.
  busFeedSource: process.env.BUS_FEED_SOURCE === 'unified' ? 'unified' : 'ura',
  uraBaseUrl: process.env.URA_BASE_URL || 'https://countdown.api.tfl.gov.uk',
  // Charing Cross and a wide radius. The furthest stop in the network is 34.8km
  // out, and row counts are identical from 40km up to 500km, so the margin costs
  // nothing — but malformed geometry answers 416, so it is not unbounded.
  uraCircle: process.env.URA_CIRCLE || '51.5072,-0.1276,60000',
  uraTimeoutMs: Number(process.env.URA_TIMEOUT_MS || 30000),
  // A response smaller than this fraction of the previous one is treated as a
  // failure rather than cached. URA answers 200 with only a header row when it
  // has nothing, and a field-mapping mistake makes every row fail the naptan
  // guard — both blank the map without throwing.
  busFeedMinRetainedFraction: Number(process.env.BUS_FEED_MIN_RETAINED_FRACTION || 0.2),
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
  // Railway's router, like Fly's, terminates TLS upstream, so the socket peer is
  // the proxy and every client would otherwise share a single rate-limit bucket
  // — the first busy visitor would throttle the world. A hop count rather than
  // `true`: trusting the entire chain lets a client prepend its own
  // X-Forwarded-For and choose which bucket it lands in.
  trustProxy: Number(process.env.TRUST_PROXY || 1),
  // fly.toml enforced this with hard_limit = 400; Railway has no equivalent, so
  // the process now enforces its own ceiling. Fan-out is single-threaded, so
  // past a few hundred sockets the TLS and write work saturates one core and
  // every client's updates get slower — refusing the connection is kinder than
  // degrading everyone.
  maxConnections: Math.max(1, Number(process.env.MAX_CONNECTIONS || 400)),
  // One visitor with several tabs is normal; one address holding dozens of
  // sockets is not a map user.
  maxConnectionsPerIp: Math.max(1, Number(process.env.MAX_CONNECTIONS_PER_IP || 12)),
  // Bandwidth figures, poll internals and the allowed-origin list are operator
  // data, not something a public endpoint should handed out. Unset, /health
  // answers liveness only — which is all Railway's health check reads.
  metricsToken: process.env.METRICS_TOKEN || '',
  rateLimit: {
    // Generous, because a normal session makes very few REST calls: the static
    // data is bundled into the build and the live feed is a socket. Per-route
    // costs in server.js are what actually separate /stops from /snapshot.
    httpCapacity: Number(process.env.RATE_HTTP_CAPACITY || 60),
    httpRefillPerSec: Number(process.env.RATE_HTTP_REFILL || 1),
    // A full resend costs a per-tile encode of everything the socket watches —
    // a tiny message in, megabytes out — so it gets far the tightest budget.
    // The server already sends an unprompted full every FULL_EMIT_EVERY_N
    // ticks, so a well-behaved client asks approximately never.
    fullCapacity: Number(process.env.RATE_FULL_CAPACITY || 4),
    fullRefillPerSec: Number(process.env.RATE_FULL_REFILL || 0.1),
    // A pan legitimately fires a burst of these while the camera settles, and
    // each newly covered tile costs a full for that tile.
    viewportCapacity: Number(process.env.RATE_VIEWPORT_CAPACITY || 40),
    viewportRefillPerSec: Number(process.env.RATE_VIEWPORT_REFILL || 2),
    // Details are per-selection: a human clicking vehicles, bounded further by
    // maxDetailIds per call.
    detailsCapacity: Number(process.env.RATE_DETAILS_CAPACITY || 20),
    detailsRefillPerSec: Number(process.env.RATE_DETAILS_REFILL || 2),
  },
  isProduction,
  warnings,
  trainLines,
  busLines,
  allBusLines,
  tflApiBaseUrl: process.env.TFL_API_BASE_URL || 'https://api.tfl.gov.uk',
  tflAppId: process.env.TFL_APP_ID || '',
  tflAppKey,
};
