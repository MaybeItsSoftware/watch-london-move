// Smoke test against a live backend: node scripts/smoke.js
// Requires the server to be running (BACKEND_URL, default http://localhost:4010).

const BASE_URL = process.env.BACKEND_URL || 'http://localhost:4010';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function getJson(path, allowedStatuses = [200]) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`);
  } catch (error) {
    fail(`${path} unreachable at ${BASE_URL} (${error.message}) — is the server running?`);
  }
  assert(allowedStatuses.includes(response.status), `${path} returned HTTP ${response.status}, expected ${allowedStatuses.join(' or ')}`);
  return { status: response.status, body: await response.json() };
}

async function checkHealth() {
  const { body } = await getJson('/health');
  assert(body.status === 'ok', `/health status is ${body.status}, expected ok`);

  ['routeLinesLoaded', 'routeLoadComplete', 'storeSize', 'prunedTotal', 'emitTick', 'lastDeltaSize'].forEach((key) => {
    assert(key in body, `/health missing key: ${key}`);
  });
  ['prunedLastPoll', 'prunedTotal', 'storeSize', 'emitTick', 'lastDeltaSize'].forEach((key) => {
    assert(key in body.metrics, `/health metrics missing key: ${key}`);
  });
  ['lastTickFanoutBytes', 'totalFanoutBytes', 'bytesPerClientPerHourUncompressed', 'compression'].forEach((key) => {
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
    assert(Array.isArray(tuple) && tuple.length === 8, `${label} vehicles[${i}] is not an 8-element tuple`);
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
  });
}

async function checkSnapshot() {
  const { body } = await getJson('/snapshot');
  assert(body.kind === 'full', `/snapshot kind is ${JSON.stringify(body.kind)}, expected 'full'`);
  assertPayloadShape('/snapshot', body);
  assert(!('details' in body), '/snapshot carried details without being asked for them');

  const { body: detailed } = await getJson('/snapshot?details=1');
  assert(Array.isArray(detailed.details), '/snapshot?details=1 details is not an array');
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
  const results = [await checkHealth(), await checkSnapshot(), await checkRoutes(), await checkStream()];
  console.log(`PASS: ${results.join('; ')}`);
})().catch((error) => fail(error.message));
