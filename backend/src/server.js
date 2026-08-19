const compression = require('compression');
const cors = require('cors');
const express = require('express');
const http = require('http');
const pino = require('pino');
const { Server } = require('socket.io');
const config = require('./config');
const { TflClient } = require('./tfl-client');
const { StateStore } = require('./state-store');
const { RouteSequences } = require('./route-sequences');
const { VEHICLE_SCHEMA, encodeAll, toDetail } = require('./schema');
const { ALL_ROOM, roomForTile, tileKeysForBounds } = require('./tiles');

const logger = pino({ name: 'watch-london-backend' });
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOriginCheck,
    methods: ['GET', 'POST'],
  },
  // Off by default in socket.io v4. Level 6 is the usual size/CPU knee, and
  // concurrencyLimit keeps a burst of reconnects from queueing unbounded
  // deflate work on the event loop.
  perMessageDeflate: config.compression
    ? {
        threshold: config.compressionThresholdBytes,
        concurrencyLimit: 10,
        zlibDeflateOptions: { level: 6, memLevel: 8 },
      }
    : false,
});

app.use(
  cors({
    origin: corsOriginCheck,
    // Cross-origin readers can only see these headers if they are allow-listed.
    exposedHeaders: ['X-Routes-Complete', 'ETag'],
  }),
);

// engine.io claims /socket.io/ off the raw http server before Express is ever
// reached, so this only ever sees the REST routes and cannot interfere with the
// WebSocket upgrade. compression@1.8 negotiates br as well as gzip/deflate, and
// skips any response that already carries a Content-Encoding — which is how
// /routes gets to serve its own precompressed buffers straight through.
if (config.httpCompression) {
  app.use(compression({ threshold: config.httpCompressionThresholdBytes }));
}

const store = new StateStore(config.tileSizeDeg, config.arrivalRevisionMs);
const tfl = new TflClient(config);
const routeSequences = new RouteSequences(config, tfl);

const metrics = {
  polls: 0,
  pollFailures: 0,
  lastPollLatencyMs: 0,
  lastPollAt: null,
  lastPollVehicles: 0,
  failedLines: [],
  stopPoints: 0,
  connectedClients: 0,
  clientsWatchingAll: 0,
  prunedLastPoll: 0,
  prunedTotal: 0,
  storeSize: 0,
  emitTick: 0,
  lastDeltaSize: 0,
  // Bandwidth accounting: payload bytes actually addressed to a client, before
  // deflate. `Fanout` multiplies by recipients, so it is the number the hosting
  // bill tracks; the per-client rate is the one to compare against a data plan.
  lastTickBytes: 0,
  lastTickFanoutBytes: 0,
  totalFanoutBytes: 0,
  detailRequests: 0,
};

// Traffic is bursty — a tile only changes when a poll lands in it — so a single
// tick is a poor sample. This averages over roughly the last hour of ticks.
const TICKS_PER_HOUR = 3600000 / config.emitIntervalMs;
const bandwidthWindow = {
  samples: [],
  fanoutSum: 0,
  clientTickSum: 0,
};

function recordTick(fanoutBytes, clients) {
  bandwidthWindow.samples.push({ fanoutBytes, clients });
  bandwidthWindow.fanoutSum += fanoutBytes;
  bandwidthWindow.clientTickSum += clients;

  while (bandwidthWindow.samples.length > TICKS_PER_HOUR) {
    const dropped = bandwidthWindow.samples.shift();
    bandwidthWindow.fanoutSum -= dropped.fanoutBytes;
    bandwidthWindow.clientTickSum -= dropped.clients;
  }
}

/** Mean bytes one connected client is served per hour, before deflate. */
function bytesPerClientPerHour() {
  if (bandwidthWindow.clientTickSum === 0) {
    return 0;
  }
  return Math.round((bandwidthWindow.fanoutSum / bandwidthWindow.clientTickSum) * TICKS_PER_HOUR);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return config.corsOrigins.includes(origin);
}

/**
 * Shared by the Express and socket.io CORS layers. Rejects with `false` rather
 * than an Error: under Express 5 a thrown Error reaches the error handler and
 * surfaces as a 500, which hides the real cause. A native client sees an opaque
 * connect_error either way, so the warn line is usually the only clue that the
 * WebView's origin is not on the list.
 */
