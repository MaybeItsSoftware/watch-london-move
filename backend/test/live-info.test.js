const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const express = require('express');
const { RateLimiter } = require('../src/rate-limit');
const {
  LiveInfo,
  registerLiveInfoRoutes,
  isValidStopId,
  trimArrivals,
  trimLineStatuses,
} = require('../src/live-info');

/** A fetchJson stub that records every path and answers from `routes`. */
function upstreamDouble(routes) {
  const calls = [];
  const fetchJson = async (path) => {
    calls.push(path);
    const answer = routes[path];
    if (answer instanceof Error) {
      throw answer;
    }
    if (typeof answer === 'function') {
      return answer();
    }
    return answer;
  };
  return { calls, fetchJson };
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.response = { status };
  return error;
}

const ARRIVALS_PATH = '/StopPoint/940GZZLUOXC/Arrivals';
const STATUS_PATH = '/Line/Mode/tube,overground,dlr,elizabeth-line,tram/Status';

const RAW_ARRIVALS = [
  { id: 'b', lineId: 'central', lineName: 'Central', destinationName: 'Epping', timeToStation: 240, vehicleId: 'x', naptanId: '940GZZLUOXC', bearing: '', platformName: 'Eastbound - Platform 1' },
  { id: 'a', lineId: 'victoria', lineName: 'Victoria', destinationName: 'Brixton', timeToStation: 30, towards: 'Brixton' },
  { id: 'c', lineName: 'broken row' },
];

describe('isValidStopId', () => {
  it('accepts NaPTAN and hub ids and refuses anything that could steer the path', () => {
    for (const id of ['940GZZLUOXC', '490000077E', 'HUBZWL', '03700074']) {
      assert.equal(isValidStopId(id), true, id);
    }
    for (const id of ['', '../Line', 'a b', 'x'.repeat(33), undefined, 42]) {
      assert.equal(isValidStopId(id), false, String(id));
    }
  });
});

describe('trimArrivals', () => {
  it('keeps only what the panel draws, soonest first, dropping malformed rows', () => {
    assert.deepEqual(trimArrivals(RAW_ARRIVALS), [
      { id: 'a', lineId: 'victoria', lineName: 'Victoria', destinationName: 'Brixton', timeToStation: 30, towards: 'Brixton' },
      { id: 'b', lineId: 'central', lineName: 'Central', destinationName: 'Epping', timeToStation: 240, platformName: 'Eastbound - Platform 1' },
    ]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), lineId: '55', timeToStation: i }));
    assert.equal(trimArrivals(many).length, 20);
  });

  it('treats a non-array body as no arrivals', () => {
    assert.deepEqual(trimArrivals({ message: 'nope' }), []);
  });
});

describe('trimLineStatuses', () => {
  it('keeps every status per line, not just the first', () => {
    const trimmed = trimLineStatuses([
      {
        id: 'district',
        name: 'District',
        modeName: 'tube',
        lineStatuses: [
          { statusSeverity: 10, statusSeverityDescription: 'Good Service', created: 'x' },
          { statusSeverity: 3, statusSeverityDescription: 'Part Suspended', reason: 'Signal failure' },
        ],
      },
    ]);
    assert.deepEqual(trimmed, [
      {
        id: 'district',
        lineStatuses: [
          { statusSeverity: 10, statusSeverityDescription: 'Good Service' },
          { statusSeverity: 3, statusSeverityDescription: 'Part Suspended', reason: 'Signal failure' },
        ],
      },
    ]);
  });
});

