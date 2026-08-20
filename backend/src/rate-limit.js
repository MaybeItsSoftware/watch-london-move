// Rate limiting for a service whose entire bill is egress.
//
// Hand-rolled rather than express-rate-limit because the expensive paths here
// are not all HTTP. `vehicles:request-full` is a socket message that costs a
// full per-tile snapshot of the fleet, and no HTTP middleware can see it; the
// same is true of `viewport:set`, where each newly covered tile triggers a
// send. One bucket implementation covering both keeps the two comparable, and
// means a client cannot dodge the HTTP budget by moving to the socket.

const DEFAULT_SWEEP_MS = 60000;

/**
 * A token bucket per key. Capacity is the burst a client may take at once;
 * refillPerSec is what it earns back. Both matter here: a map client legitimately
 * fires a handful of viewport updates while a pan settles, then goes quiet.
 */
class RateLimiter {
  constructor({ capacity, refillPerSec, sweepMs = DEFAULT_SWEEP_MS }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
    // Unref'd so bucket housekeeping is never the reason the process stays
    // alive while a shutdown drains.
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref();
  }

  /** Tokens `key` would have right now, without spending any. */
  peek(key, now = Date.now()) {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return this.capacity;
    }
    const elapsedSec = (now - bucket.at) / 1000;
    return Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
  }

  take(key, cost = 1) {
    const now = Date.now();
    const tokens = this.peek(key, now);
    if (tokens < cost) {
      // Still recorded, so the refill clock keeps running from this instant
      // rather than from the last successful take.
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - cost, at: now });
    return true;
  }

  /** Whole seconds until `cost` tokens would be available, for Retry-After. */
  retryAfterSec(key, cost = 1) {
    const deficit = cost - this.peek(key);
    return deficit <= 0 ? 0 : Math.ceil(deficit / this.refillPerSec);
  }

  /**
   * Drops buckets that have refilled to capacity. A full bucket is
   * indistinguishable from a key that has never been seen, so keeping it is a
   * slow leak indexed by client address — which is itself a way to exhaust the
   * process that the limiter exists to protect.
   */
  sweep() {
    const now = Date.now();
    for (const key of [...this.buckets.keys()]) {
      if (this.peek(key, now) >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }

  close() {
    clearInterval(this.sweepTimer);
    this.buckets.clear();
  }
}

/**
 * The address to bucket a request against.
 *
 * Behind Railway's router — or Fly's, or any platform proxy — the socket peer is
 * the proxy, so every client would share one bucket and the first busy visitor
 * would rate-limit the world. Express resolves `req.ip` from X-Forwarded-For
 * only when `trust proxy` is set, which server.js does from config.
 */
function httpClientKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * The same, for a socket. socket.io does not consult Express's trust-proxy
 * setting, so the header is read directly. Left-most entry is the originating
 * client; the rest are proxies that appended themselves.
 */
function socketClientKey(socket, trustProxy) {
  if (trustProxy) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return socket.handshake.address || 'unknown';
}

/** Express middleware spending `cost` tokens of `limiter` per request. */
function httpRateLimit(limiter, { cost = 1 } = {}) {
  return (req, res, next) => {
    const key = httpClientKey(req);
    if (limiter.take(key, cost)) {
      next();
      return;
    }
    const retryAfterSec = limiter.retryAfterSec(key, cost);
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'rate limited', retryAfterSec });
  };
}

module.exports = {
  RateLimiter,
  httpClientKey,
  socketClientKey,
  httpRateLimit,
};