function corsOriginCheck(origin, callback) {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }
  logger.warn({ origin, allowed: config.corsOrigins }, 'rejected origin');
  callback(null, false);
}

/**
 * One tile's worth of vehicles. Every payload covers exactly one tile so the
 * client can attribute each vehicle to a room without knowing the grid maths,
 * and so a `full` can reconcile its own tile without touching the others.
 */
function tilePayload(tile, vehicles, { kind, removedIds = [] }) {
  // One instant for both: `time_to_station` is seconds relative to `generated_at`,
  // so reading the clock twice would leave the countdowns describing a moment the
  // payload does not claim to speak for.
  const generatedAtMs = Date.now();
  const { tuples, dictionary } = encodeAll(vehicles, generatedAtMs);
  return {
    schema: VEHICLE_SCHEMA,
    dict: dictionary,
    generated_at: new Date(generatedAtMs).toISOString(),
    kind,
    tile,
    vehicles: tuples,
    removed_ids: removedIds,
  };
}

/** Sockets are in ALL_ROOM or in tile rooms, never both, so this is a sum. */
function recipientCount(room) {
  const tileMembers = io.sockets.adapter.rooms.get(room)?.size ?? 0;
  const allMembers = io.sockets.adapter.rooms.get(ALL_ROOM)?.size ?? 0;
  return tileMembers + allMembers;
}

/**
 * `build` is deferred so a tile nobody is watching costs a room lookup rather
 * than encoding its whole contents — at low traffic most of the grid is idle.
 */
function emitTile(tile, event, build) {
  const room = roomForTile(tile);
  const recipients = recipientCount(room);
  if (recipients === 0) {
    return;
  }

  const payload = build();
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  metrics.lastTickBytes += bytes;
  metrics.lastTickFanoutBytes += bytes * recipients;
  metrics.totalFanoutBytes += bytes * recipients;

  io.to(room).to(ALL_ROOM).emit(event, payload);
}

/** Full state for one tile, addressed to a single socket. */
function sendTileFull(socket, tile) {
  socket.emit('vehicles:full', tilePayload(tile, store.snapshotForTile(tile), { kind: 'full' }));
}

function sendVisibleFull(socket) {
  const tiles = socket.data.tiles ?? null;
  for (const tile of tiles ?? store.occupiedTiles()) {
    sendTileFull(socket, tile);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    metrics,
    busFeedWorker: tfl.busFeedWorkerState(),
    routeLinesLoaded: routeSequences.getLoadedLineCount(),
    routeLoadComplete: routeSequences.isComplete(),
    routeBuiltAt: routeSequences.getBuiltAt(),
    storeSize: metrics.storeSize,
    prunedTotal: metrics.prunedTotal,
    emitTick: metrics.emitTick,
    lastDeltaSize: metrics.lastDeltaSize,
    bandwidth: {
      lastTickBytes: metrics.lastTickBytes,
      lastTickFanoutBytes: metrics.lastTickFanoutBytes,
      totalFanoutBytes: metrics.totalFanoutBytes,
      windowTicks: bandwidthWindow.samples.length,
      // What one connected client costs, averaged over the window. Deflate
      // takes roughly another 3x off this before it reaches the wire.
      bytesPerClientPerHourUncompressed: bytesPerClientPerHour(),
      compression: config.compression ? 'permessage-deflate' : 'off',
      // Covers the REST side, which perMessageDeflate does not touch at all.
      httpCompression: config.httpCompression ? 'gzip+br' : 'off',
    },
    tiles: {
      sizeDeg: config.tileSizeDeg,
      occupied: store.byTile.size,
      clientsWatchingAll: metrics.clientsWatchingAll,
    },
    config: {
      pollIntervalMs: config.pollIntervalMs,
      emitIntervalMs: config.emitIntervalMs,
      corsOrigins: config.corsOrigins,
      busLines: config.allBusLines ? 'all' : config.busLines.length,
      trainLines: config.trainLines.length,
      staleVehicleMs: config.staleVehicleMs,
      fullEmitEveryN: config.fullEmitEveryN,
      maxViewportTiles: config.maxViewportTiles,
    },
  });
});

