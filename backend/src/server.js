const cors = require('cors');
const express = require('express');
const http = require('http');
const pino = require('pino');
const { Server } = require('socket.io');
const config = require('./config');
const { TflClient } = require('./tfl-client');
const { StateStore } = require('./state-store');
const { VEHICLE_SCHEMA, toTuple, validateTuple } = require('./schema');

const logger = pino({ name: 'watch-london-backend' });
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.corsOrigin,
    methods: ['GET', 'POST'],
  },
});

app.use(cors({ origin: config.corsOrigin }));

const store = new StateStore();
const tfl = new TflClient(config);

const metrics = {
  polls: 0,
  pollFailures: 0,
  lastPollLatencyMs: 0,
  lastPollAt: null,
  connectedClients: 0,
};

function toResponsePayload(vehicles) {
  const tuples = vehicles.map(toTuple).filter(validateTuple);
  return {
    schema: VEHICLE_SCHEMA,
    generated_at: new Date().toISOString(),
    vehicles: tuples,
    details: vehicles.map((vehicle) => ({
      id: vehicle.id,
      destination: vehicle.destination,
      route_group: vehicle.route_group,
      line_name: vehicle.line_name,
      type: vehicle.type,
    })),
  };
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    metrics,
    config: {
      pollIntervalMs: config.pollIntervalMs,
      emitIntervalMs: config.emitIntervalMs,
      busLines: config.busLines.length,
      trainLines: config.trainLines.length,
    },
  });
});

app.get('/snapshot', (_req, res) => {
  res.json(toResponsePayload(store.getSnapshot()));
});

io.on('connection', (socket) => {
  metrics.connectedClients += 1;
  logger.info({ socketId: socket.id, connectedClients: metrics.connectedClients }, 'Client connected');

  socket.emit('vehicles:full', toResponsePayload(store.getSnapshot()));

  socket.on('disconnect', () => {
    metrics.connectedClients -= 1;
    logger.info({ socketId: socket.id, connectedClients: metrics.connectedClients }, 'Client disconnected');
  });
});

async function pollAndUpdate() {
  const startedAt = Date.now();
  metrics.polls += 1;

  try {
    const unified = await tfl.fetchUnifiedVehicles();
    store.upsertVehicles(unified);
    metrics.lastPollAt = new Date().toISOString();
    metrics.lastPollLatencyMs = Date.now() - startedAt;

    logger.info(
      {
        poll: metrics.polls,
        vehicles: unified.length,
        latencyMs: metrics.lastPollLatencyMs,
      },
      'Polling cycle completed',
    );
  } catch (error) {
    metrics.pollFailures += 1;
    logger.error({ err: error, poll: metrics.polls }, 'Polling cycle failed');
  }
}

setInterval(async () => {
  await pollAndUpdate();
}, config.pollIntervalMs);

setInterval(() => {
  const full = toResponsePayload(store.getSnapshot());
  const delta = toResponsePayload(store.getDelta());
  io.emit('vehicles:delta', delta);
  io.emit('vehicles:full', full);
}, config.emitIntervalMs);

(async () => {
  await pollAndUpdate();
  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Backend listening');
  });
})();
