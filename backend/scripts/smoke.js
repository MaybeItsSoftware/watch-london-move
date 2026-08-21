// Smoke test against a live backend: node scripts/smoke.js
// Requires the server to be running (BACKEND_URL, default http://localhost:4010).
//
// Set METRICS_TOKEN to whatever the server was started with: /health withholds
// everything but liveness from an unauthenticated caller, and most of what
// checkHealth reads lives behind that.

const BASE_URL = process.env.BACKEND_URL || 'http://localhost:4010';
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
// Two responses are operator-gated — /health's metrics and /snapshot?details=1
// — and neither errors without the token. They return a valid, smaller body,
// so an unauthenticated run fails as a missing key and reads like a broken
// server rather than a missing secret.
const METRICS_AUTH = METRICS_TOKEN ? { Authorization: `Bearer ${METRICS_TOKEN}` } : undefined;

// A full run deliberately spends more than the default 60-token bucket holds —
// /routes alone is fetched nine times to prove its transport, at 10 tokens each
// — so being rate-limited partway through is the expected path, not a failure.
// Waiting out the refill is what a well-behaved client does; doing it here also
// makes this the only thing that checks Retry-After tells the truth. Bounded so
// a genuinely stuck bucket still ends the run rather than hanging CI.
const MAX_RATE_LIMIT_WAIT_MS = 240000;
let rateLimitWaitMs = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function get(path, { headers, allowedStatuses = [200] } = {}) {
  for (;;) {
    let response;
    try {
      // undici decompresses transparently but leaves the encoding on the headers,
      // so the checks below can still see what actually came over the wire.
      // eslint-disable-next-line no-await-in-loop -- retry loop, not a hot path
      response = await fetch(`${BASE_URL}${path}`, { headers });
    } catch (error) {
      fail(`${path} unreachable at ${BASE_URL} (${error.message}) — is the server running?`);
    }

    if (response.status === 429 && !allowedStatuses.includes(429)) {
      // eslint-disable-next-line no-await-in-loop
      const waitMs = await rateLimitPause(path, response);
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
      continue;
    }

    assert(allowedStatuses.includes(response.status), `${path} returned HTTP ${response.status}, expected ${allowedStatuses.join(' or ')}`);
    return response;
  }
}

/**
 * Validates a 429 and returns how long to wait before retrying. A client that
 * cannot read Retry-After has to guess, and the usual guess is to hammer — so
 * the header being present, integral and matching the body is a contract worth
 * asserting rather than merely obeying.
 */
async function rateLimitPause(path, response) {
  const retryAfter = Number(response.headers.get('retry-after'));
  assert(
    Number.isInteger(retryAfter) && retryAfter > 0,
    `${path} 429 Retry-After is ${JSON.stringify(response.headers.get('retry-after'))}, expected whole seconds`,
  );
  const body = await response.json().catch(() => ({}));
  assert(
    body.retryAfterSec === retryAfter,
    `${path} 429 body retryAfterSec ${body.retryAfterSec} disagrees with Retry-After ${retryAfter}`,
  );

  // A quarter-second past the advertised moment: the bucket refills on a clock
  // the client cannot see exactly, and retrying a hair early spends the whole
  // wait for nothing.
  const waitMs = retryAfter * 1000 + 250;
  rateLimitWaitMs += waitMs;
  assert(
    rateLimitWaitMs <= MAX_RATE_LIMIT_WAIT_MS,
    `spent over ${MAX_RATE_LIMIT_WAIT_MS / 1000}s rate-limited — the bucket is not refilling `
      + '(RATE_HTTP_REFILL at zero?), or another client is sharing this address',
  );
  console.error(`  … rate limited on ${path}, waiting ${retryAfter}s`);
  return waitMs;
}

async function getJson(path, allowedStatuses = [200], headers) {
  const response = await get(path, { allowedStatuses, headers });
  return { status: response.status, body: await response.json() };
}

async function checkHealth() {
  const { body } = await getJson('/health', [200], METRICS_AUTH);
  assert(body.status === 'ok', `/health status is ${body.status}, expected ok`);

  if (!('metrics' in body)) {
    fail(
      METRICS_TOKEN
        ? '/health served liveness only despite METRICS_TOKEN — it does not match the server\'s'
        : '/health serves liveness only to an unauthenticated caller. Set METRICS_TOKEN to '
          + 'the value the server was started with.',
    );
  }

  ['routeLinesLoaded', 'routeLoadComplete', 'storeSize', 'prunedTotal', 'emitTick', 'lastDeltaSize'].forEach((key) => {
    assert(key in body, `/health missing key: ${key}`);
  });
  ['prunedLastPoll', 'prunedTotal', 'storeSize', 'emitTick', 'lastDeltaSize'].forEach((key) => {
    assert(key in body.metrics, `/health metrics missing key: ${key}`);
  });
  ['lastTickFanoutBytes', 'totalFanoutBytes', 'bytesPerClientPerHourUncompressed', 'compression', 'httpCompression'].forEach((key) => {
    assert(key in body.bandwidth, `/health bandwidth missing key: ${key}`);
  });
  ['sizeDeg', 'occupied'].forEach((key) => {
    assert(key in body.tiles, `/health tiles missing key: ${key}`);
  });

  return `health ok (storeSize=${body.storeSize}, tiles=${body.tiles.occupied}, compression=${body.bandwidth.compression})`;
}

