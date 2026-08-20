const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { describe, it } = require('node:test');
const { TflClient } = require('../src/tfl-client');

const NOW = 1_700_000_000_000;

/** A plausible /Mode/bus/Arrivals row. */
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

describe('fetchAllBusArrivalsStreaming', () => {
  /** A client whose HTTP layer replays a canned body as a stream. */
  function clientServing(body) {
    const client = new TflClient({
      tflApiBaseUrl: 'https://example.invalid',
      scheduleStops: 3,
      busFeedTimeoutMs: 1000,
      retryCount: 0,
      retryBaseDelayMs: 1,
    });
    client.http = {
      get: async () => ({ data: Readable.from([Buffer.from(body)]) }),
    };
    return client;
  }

  it('reduces a streamed array to the same result as the buffered path', async () => {
    const client = clientServing(JSON.stringify(FEED));
    const streamed = await client.fetchAllBusArrivalsStreaming(NOW);
    assert.deepEqual(streamed, TflClient.nearestStopArrivals(FEED, NOW, 3));
  });

  it('handles a body split across chunk boundaries mid-token', async () => {
    // The whole point of streaming: rows arrive in TCP-sized pieces that do not
    // respect JSON structure, so the parser must carry state across chunks.
    const body = JSON.stringify(FEED);
    const chunks = [];
    for (let i = 0; i < body.length; i += 7) {
      chunks.push(Buffer.from(body.slice(i, i + 7)));
    }
    const client = clientServing('');
    client.http = { get: async () => ({ data: Readable.from(chunks) }) };

    const streamed = await client.fetchAllBusArrivalsStreaming(NOW);
    assert.deepEqual(streamed, TflClient.nearestStopArrivals(FEED, NOW, 3));
  });

  it('rejects on a malformed body rather than returning a partial fleet', async () => {
    // fetchAllBusArrivalsInProcess catches this and falls back to the buffered
    // path; returning half a fleet would be cached as if it were real.
    const client = clientServing('[{"vehicleId":"V1","naptanId":');
    await assert.rejects(() => client.fetchAllBusArrivalsStreaming(NOW));
  });

  it('handles an empty feed', async () => {
    const client = clientServing('[]');
    assert.deepEqual(await client.fetchAllBusArrivalsStreaming(NOW), []);
  });
});