app.get('/snapshot', (req, res) => {
  const vehicles = store.getSnapshot();
  const generatedAtMs = Date.now();
  const { tuples, dictionary } = encodeAll(vehicles, generatedAtMs);
  res.json({
    schema: VEHICLE_SCHEMA,
    dict: dictionary,
    generated_at: new Date(generatedAtMs).toISOString(),
    kind: 'full',
    tile: null,
    vehicles: tuples,
    removed_ids: [],
    // Debugging aid only — the socket feed serves these per selection.
    ...(req.query.details === '1' ? { details: vehicles.map(toDetail) } : {}),
  });
});

// Stops in a box, for the markers the map draws at street zoom. Read straight
// off the stop-point index the poller already maintains — no extra TfL traffic.
app.get('/stops', (req, res) => {
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    res.status(400).json({ error: 'bbox=west,south,east,north required' });
    return;
  }
  const [west, south, east, north] = bbox;
  const { stops, truncated } = tfl.getStopsInBounds({ west, south, east, north });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ stops, truncated });
});

/**
 * A conditional request may list several validators, and a proxy is allowed to
 * weaken ours on the way through, so both sides are compared strong-agnostically.
 */
function ifNoneMatchHits(header, etag) {
  if (!header) {
    return false;
  }
  const wanted = etag.replace(/^W\//, '');
  return header
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//, '') === wanted || candidate.trim() === '*');
}

/**
 * Server preference, not the client's. Browsers send "gzip, deflate, br, zstd"
 * with every entry at q=1, and `req.acceptsEncodings('br', 'gzip')` resolves an
 * equal-quality tie by the client's list order — which would hand a browser
 * 644 KB of gzip when it can take 256 KB of brotli. Asked one at a time, q=0
 * and an absent codec still exclude it properly. An absent header means "any",
 * but a client that says nothing has not proven it can inflate anything.
 */
function pickRouteEncoding(req) {
  if (!req.headers['accept-encoding']) {
    return 'identity';
  }
  if (req.acceptsEncodings('br')) {
    return 'br';
  }
  if (req.acceptsEncodings('gzip')) {
    return 'gzip';
  }
  // Anything else (deflate, zstd) falls through to the compression middleware,
  // which will negotiate it per request off the identity body.
  return 'identity';
}

/**
 * The whole network's geometry: 2.69 MB of JSON, and by a wide margin the
 * largest thing this service serves. Three things keep it off the wire —
 * precompressed bodies (256 KB brotli), a strong ETag so a revalidation is a
 * 304 rather than a resend, and an immutable variant for a client that already
 * knows which build it wants.
 */
app.get('/routes', async (req, res, next) => {
  if (!routeSequences.isLoaded()) {
    res.status(503).json({ status: 'loading' });
    return;
  }

  let encoded;
  try {
    encoded = await routeSequences.getEncodedRoutes();
  } catch (error) {
    next(error);
    return;
  }

  // Read off the encoded body rather than the live instance: a checkpoint can
  // land between the await and here, and the headers must describe the bytes
  // actually being sent.
  const { complete, builtAt, etag } = encoded;
  // Building every bus route's geometry takes many minutes, so the response is
  // served partial and the client is told to come back for the rest.
  res.set('X-Routes-Complete', String(complete));
  res.set('ETag', etag);
  // Appended, not assigned: cors has already put Origin here because the origin
  // check is dynamic, and overwriting it would let a shared cache serve one
  // origin's CORS headers to another.
  res.vary('Accept-Encoding');

  // ?v= addresses one specific build, so that URL's content can never change
  // and the client never needs to revalidate. Only honoured when it names the
  // build actually being served — otherwise a client that asked for last week's
  // version would cache this week's under that URL for a week.
  if (req.query.v !== undefined && String(req.query.v) === String(builtAt)) {
    res.set('Cache-Control', 'public, max-age=604800, immutable');
  } else if (complete) {
    // The underlying data has a 7-day TTL and changes a few times a year, so
    // the hourly expiry is about bounding staleness, not about the data moving.
    // stale-while-revalidate keeps the refresh off the render path.
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  } else {
    res.set('Cache-Control', 'no-store');
  }

  if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
    res.status(304).end();
    return;
  }

  // Express's automatic weak ETag comes from res.json/res.send hashing the body;
  // writing the buffer straight out skips that, which is the point — the ETag
  // above is already set and the 2.69 MB never gets hashed per request.
  const accepted = pickRouteEncoding(req);
  const body = accepted === 'br' ? encoded.br : accepted === 'gzip' ? encoded.gzip : encoded.identity;
  if (accepted !== 'identity') {
    res.set('Content-Encoding', accepted);
  }
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Length', String(body.length));
  res.end(body);
});

