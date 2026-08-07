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
    // Cross-origin readers can only see this header if it is allow-listed.
    exposedHeaders: ['X-Routes-Complete'],
  }),
);

const store = new StateStore(config.tileSizeDeg);
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
  const { tuples, dictionary } = encodeAll(vehicles);
  return {
    schema: VEHICLE_SCHEMA,
    dict: dictionary,
    generated_at: new Date().toISOString(),
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
    routeLinesLoaded: routeSequences.getLoadedLineCount(),
    routeLoadComplete: routeSequences.isComplete(),
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
  const { tuples, dictionary } = encodeAll(vehicles);
  res.json({
    schema: VEHICLE_SCHEMA,
    dict: dictionary,
    generated_at: new Date().toISOString(),
    kind: 'full',
    tile: null,
    vehicles: tuples,
    removed_ids: [],
    // Debugging aid only — the socket feed serves these per selection.
    ...(req.query.details === '1' ? { details: vehicles.map(toDetail) } : {}),
  });
});

app.get('/routes', (_req, res) => {
  if (!routeSequences.isLoaded()) {
    res.status(503).json({ status: 'loading' });
    return;
  }
  // Building every bus route's geometry takes many minutes, so the response is
  // served partial and the client is told to come back for the rest.
  const complete = routeSequences.isComplete();
  res.set('Cache-Control', complete ? 'public, max-age=3600' : 'no-store');
  res.set('X-Routes-Complete', String(complete));
  res.json(routeSequences.getRoutesGeoJSON());
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
