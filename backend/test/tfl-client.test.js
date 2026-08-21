const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { TflClient } = require('../src/tfl-client');

const NOW = 1_700_000_000_000;

/** A plausible arrival row, in the shape the accumulator reduces. */
function arrival(vehicleId, naptanId, secondsAway, extra = {}) {
  return {
    vehicleId,
    naptanId,
    lineName: '55',
    timeToStation: secondsAway,
    expectedArrival: new Date(NOW + secondsAway * 1000).toISOString(),
    ...extra,
  };
}

// Two vehicles, several predictions each, deliberately out of order — the feed
// does not arrive sorted.
const FEED = [
  arrival('V1', 'S3', 300),
  arrival('V2', 'T1', 45),
  arrival('V1', 'S1', 60),
  arrival('V1', 'S2', 180),
  arrival('V2', 'T2', 200),
  { vehicleId: 'V3' },                    // no naptanId — must be dropped
  { naptanId: 'S9', timeToStation: 10 },  // no vehicle id — must be dropped
];

describe('arrivalAccumulator', () => {
  it('agrees exactly with the batch reducer', () => {
    // The batch path is now a wrapper over the accumulator, and this is the test
    // that keeps the streaming and buffered paths from drifting apart.
    const batch = TflClient.nearestStopArrivals(FEED, NOW, 3);
    const acc = TflClient.arrivalAccumulator(NOW, 3);
    FEED.forEach((row) => acc.add(row));
    assert.deepEqual(acc.finish(), batch);
  });

  it('drops rows with no vehicle id or no stop', () => {
    const acc = TflClient.arrivalAccumulator(NOW, 3);
    FEED.forEach((row) => acc.add(row));
    assert.equal(acc.size(), 2);
  });

  it('orders each vehicle by arrival, soonest first', () => {
    const acc = TflClient.arrivalAccumulator(NOW, 3);
    FEED.forEach((row) => acc.add(row));
    const v1 = acc.finish().find((r) => r.item.vehicleId === 'V1');
    assert.deepEqual(v1.schedule.map((s) => s.naptanId), ['S1', 'S2', 'S3']);
  });

  it('honours scheduleStops', () => {
    const acc = TflClient.arrivalAccumulator(NOW, 1);
    FEED.forEach((row) => acc.add(row));
    assert.deepEqual(acc.finish().map((r) => r.schedule.length), [1, 1]);
  });

  it('stays bounded when one vehicle reports absurdly many stops', () => {
    // The reason the cap exists: unbounded per-vehicle growth is what streaming
    // is meant to remove, and a malformed vehicle must not reintroduce it.
    const acc = TflClient.arrivalAccumulator(NOW, 3);
    for (let i = 0; i < 5000; i += 1) {
      acc.add(arrival('FLOOD', `S${i}`, i + 1));
    }
    const [result] = acc.finish();
    assert.equal(acc.size(), 1);
    assert.equal(result.schedule.length, 3);
    // The soonest stops survive the trimming.
    assert.equal(result.schedule[0].naptanId, 'S0');
  });
});

// URA is the only bus feed there is: `BUS_FEED_SOURCE=unified` is gone, so a bad
// response has nothing to fall back to and the guards below are the whole
// defence. They are cheap to test and expensive to be wrong about.
describe('fetchBusArrivals', () => {
  const fleet = (size) => Array.from({ length: size }, (_, i) => ({ id: `bus-${i}` }));

  /** A client with a built stop index and a canned URA fetch. */
  function clientReturning(vehicles) {
    const client = new TflClient({
      tflApiBaseUrl: 'https://example.invalid',
      uraBaseUrl: 'https://example.invalid',
      scheduleStops: 3,
      // Never serve from cache unless a test asks for it.
      busCacheWindowMs: 0,
      staleVehicleMs: 120_000,
      busFeedMinRetainedFraction: 0.2,
      retryCount: 0,
      retryBaseDelayMs: 1,
    });
    client.ensureStopPoints = async () => new Map();
    client.fetchUraBusArrivals = async () => vehicles;
    return client;
  }

  it('serves what URA returned', async () => {
    const client = clientReturning(fleet(100));
    assert.equal((await client.fetchBusArrivals()).length, 100);
  });

  it('keeps the previous snapshot when the fleet collapses', async () => {
    // URA answers 200 with only a header row when it has nothing, and a
    // field-mapping slip fails every naptan guard. Neither throws, so without
    // this the map blanks and the empty result is cached as the truth.
    const client = clientReturning(fleet(100));
    await client.fetchBusArrivals();

    client.fetchUraBusArrivals = async () => fleet(5);
    assert.equal((await client.fetchBusArrivals()).length, 100);
    assert.deepEqual(client.cache.bus.failedLines, ['bus (ura, implausible)']);
  });

  it('accepts a drop that stays above the retention floor', async () => {
    // Buses really do leave the road — an overnight fleet is a fraction of the
    // peak — so the guard has to pass a large honest fall.
    const client = clientReturning(fleet(100));
    await client.fetchBusArrivals();

    client.fetchUraBusArrivals = async () => fleet(50);
    assert.equal((await client.fetchBusArrivals()).length, 50);
  });

  it('keeps the previous snapshot when the fetch throws', async () => {
    const client = clientReturning(fleet(100));
    await client.fetchBusArrivals();

    client.fetchUraBusArrivals = async () => {
      throw new Error('ECONNRESET');
    };
    assert.equal((await client.fetchBusArrivals()).length, 100);
    assert.deepEqual(client.cache.bus.failedLines, ['bus (ura)']);
  });

  it('serves nothing once a failing feed is older than a vehicle may be', async () => {
    // Returning the cached array would restamp last_seen_at on every record in
    // upsertVehicles, so prune could never fire and the map would show a frozen
    // fleet indefinitely with nothing raised.
    const client = clientReturning(fleet(100));
    await client.fetchBusArrivals();

    client.config.busCacheWindowMs = 600_000;
    client.cache.bus.at = Date.now() - 300_000;
    assert.deepEqual(await client.fetchBusArrivals(), []);
  });
});