/**
 * Lets a client find out whether its cached geometry is current for the cost of
 * a few dozen bytes, and hands it the `?v=` it needs to fetch the body from an
 * immutable URL. `etag` is the literal header value, quotes included, so it can
 * go straight back as If-None-Match.
 */
app.get('/routes/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!routeSequences.isLoaded()) {
    res.status(503).json({ status: 'loading' });
    return;
  }
  res.json({
    builtAt: routeSequences.getBuiltAt(),
    complete: routeSequences.isComplete(),
    lines: routeSequences.getLoadedLineCount(),
    etag: routeSequences.routeEtag(),
  });
});

/**
 * Moves a socket onto exactly the rooms its viewport covers. Tiles it already
 * had keep streaming uninterrupted; only newly visible ones get a full, so a
 * pan costs a few small messages rather than a resend of everything on screen.
 */
function applyViewport(socket, bounds) {
  const keys = tileKeysForBounds(bounds, config.tileSizeDeg, config.maxViewportTiles);
  const previous = socket.data.tiles;

  if (keys === null) {
    // Already watching everything — a further zoom out changes nothing, and
    // resending the network on every wheel notch would defeat the point.
    if (previous === null) {
      return;
    }
    for (const tile of previous) {
      socket.leave(roomForTile(tile));
    }
    socket.data.tiles = null;
    socket.join(ALL_ROOM);
    metrics.clientsWatchingAll += 1;
    sendVisibleFull(socket);
    return;
  }

  if (!previous) {
    socket.leave(ALL_ROOM);
    metrics.clientsWatchingAll -= 1;
  }

  const next = new Set(keys);
  for (const tile of previous ?? []) {
    if (!next.has(tile)) {
      socket.leave(roomForTile(tile));
    }
  }

  const wasSubscribed = new Set(previous ?? []);
  socket.data.tiles = next;
  for (const tile of next) {
    if (!wasSubscribed.has(tile)) {
      socket.join(roomForTile(tile));
      sendTileFull(socket, tile);
    }
  }
}

io.on('connection', (socket) => {
  metrics.connectedClients += 1;
  // Until a viewport arrives the client sees the whole network, so a client
  // that never sends one behaves exactly as it did before tiles existed.
  socket.data.tiles = null;
  socket.join(ALL_ROOM);
  metrics.clientsWatchingAll += 1;

  logger.info({ socketId: socket.id, connectedClients: metrics.connectedClients }, 'Client connected');

  socket.emit('server:hello', {
    tileSizeDeg: config.tileSizeDeg,
    maxViewportTiles: config.maxViewportTiles,
    emitIntervalMs: config.emitIntervalMs,
    maxDetailIds: config.maxDetailIds,
  });

  // Nothing is sent yet: a client that is about to declare a viewport would
  // otherwise be handed the whole network microseconds before narrowing to a
  // few tiles of it. If no viewport arrives, it wants everything after all.
  socket.data.graceTimer = setTimeout(() => {
    socket.data.graceTimer = null;
    sendVisibleFull(socket);
  }, config.viewportGraceMs);

  socket.on('viewport:set', (bounds) => {
    if (socket.data.graceTimer) {
      clearTimeout(socket.data.graceTimer);
      socket.data.graceTimer = null;
    }
    try {
      applyViewport(socket, bounds);
    } catch (error) {
      logger.warn({ err: error.message, socketId: socket.id }, 'Rejected viewport update');
    }
  });

  socket.on('vehicles:request-full', () => {
    sendVisibleFull(socket);
  });

  // Destination and next stop are only ever rendered for the selected vehicle,
  // so they are pulled per selection instead of riding along with every tick.
  socket.on('vehicles:details', (ids, ack) => {
    if (typeof ack !== 'function') {
      return;
    }
    metrics.detailRequests += 1;
    const wanted = Array.isArray(ids) ? ids : [ids];
    const details = [];
    for (const id of wanted.slice(0, config.maxDetailIds)) {
      const vehicle = typeof id === 'string' ? store.get(id) : null;
      if (vehicle) {
        details.push(toDetail(vehicle));
      }
    }
    ack({ details });
  });

  socket.on('disconnect', () => {
    metrics.connectedClients -= 1;
    if (socket.data.graceTimer) {
      clearTimeout(socket.data.graceTimer);
      socket.data.graceTimer = null;
    }
    if (socket.data.tiles === null) {
      metrics.clientsWatchingAll -= 1;
    }
    logger.info({ socketId: socket.id, connectedClients: metrics.connectedClients }, 'Client disconnected');
  });
});

