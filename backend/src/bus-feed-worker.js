/**
 * Worker-thread half of the whole-network bus feed.
 *
 * `/Mode/bus/Arrivals?count=-1` is one request covering all ~640 routes, and it
 * answers with ~80MB of JSON. Read on the main thread, that is a single
 * `JSON.parse` holding the event loop for 180ms on a fast laptop and closer to a
 * second on the shared vCPU this deploys to — measured, not estimated — followed
 * by a reduce over ~120,000 rows. It happens every `busCacheWindowMs`, and for
 * its whole duration nothing else runs: no delta emit, no `/health`, no
 * WebSocket ping, no HTTP response. Every connected client sees a stall on the
 * same cadence as the poll.
 *
 * So the request, the parse and the reduce all happen here instead, and only the
 * result — a few thousand canonical vehicle records — crosses back to the main
 * thread. The 80MB never exists in the process that serves clients.
 *
 * The stop-point index comes over separately and is kept between requests. It is
 * ~33,000 entries and changes about once a day, so shipping it with every poll
 * would put a multi-megabyte structured clone back on the main thread and undo a
 * good part of the point.
 */
const { parentPort, workerData } = require('worker_threads');
const { TflClient } = require('./tfl-client');

const config = workerData.config;
// Static reducers and `getJsonWithRetry` only; this instance holds no state of
// its own and never polls on a timer.
const client = new TflClient(config);

/** naptanId -> { lat, lon, name }, mirrored from the main thread. */
let stopPoints = new Map();
let stopsEpoch = -1;

parentPort.on('message', (message) => {
  if (message.type === 'stops') {
    stopPoints = new Map(message.entries);
    stopsEpoch = message.epoch;
    return;
  }

  if (message.type === 'fetch') {
    void run(message);
  }
});

async function run({ requestId, fetchedAtMs, epoch }) {
  // The main thread only sends `fetch` once it has seen this epoch acknowledged,
  // but a race here would silently drop every vehicle — `busVehicle` returns
  // null for a stop it cannot place — so it is worth refusing outright rather
  // than answering with an empty fleet the caller would cache as real.
  if (epoch !== stopsEpoch) {
    parentPort.postMessage({
      requestId,
      error: `stop index epoch mismatch (worker ${stopsEpoch}, wanted ${epoch})`,
    });
    return;
  }

  try {
    const vehicles = await client.fetchAllBusArrivalsInProcess(stopPoints, fetchedAtMs);
    parentPort.postMessage({ requestId, vehicles });
  } catch (error) {
    parentPort.postMessage({ requestId, error: error?.message || String(error) });
  }
}