function assertPayloadShape(label, body) {
  assert(Array.isArray(body.removed_ids), `${label} removed_ids is not an array`);
  assert(Array.isArray(body.vehicles), `${label} vehicles is not an array`);
  assert(Array.isArray(body.dict?.type), `${label} dict.type is not an array`);
  assert(Array.isArray(body.dict?.route_group), `${label} dict.route_group is not an array`);

  body.vehicles.forEach((tuple, i) => {
    assert(Array.isArray(tuple) && tuple.length === 9, `${label} vehicles[${i}] is not a 9-element tuple`);
    // The dictionary indices must resolve, or the client silently renders every
    // vehicle as the wrong mode.
    assert(
      typeof body.dict.type[tuple[1]] === 'string',
      `${label} vehicles[${i}] type index ${tuple[1]} is not in dict.type`,
    );
    assert(
      typeof body.dict.route_group[tuple[6]] === 'string',
      `${label} vehicles[${i}] route_group index ${tuple[6]} is not in dict.route_group`,
    );

    // The schedule is consumed as a queue of legs to glide along, so its shape is
    // a contract and not just a payload: flat [lat, lon, secs] triples, every one
    // strictly later than the leg before it — starting from field 7, which is the
    // leg the vehicle is on now. An out-of-order or equal deadline is a leg of
    // zero or negative duration and would stall or reverse the interpolation.
    const schedule = tuple[8];
    assert(Array.isArray(schedule), `${label} vehicles[${i}] schedule is not an array`);
    assert(
      schedule.length % 3 === 0,
      `${label} vehicles[${i}] schedule has ${schedule.length} numbers, not a multiple of 3`,
    );

    let previousSeconds = tuple[7];
    for (let s = 0; s < schedule.length; s += 3) {
      const [lat, lon, seconds] = schedule.slice(s, s + 3);
      assert(
        Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(seconds),
        `${label} vehicles[${i}] schedule stop ${s / 3} is not three finite numbers`,
      );
      assert(
        previousSeconds === null || seconds > previousSeconds,
        `${label} vehicles[${i}] schedule stop ${s / 3} is due at ${seconds}s, not after the previous ${previousSeconds}s`,
      );
      previousSeconds = seconds;
    }
  });
}

async function checkSnapshot() {
  const { body } = await getJson('/snapshot');
  assert(body.kind === 'full', `/snapshot kind is ${JSON.stringify(body.kind)}, expected 'full'`);
  assertPayloadShape('/snapshot', body);
  assert(!('details' in body), '/snapshot carried details without being asked for them');

  const { body: detailed } = await getJson('/snapshot?details=1', [200], METRICS_AUTH);
  assert(
    Array.isArray(detailed.details),
    METRICS_TOKEN
      ? '/snapshot?details=1 details is not an array'
      : '/snapshot?details=1 withheld details from an unauthenticated caller. Set METRICS_TOKEN '
        + 'to the value the server was started with.',
  );
  detailed.details.forEach((detail, i) => {
    ['id', 'destination', 'station_name'].forEach((key) => {
      assert(key in detail, `/snapshot?details=1 details[${i}] missing key: ${key}`);
    });
  });

  return `snapshot ok (${body.vehicles.length} vehicles, ${body.dict.route_group.length} route groups)`;
}

async function checkRoutes() {
  const { status, body } = await getJson('/routes', [200, 503]);

  if (status === 503) {
    assert(body.status === 'loading', `/routes 503 body is ${JSON.stringify(body)}, expected { status: 'loading' }`);
    return 'routes ok (503 still loading)';
  }

  assert(body.type === 'FeatureCollection', `/routes type is ${body.type}, expected FeatureCollection`);
  assert(Array.isArray(body.features), '/routes features is not an array');
  body.features.forEach((feature, i) => {
    assert(feature.type === 'Feature', `/routes features[${i}] is not a Feature`);
    assert(typeof feature.properties?.line === 'string', `/routes features[${i}] missing properties.line`);
    assert(typeof feature.properties?.mode === 'string', `/routes features[${i}] missing properties.mode`);
    assert(feature.geometry?.type === 'MultiLineString', `/routes features[${i}] geometry is not a MultiLineString`);
    assert(Array.isArray(feature.geometry.coordinates), `/routes features[${i}] coordinates is not an array`);
  });

  return `routes ok (${body.features.length} features)`;
}

