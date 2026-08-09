// Everything the client needs for *every* vehicle on screen — position for the
// mesh, route_group for its colour and route filter, time_to_station to size the
// interpolation glide. Anything only the selected vehicle's info panel shows
// (destination, next station) is fetched on demand instead of broadcast, which
// is most of what a vehicle record used to weigh.
const VEHICLE_SCHEMA = [
  'id',
  'type',
  'line_name',
  'lat',
  'lon',
  'heading',
  'route_group',
  'time_to_station',
  'schedule',
];

// Indices into the tuple above, for readers that would otherwise count commas.
// Append only: a deployed client destructures the tuple positionally and ignores
// what it does not know about, so a new field at the end reaches old clients
// harmlessly while reordering one would silently mis-render the whole fleet.
const FIELD = {
  id: 0,
  type: 1,
  lineName: 2,
  lat: 3,
  lon: 4,
  heading: 5,
  routeGroup: 6,
  timeToStation: 7,
  schedule: 8,
};

// 5dp is ~1.1m: far finer than the stop-derived positions TfL reports, and
// around 12 bytes a vehicle cheaper than the full float64 representation.
const COORD_PRECISION = 1e5;

function roundCoord(value) {
  return Math.round(value * COORD_PRECISION) / COORD_PRECISION;
}

// Every countdown on the wire goes through here, so field 7 and the schedule
// triples cannot drift into different conventions or different rounding.
function secondsFromNow(deadlineMs, nowMs) {
  return Math.round((deadlineMs - nowMs) / 1000);
}

/**
 * Seconds to the next stop **as of this payload's `generated_at`**, recomputed on
 * every encode from the absolute deadline TfL gave us.
 *
 * Deliberately not the number TfL returned at poll time: that one is relative to
 * when TfL computed it, and it rots by up to ~35s crossing the poll, cache and
 * emit windows, which made every client glide too slow and every vehicle arrive
 * late. Recomputing here rather than decaying the stored record is also what
 * keeps this invisible to `StateStore.getDelta`, which compares only position and
 * heading — a ticking countdown must not manufacture a delta for the whole fleet.
 *
 * May be negative: the prediction expired and the vehicle is at or past the stop.
 */
function secondsToStation(vehicle, nowMs) {
  if (Number.isFinite(vehicle.expected_arrival_ms)) {
    return secondsFromNow(vehicle.expected_arrival_ms, nowMs);
  }
  return Number.isFinite(vehicle.time_to_station) ? Math.round(vehicle.time_to_station) : null;
}

/**
 * The stops *after* the one in fields 3/4/7, flattened to `[lat, lon, secs]`
 * triples — a client walking a queue of legs reads them in order and needs no
 * keys, and the flat form costs about 40 bytes a stop against ~90 for objects.
 *
 * Seconds are the same relative-to-`generated_at` convention as field 7, via the
 * same helper, so one client-side clock offset covers the whole tuple.
 *
 * The strictly-increasing check is not paranoia about the upstream ordering,
 * which `nearestStopArrivals` has already established in milliseconds; it is
 * about this rounding. Two stops 400ms apart are strictly ordered in the feed
 * and identical once rounded to seconds, and a zero-length leg is a divide by
 * zero in whatever the client interpolates with. Truncating is the cheap answer:
 * the stops we drop are the far ones nobody reaches within a poll cycle.
 */
function scheduleTriples(vehicle, nowMs) {
  const schedule = Array.isArray(vehicle.schedule) ? vehicle.schedule : [];
  const triples = [];
  let previousSeconds = secondsToStation(vehicle, nowMs);

  for (let i = 1; i < schedule.length; i += 1) {
    const stop = schedule[i];
    if (!Number.isFinite(stop?.due_at_ms) || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      break;
    }
    const seconds = secondsFromNow(stop.due_at_ms, nowMs);
    if (previousSeconds === null || seconds <= previousSeconds) {
      break;
    }
    triples.push(roundCoord(stop.lat), roundCoord(stop.lon), seconds);
    previousSeconds = seconds;
  }

  return triples;
}

function validateSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length % 3 !== 0) {
    return false;
  }
  return schedule.every(Number.isFinite);
}