describe('LiveInfo', () => {
  it('serves line status to every caller from one upstream request per TTL', async () => {
    let now = 0;
    const upstream = upstreamDouble({ [STATUS_PATH]: [{ id: 'victoria', lineStatuses: [] }] });
    const info = new LiveInfo({ fetchJson: upstream.fetchJson, lineStatusTtlMs: 1000, now: () => now });

    await Promise.all([info.getLineStatus(), info.getLineStatus(), info.getLineStatus()]);
    await info.getLineStatus();
    assert.equal(upstream.calls.length, 1);

    now = 1500;
    await info.getLineStatus();
    assert.equal(upstream.calls.length, 2);
  });

  it('keeps serving the last good line status when a refresh fails', async () => {
    let now = 0;
    let fail = false;
    const info = new LiveInfo({
      fetchJson: async () => {
        if (fail) throw httpError(500);
        return [{ id: 'victoria', lineStatuses: [] }];
      },
      lineStatusTtlMs: 1000,
      now: () => now,
    });
    const first = await info.getLineStatus();
    fail = true;
    now = 5000;
    assert.deepEqual(await info.getLineStatus(), first);
  });

  it('rejects line status when there is nothing cached to fall back on', async () => {
    const info = new LiveInfo({ fetchJson: async () => { throw httpError(500); } });
    await assert.rejects(info.getLineStatus());
  });

  it('caches arrivals per stop briefly and shares an in-flight request', async () => {
    let now = 0;
    const upstream = upstreamDouble({ [ARRIVALS_PATH]: RAW_ARRIVALS });
    const info = new LiveInfo({ fetchJson: upstream.fetchJson, arrivalsTtlMs: 10000, now: () => now });

    await Promise.all([info.getArrivals('940GZZLUOXC'), info.getArrivals('940GZZLUOXC')]);
    assert.equal(upstream.calls.length, 1);
    assert.equal(info.hasFreshArrivals('940GZZLUOXC'), true);

    now = 11000;
    assert.equal(info.hasFreshArrivals('940GZZLUOXC'), false);
    await info.getArrivals('940GZZLUOXC');
    assert.equal(upstream.calls.length, 2);
  });

  it('does not cache a failed arrivals request', async () => {
    const upstream = upstreamDouble({ [ARRIVALS_PATH]: httpError(500) });
    const info = new LiveInfo({ fetchJson: upstream.fetchJson });
    await assert.rejects(info.getArrivals('940GZZLUOXC'));
    assert.equal(info.hasFreshArrivals('940GZZLUOXC'), false);
  });

  it('bounds the arrivals cache', async () => {
    const info = new LiveInfo({ fetchJson: async () => [], maxCachedStops: 3 });
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      await info.getArrivals(id);
    }
    assert.deepEqual([...info.arrivals.keys()], ['C', 'D', 'E']);
  });
});

describe('live-info routes', () => {
  let server;
  let base;
  let upstreamCalls;
  let upstreamLimiter;

  before(async () => {
    const upstream = upstreamDouble({
      [STATUS_PATH]: [{ id: 'victoria', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }],
      [ARRIVALS_PATH]: RAW_ARRIVALS,
      '/StopPoint/NOSUCHSTOP/Arrivals': httpError(404),
      '/StopPoint/BROKEN/Arrivals': httpError(503),
    });
    upstreamCalls = upstream.calls;
    upstreamLimiter = new RateLimiter({ capacity: 3, refillPerSec: 0.001 });
    const app = express();
    registerLiveInfoRoutes(app, {
      liveInfo: new LiveInfo({ fetchJson: upstream.fetchJson }),
      clientLimit: (_req, _res, next) => next(),
      upstream: upstreamLimiter,
    });
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    upstreamLimiter.close();
    server.close();
  });

  it('GET /line-status answers with the trimmed network status', async () => {
    const response = await fetch(`${base}/line-status`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /public/);
    const body = await response.json();
    assert.equal(body.lines[0].id, 'victoria');
    assert.equal(body.lines[0].lineStatuses[0].statusSeverity, 10);
  });

  it('GET /stops/:id/arrivals answers with trimmed arrivals', async () => {
    const response = await fetch(`${base}/stops/940GZZLUOXC/arrivals`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.arrivals.map((a) => a.id), ['a', 'b']);
  });

  it('refuses a malformed stop id without calling TfL', async () => {
    const before = upstreamCalls.length;
    const response = await fetch(`${base}/stops/${encodeURIComponent('../Line')}/arrivals`);
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls.length, before);
  });

  it('maps an unknown stop to 404 and an upstream failure to 502', async () => {
    assert.equal((await fetch(`${base}/stops/NOSUCHSTOP/arrivals`)).status, 404);
    assert.equal((await fetch(`${base}/stops/BROKEN/arrivals`)).status, 502);
  });

  it('sheds load once the shared upstream budget is spent, but still serves cached stops', async () => {
    // Three tokens, all spent by the requests above that reached TfL.
    const response = await fetch(`${base}/stops/ANOTHER/arrivals`);
    assert.equal(response.status, 503);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(`${base}/stops/940GZZLUOXC/arrivals`)).status, 200);
  });
});
