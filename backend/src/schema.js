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
];

// Indices into the tuple above, for readers that would otherwise count commas.
const FIELD = {
  id: 0,
  type: 1,
  lineName: 2,
  lat: 3,
  lon: 4,
  heading: 5,
  routeGroup: 6,
  timeToStation: 7,
};

// 5dp is ~1.1m: far finer than the stop-derived positions TfL reports, and
// around 12 bytes a vehicle cheaper than the full float64 representation.
const COORD_PRECISION = 1e5;

function roundCoord(value) {
  return Math.round(value * COORD_PRECISION) / COORD_PRECISION;
}

function validateTuple(tuple) {
  return (
    Array.isArray(tuple) &&
    tuple.length === 8 &&
    typeof tuple[FIELD.id] === 'string' &&
    Number.isInteger(tuple[FIELD.type]) &&
    typeof tuple[FIELD.lineName] === 'string' &&
    Number.isFinite(tuple[FIELD.lat]) &&
    Number.isFinite(tuple[FIELD.lon]) &&
    Number.isFinite(tuple[FIELD.heading]) &&
    Number.isInteger(tuple[FIELD.routeGroup]) &&
    (tuple[FIELD.timeToStation] === null || Number.isFinite(tuple[FIELD.timeToStation]))
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

  encode(vehicle) {
    return [
      vehicle.id,
      this.intern(vehicle.type, this.types, this.typeIndex),
      vehicle.line_name || '',
      roundCoord(vehicle.lat),
      roundCoord(vehicle.lon),
      Number.isFinite(vehicle.heading) ? Math.round(vehicle.heading) : 0,
      this.intern(vehicle.route_group, this.groups, this.groupIndex),
      Number.isFinite(vehicle.time_to_station) ? Math.round(vehicle.time_to_station) : null,
    ];
  }

  dictionary() {
    return { type: this.types, route_group: this.groups };
  }
}

function encodeAll(vehicles) {
  const encoder = new TupleEncoder();
  const tuples = [];
  for (const vehicle of vehicles) {
    const tuple = encoder.encode(vehicle);
    if (validateTuple(tuple)) {
      tuples.push(tuple);
    }
  }
  return { tuples, dictionary: encoder.dictionary() };
}

/** The fields only the selected vehicle's panel needs, served on request. */
function toDetail(vehicle) {
  return {
    id: vehicle.id,
    destination: vehicle.destination || 'Unknown',
    station_name: vehicle.station_name || '',
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