/**
 * The last gate before the wire, and a silent one: `encodeAll` drops whatever
 * fails rather than throwing, on the grounds that one malformed vehicle should
 * not cost the map every other one. That makes this function's length and field
 * checks load-bearing — a mismatch here does not produce an error, it produces
 * an empty map — so it must be extended in step with `VEHICLE_SCHEMA`.
 */
function validateTuple(tuple) {
  return (
    Array.isArray(tuple) &&
    tuple.length === 9 &&
    typeof tuple[FIELD.id] === 'string' &&
    Number.isInteger(tuple[FIELD.type]) &&
    typeof tuple[FIELD.lineName] === 'string' &&
    Number.isFinite(tuple[FIELD.lat]) &&
    Number.isFinite(tuple[FIELD.lon]) &&
    Number.isFinite(tuple[FIELD.heading]) &&
    Number.isInteger(tuple[FIELD.routeGroup]) &&
    (tuple[FIELD.timeToStation] === null || Number.isFinite(tuple[FIELD.timeToStation])) &&
    validateSchedule(tuple[FIELD.schedule])
  );
}

/**
 * Builds one payload's tuples plus the string table they index into. `type` and
 * `route_group` have about twenty distinct values across thousands of vehicles,
 * so repeating them inline costs far more than the table does.
 *
 * The table is per payload rather than shared across the connection: a message
 * decodes on its own, so a client that missed one is never left holding indices
 * it cannot resolve.
 */
class TupleEncoder {
  constructor() {
    this.types = [];
    this.typeIndex = new Map();
    this.groups = [];
    this.groupIndex = new Map();
  }

  intern(value, table, index) {
    const key = value || '';
    const existing = index.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const next = table.length;
    table.push(key);
    index.set(key, next);
    return next;
  }

  encode(vehicle, nowMs) {
    return [
      vehicle.id,
      this.intern(vehicle.type, this.types, this.typeIndex),
      vehicle.line_name || '',
      roundCoord(vehicle.lat),
      roundCoord(vehicle.lon),
      Number.isFinite(vehicle.heading) ? Math.round(vehicle.heading) : 0,
      this.intern(vehicle.route_group, this.groups, this.groupIndex),
      secondsToStation(vehicle, nowMs),
      scheduleTriples(vehicle, nowMs),
    ];
  }

  dictionary() {
    return { type: this.types, route_group: this.groups };
  }
}

// `nowMs` is the instant the payload speaks for. Callers must pass the same value
// they stamp into `generated_at`, since the countdowns are relative to it.
function encodeAll(vehicles, nowMs = Date.now()) {
  const encoder = new TupleEncoder();
  const tuples = [];
  for (const vehicle of vehicles) {
    const tuple = encoder.encode(vehicle, nowMs);
    if (validateTuple(tuple)) {
      tuples.push(tuple);
    }
  }
  return { tuples, dictionary: encoder.dictionary() };
}

/**
 * The fields only the selected vehicle's panel needs, served on request.
 *
 * `next_stops` names the same stops the tuple's schedule positions, identified
 * by coordinate rather than by index. The client works through its queue of legs
 * on its own clock and is routinely a stop or two beyond the one TfL currently
 * leads with, so `station_name` alone would have the panel naming a stop the
 * vehicle has visibly passed. An index would drift whenever a payload and a
 * detail response described slightly different moments; a coordinate cannot,
 * because it is rounded here exactly as it is on the wire.
 *
 * Affordable only because this is per selection: `maxDetailIds` caps a request
 * at 50 vehicles, where the broadcast carries thousands.
 */
function toDetail(vehicle) {
  const schedule = Array.isArray(vehicle.schedule) ? vehicle.schedule : [];
  return {
    id: vehicle.id,
    destination: vehicle.destination || 'Unknown',
    station_name: vehicle.station_name || '',
    next_stops: schedule
      .filter((stop) => Number.isFinite(stop?.lat) && Number.isFinite(stop.lon))
      .map((stop) => ({
        name: stop.name || '',
        lat: roundCoord(stop.lat),
        lon: roundCoord(stop.lon),
      })),
  };
}

module.exports = {
  FIELD,
  TupleEncoder,
  VEHICLE_SCHEMA,
  encodeAll,
  toDetail,
  validateTuple,
};