async function pollAndUpdate() {
  const startedAt = Date.now();
  metrics.polls += 1;

  try {
    const unified = await tfl.fetchUnifiedVehicles();
    store.upsertVehicles(unified);
    metrics.prunedLastPoll = store.prune(config.staleVehicleMs);
    metrics.prunedTotal += metrics.prunedLastPoll;
    metrics.storeSize = store.current.size;
    metrics.lastPollAt = new Date().toISOString();
    metrics.lastPollLatencyMs = Date.now() - startedAt;
    metrics.lastPollVehicles = unified.length;
    metrics.failedLines = tfl.getFailedLines();
    metrics.stopPoints = tfl.getStopPointCount();

    // Fire-and-forget: route geometry must never delay a polling cycle. ensure()
    // is idempotent and self-gating, so calling it every poll also drives the
    // retry-after-partial-load behaviour without a separate timer.
    routeSequences.ensure().catch((error) => {
      logger.warn({ err: error.message }, 'Route sequence load failed; will retry');
    });

    logger.info(
      {
        poll: metrics.polls,
        vehicles: unified.length,
        pruned: metrics.prunedLastPoll,
        storeSize: metrics.storeSize,
        failedLines: metrics.failedLines,
        latencyMs: metrics.lastPollLatencyMs,
      },
      'Polling cycle completed',
    );
  } catch (error) {
    metrics.pollFailures += 1;
    logger.error({ err: error, poll: metrics.polls }, 'Polling cycle failed');
  }
}

// Self-scheduling rather than setInterval: a slow cycle (rate limiting, retries)
// must not let the next one start on top of it, or the overlap compounds into
// more requests, more throttling, and progressively slower cycles.
let pollTimer = null;
function scheduleNextPoll() {
  pollTimer = setTimeout(async () => {
    await pollAndUpdate();
    scheduleNextPoll();
  }, config.pollIntervalMs);
}

const emitTimer = setInterval(() => {
  metrics.emitTick += 1;
  metrics.lastTickBytes = 0;
  metrics.lastTickFanoutBytes = 0;

  const { byTile, changedCount } = store.getDelta();
  metrics.lastDeltaSize = changedCount;

  for (const [tile, { changed, removedIds }] of byTile) {
    if (changed.length === 0 && removedIds.length === 0) {
      continue;
    }
    emitTile(tile, 'vehicles:delta', () =>
      tilePayload(tile, changed, { kind: 'delta', removedIds }),
    );
  }

  // Deltas can silently diverge on a dropped packet; a periodic full snapshot
  // resynchronises every client without them having to ask. Emitted per tile so
  // a client still only pays for what it is watching.
  if (metrics.emitTick % config.fullEmitEveryN === 0) {
    for (const tile of store.occupiedTiles()) {
      emitTile(tile, 'vehicles:full', () =>
        tilePayload(tile, store.snapshotForTile(tile), { kind: 'full' }),
      );
    }
  }

  recordTick(metrics.lastTickFanoutBytes, metrics.connectedClients);
}, config.emitIntervalMs);

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  clearInterval(emitTimer);
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  // The bus feed worker holds an axios request that can legitimately be 60s
  // long; it is unref'd so it never keeps the process alive on its own, but
  // terminating it explicitly stops it doing pointless work while the server
  // drains.
  tfl.close().catch(() => {});
  io.close(() => {
    server.close(() => process.exit(0));
  });
  // A stuck connection must not hold the container open past the platform's
  // own kill timeout.
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  if (config.allBusLines) {
    logger.info('Tracking every London bus route via the whole-network feed');
  } else {
    logger.info({ busLines: config.busLines.length }, 'Tracking a configured subset of bus routes');
  }

  await pollAndUpdate();
  scheduleNextPoll();
  server.listen(config.port, () => {
    logger.info({ port: config.port, compression: config.compression }, 'Backend listening');
  });
})();
