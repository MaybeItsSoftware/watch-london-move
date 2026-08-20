const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { RateLimiter, httpRateLimit, socketClientKey } = require('../src/rate-limit');

/** Minimal Express double: records what the middleware did. */
function responseDouble() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('RateLimiter', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('a')), [true, true, true, false]);
    limiter.close();
  });

  it('buckets each key separately', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    // One busy client must not throttle everyone behind the same proxy.
    assert.equal(limiter.take('a'), true);
    assert.equal(limiter.take('a'), false);
    assert.equal(limiter.take('b'), true);
    limiter.close();
  });

  it('refills at the configured rate', () => {
    const limiter = new RateLimiter({ capacity: 10, refillPerSec: 2 });
    const start = Date.now();
    for (let i = 0; i < 10; i += 1) limiter.take('a');
    // Drained, to within the float residue of ten successive subtractions.
    assert.ok(limiter.peek('a', start) < 1e-9);
    assert.equal(Math.round(limiter.peek('a', start + 3000)), 6);
    limiter.close();
  });

  it('never refills past capacity', () => {
    const limiter = new RateLimiter({ capacity: 5, refillPerSec: 1 });
    limiter.take('a');
    assert.equal(limiter.peek('a', Date.now() + 3_600_000), 5);
    limiter.close();
  });

  it('charges a cost greater than one', () => {
    const limiter = new RateLimiter({ capacity: 60, refillPerSec: 1 });
    assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('a', 20)), [true, true, true, false]);
    limiter.close();
  });

  it('reports whole seconds until the request would succeed', () => {
    const limiter = new RateLimiter({ capacity: 4, refillPerSec: 0.1 });
    for (let i = 0; i < 4; i += 1) limiter.take('a');
    assert.equal(limiter.retryAfterSec('a'), 10);
    assert.equal(limiter.retryAfterSec('unseen'), 0);
    limiter.close();
  });

  it('keeps the refill clock running from a refused attempt', () => {
    // Otherwise a client hammering the endpoint resets its own wait each time
    // and can never recover.
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    const start = Date.now();
    limiter.take('a');
    limiter.take('a');
    assert.ok(limiter.peek('a', start + 2000) >= 1);
    limiter.close();
  });

  it('sweeps refilled buckets so the map is not a leak keyed by stranger', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    limiter.take('a');
    assert.equal(limiter.buckets.size, 1);

    // Backdated rather than slept on: a bucket that has refilled to capacity is
    // indistinguishable from a key never seen, and that is the condition under
    // test — not how fast the clock happens to move during the run.
    limiter.buckets.get('a').at -= 10000;
    limiter.sweep();
    assert.equal(limiter.buckets.size, 0);
    limiter.close();
  });

  it('keeps a bucket that is still in debt', () => {
    const limiter = new RateLimiter({ capacity: 5, refillPerSec: 0.001 });
    limiter.take('a');
    limiter.sweep();
    assert.equal(limiter.buckets.size, 1);
    limiter.close();
  });
});

describe('httpRateLimit', () => {
  const req = { ip: '203.0.113.9', socket: {} };

  it('passes the request through while budget remains', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    let called = false;
    httpRateLimit(limiter)(req, responseDouble(), () => { called = true; });
    assert.ok(called);
    limiter.close();
  });

  it('answers 429 with Retry-After once the budget is gone', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0.5 });
    const middleware = httpRateLimit(limiter);
    middleware(req, responseDouble(), () => {});

    const res = responseDouble();
    let called = false;
    middleware(req, res, () => { called = true; });

    assert.equal(called, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '2');
    assert.equal(res.body.retryAfterSec, 2);
    limiter.close();
  });
});

describe('socketClientKey', () => {
  const handshake = (headers, address) => ({ handshake: { headers, address } });

  it('reads the originating client from X-Forwarded-For behind a proxy', () => {
    // Left-most entry is the client; the rest are proxies that appended
    // themselves on the way through.
    const socket = handshake({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, '10.0.0.1');
    assert.equal(socketClientKey(socket, true), '203.0.113.9');
  });

  it('ignores the header when the proxy is not trusted', () => {
    // Otherwise any client could name its own bucket and dodge the limit.
    const socket = handshake({ 'x-forwarded-for': '203.0.113.9' }, '198.51.100.4');
    assert.equal(socketClientKey(socket, false), '198.51.100.4');
  });

  it('falls back to the peer address when the header is absent', () => {
    assert.equal(socketClientKey(handshake({}, '198.51.100.4'), true), '198.51.100.4');
  });
});