/**
 * /routes is the largest thing this service serves — 2.69 MB raw against 256 KB
 * of brotli — so the transport is as much a contract as the body. A regression
 * here does not fail anything visibly; it just quietly multiplies the egress
 * bill by ten.
 */
async function checkRoutesTransport() {
  const version = await get('/routes/version', { allowedStatuses: [200, 503] });
  if (version.status === 503) {
    const body = await version.json();
    assert(body.status === 'loading', `/routes/version 503 body is ${JSON.stringify(body)}`);
    return 'routes transport ok (503 still loading)';
  }

  const meta = await version.json();
  assert(Number.isInteger(meta.builtAt) && meta.builtAt > 0, `/routes/version builtAt is ${meta.builtAt}`);
  assert(typeof meta.complete === 'boolean', `/routes/version complete is ${meta.complete}`);
  assert(Number.isInteger(meta.lines) && meta.lines > 0, `/routes/version lines is ${meta.lines}`);
  assert(typeof meta.etag === 'string' && meta.etag.startsWith('"'), `/routes/version etag is ${meta.etag}`);
  assert(
    version.headers.get('cache-control') === 'no-store',
    `/routes/version Cache-Control is ${version.headers.get('cache-control')}, expected no-store`,
  );

  const sizes = {};
  for (const encoding of ['br', 'gzip', 'identity']) {
    // eslint-disable-next-line no-await-in-loop -- three sequential requests, not a hot path
    const response = await get('/routes', { headers: { 'Accept-Encoding': encoding } });
    const served = response.headers.get('content-encoding') || 'identity';
    assert(served === encoding, `/routes offered ${encoding} but served ${served}`);
    sizes[encoding] = Number(response.headers.get('content-length'));
    assert(sizes[encoding] > 0, `/routes ${encoding} sent no Content-Length`);
    // eslint-disable-next-line no-await-in-loop
    await response.arrayBuffer();
  }
  assert(sizes.br < sizes.gzip, `/routes brotli (${sizes.br}) is not smaller than gzip (${sizes.gzip})`);
  assert(sizes.gzip < sizes.identity, `/routes gzip (${sizes.gzip}) is not smaller than raw (${sizes.identity})`);

  // Browsers list gzip before br at equal quality. Honouring that order rather
  // than the server's preference is the easy way to lose most of the saving.
  const browserish = await get('/routes', { headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' } });
  assert(
    browserish.headers.get('content-encoding') === 'br',
    `/routes served ${browserish.headers.get('content-encoding')} to a browser-style Accept-Encoding, expected br`,
  );
  await browserish.arrayBuffer();

  const etag = browserish.headers.get('etag');
  assert(etag === meta.etag, `/routes ETag ${etag} does not match /routes/version etag ${meta.etag}`);
  assert(
    browserish.headers.get('x-routes-complete') === String(meta.complete),
    '/routes X-Routes-Complete disagrees with /routes/version',
  );

  const revalidated = await get('/routes', {
    headers: { 'If-None-Match': etag, 'Accept-Encoding': 'br' },
    allowedStatuses: [304],
  });
  const revalidatedBody = await revalidated.arrayBuffer();
  assert(revalidatedBody.byteLength === 0, `/routes 304 carried ${revalidatedBody.byteLength} bytes of body`);
  // The client keeps polling while geometry is still arriving, so a 304 that
  // drops this header would either stall the poll or make it run forever.
  assert(
    revalidated.headers.get('x-routes-complete') === String(meta.complete),
    '/routes 304 lost X-Routes-Complete',
  );

  // A build that is still running keeps growing, so its body must not be cached.
  const cacheControl = browserish.headers.get('cache-control');
  assert(
    meta.complete ? cacheControl.includes('max-age=3600') : cacheControl === 'no-store',
    `/routes Cache-Control is ${cacheControl} for complete=${meta.complete}`,
  );

  const pinned = await get(`/routes?v=${meta.builtAt}`, { headers: { 'Accept-Encoding': 'br' } });
  await pinned.arrayBuffer();
  assert(
    pinned.headers.get('cache-control') === 'public, max-age=604800, immutable',
    `/routes?v= Cache-Control is ${pinned.headers.get('cache-control')}, expected an immutable week`,
  );
  // Naming a build that is not the one being served must not get that answer
  // pinned under the wrong URL for a week.
  const mismatched = await get('/routes?v=1', { headers: { 'Accept-Encoding': 'br' } });
  await mismatched.arrayBuffer();
  assert(
    !mismatched.headers.get('cache-control').includes('immutable'),
    '/routes?v=<wrong> was served as immutable',
  );

  const ratio = (sizes.identity / sizes.br).toFixed(1);
  return `routes transport ok (${sizes.identity} raw / ${sizes.gzip} gzip / ${sizes.br} br = ${ratio}x, 304 on revalidate)`;
}

async function checkStopsCompression() {
  // Roughly Westminster to the City. Deliberately narrow: getStopsInBounds caps
  // a slice at 400 stops and returns an empty truncated result past that, so a
  // wider box would prove nothing about compression. ~150 stops is 12.7 KB raw.
  const path = '/stops?bbox=-0.14,51.50,-0.12,51.52';
  const compressed = await get(path, { headers: { 'Accept-Encoding': 'gzip' } });
  assert(
    compressed.headers.get('content-encoding') === 'gzip',
    `${path} was served ${compressed.headers.get('content-encoding') || 'uncompressed'} to a gzip client`,
  );
  // The middleware compresses as a stream, so there is no Content-Length to read
  // the wire size from — what is checkable here is that it engaged at all.
  const text = await compressed.text();
  const body = JSON.parse(text);
  assert(Array.isArray(body.stops), `${path} stops is not an array`);
  assert(!body.truncated, `${path} was truncated — this box has to stay under the 400-stop cap`);
  return `stops ok (${body.stops.length} stops, ${text.length} bytes gzipped on the wire)`;
}

/**
 * The tile subscription is the whole point of the streaming layer, so it is
 * checked over a real socket: a narrow viewport must yield strictly fewer
 * vehicles than the unscoped snapshot, and details must arrive on request
 * rather than in the broadcast.
 */
async function checkStream() {
  const { io } = require('socket.io-client');
  const socket = io(BASE_URL, { transports: ['websocket'] });

  const waitFor = (event, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

  try {
    await waitFor('connect');
    const hello = await waitFor('server:hello');
    assert(Number.isFinite(hello.tileSizeDeg), 'server:hello missing tileSizeDeg');

    // Roughly Zone 1: small enough to be a genuine subset of the network.
    const view = { west: -0.16, south: 51.49, east: -0.08, north: 51.53 };
    const scoped = [];
    socket.on('vehicles:full', (payload) => scoped.push(payload));
    socket.emit('viewport:set', view);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert(scoped.length > 0, 'viewport:set produced no tile snapshots');
    scoped.forEach((payload) => {
      assertPayloadShape('scoped vehicles:full', payload);
      assert(typeof payload.tile === 'string', 'scoped payload has no tile');
      assert(!('details' in payload), 'scoped vehicles:full carried per-vehicle details');
    });

    // Subscriptions snap outward to whole grid cells, so the box a client is
    // actually served is the viewport rounded out to tile boundaries.
    const size = hello.tileSizeDeg;
    const box = {
      west: Math.floor(view.west / size) * size,
      south: Math.floor(view.south / size) * size,
      east: (Math.floor(view.east / size) + 1) * size,
      north: (Math.floor(view.north / size) + 1) * size,
    };
    const epsilon = 1e-9;
    scoped.forEach((payload) => {
      payload.vehicles.forEach((tuple) => {
        const [id, , , lat, lon] = tuple;
        assert(
          lat >= box.south - epsilon &&
            lat <= box.north + epsilon &&
            lon >= box.west - epsilon &&
            lon <= box.east + epsilon,
          `vehicle ${id} at ${lat},${lon} was served to a viewport that does not cover it`,
        );
      });
    });

    // The unscoped total comes from REST: the socket now streams a message per
    // tile, so no single event carries the whole network to compare against.
    const { body: everything } = await getJson('/snapshot');
    const total = everything.vehicles.length;
    const scopedCount = scoped.reduce((sum, payload) => sum + payload.vehicles.length, 0);
    assert(
      scopedCount <= total,
      `viewport scoping returned ${scopedCount} vehicles, more than the ${total} in the whole network`,
    );

    const sample = scoped.find((payload) => payload.vehicles.length > 0)?.vehicles[0];
    if (sample) {
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('vehicles:details timed out')), 10000);
        socket.emit('vehicles:details', [sample[0]], (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
      assert(Array.isArray(response?.details), 'vehicles:details did not return a details array');
      assert(response.details.length === 1, `vehicles:details returned ${response.details.length} rows for one id`);
      assert('destination' in response.details[0], 'vehicles:details row missing destination');
    }

    const share = total > 0 ? Math.round((scopedCount / total) * 100) : 0;
    return `stream ok (${scoped.length} tiles, ${scopedCount}/${total} vehicles in view = ${share}%)`;
  } finally {
    socket.disconnect();
  }
}

(async () => {
  const results = [
    await checkHealth(),
    await checkSnapshot(),
    await checkRoutes(),
    await checkRoutesTransport(),
    await checkStopsCompression(),
    await checkStream(),
  ];
  console.log(`PASS: ${results.join('; ')}`);
})().catch((error) => fail(error.message));
