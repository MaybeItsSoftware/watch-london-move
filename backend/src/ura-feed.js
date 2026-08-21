// Parsing for TfL's URA (Countdown) bus feed.
//
// URA answers `/interfaces/ura/instant_V1` with line-delimited JSON arrays rather
// than a JSON document: one array per line, CRLF-terminated, and with no trailing
// newline on the last row. That is why this file exists instead of a stream-json
// pipeline — there is no top-level array to stream the elements of.
//
// Everything here is pure. No HTTP, no class, no state beyond what a reader
// instance carries, so the field-order hazard below can be tested exhaustively
// without a network.

/**
 * The order URA answers in — verified empirically, not taken from the spec.
 *
 * This is the single most dangerous thing about the interface: **URA ignores the
 * order fields are requested in and always answers in its own.** Asking for
 * `EstimatedTime,RegistrationNumber,LineName,StopCode2,Latitude,...` returns
 * `StopPointName,StopCode2,Latitude,...` regardless. A hand-maintained parse
 * order that drifted from the request would therefore not fail — it would put
 * longitude into `lineName` and latitude into `naptanId`, and the service would
 * keep running while drawing London into the sea.
 *
 * So request and parse are both derived from this one list, and the published
 * ordering is not trusted: the spec puts StopPointState before Latitude, while
 * the live feed puts it after StopPointIndicator. Where the two disagree, this
 * reflects the live feed.
 */
const URA_CANONICAL_ORDER = [
  'StopPointName',
  'StopID',
  'StopCode1',
  'StopCode2',
  'StopPointType',
  'Towards',
  'Bearing',
  'StopPointIndicator',
  'StopPointState',
  'Latitude',
  'Longitude',
  'VisitNumber',
  'LineID',
  'LineName',
  'DirectionID',
  'DestinationText',
  'DestinationName',
  'VehicleID',
  'TripID',
  'RegistrationNumber',
  'EstimatedTime',
  'ExpireTime',
];

/**
 * What we actually ask for. A Set rather than an array precisely so it cannot
 * carry an order of its own that might disagree with the canonical list.
 *
 * `DestinationName`, not `DestinationText`: measured against 102,285 matched rows
 * of the Unified feed, DestinationName agrees with its `destinationName` 99.8% of
 * the time and DestinationText only 51.6% — the latter is the blind text, which is
 * abbreviated ("Chingford Stn") and sometimes names an intermediate point entirely
 * ("Romford" for a bus to County Park Estate).
 *
 * `ExpireTime` is deliberately absent: it is always exactly EstimatedTime + 30000,
 * so it carries no information and would only widen the surface for a field-order
 * change to go wrong.
 */
const URA_REQUESTED = new Set([
  'StopPointName',
  'StopCode2',
  'Latitude',
  'Longitude',
  'LineName',
  'DirectionID',
  'DestinationName',
  'VehicleID',
  'RegistrationNumber',
  'EstimatedTime',
]);

/** The requested fields, in the order URA will answer with them. */
const URA_FIELDS = URA_CANONICAL_ORDER.filter((field) => URA_REQUESTED.has(field));

/** Row type markers seen on the wire. */
const ROW_ARRIVAL = 1;
const ROW_BASE_VERSION = 3;
const ROW_HEADER = 4;

/** A response whose shape does not match what we asked for. */
class UraShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UraShapeError';
  }
}

function uraRequestUrl(config) {
  const params = new URLSearchParams({
    ReturnList: URA_FIELDS.join(','),
    Circle: config.uraCircle,
  });
  return `/interfaces/ura/instant_V1?${params.toString()}`;
}

/**
 * Registrations are the join key between this feed and the Unified one, and they
 * are the vehicle's identity on the wire, so they are normalised rather than
 * trusted: a stray space would mint a second vehicle for the same bus and leave
 * the first to be pruned as a ghost.
 */
function normalizeRegistration(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).toUpperCase().replace(/\s+/g, '');
  return text.length > 0 ? text : null;
}

/**
 * TfL reports a handful of stops it has never surveyed as (0, 0). Treated as
 * absent rather than as a position, so the caller falls back to the stop index
 * instead of placing a bus in the Gulf of Guinea.
 */
function finiteCoord(value) {
  return Number.isFinite(value) && value !== 0 ? value : undefined;
}

/**
 * One `[1, ...]` row, normalised.
 *
 * Field names deliberately match the Unified API's, because that is what lets
 * `arrivalAccumulator`, `compareArrivals` and `selectSchedules` in tfl-client.js
 * consume both feeds unmodified — and what keeps the existing equivalence test
 * covering both. In particular `StopCode2` becomes `naptanId`: it is the same
 * NaPTAN identifier space, and four separate places downstream key on that name,
 * including StateStore.scheduleKey.
 */
function uraArrivalFromRow(row) {
  if (row.length !== URA_FIELDS.length + 1) {
    throw new UraShapeError(
      `expected ${URA_FIELDS.length + 1} columns, got ${row.length} — URA has changed its response shape`,
    );
  }

  const raw = {};
  URA_FIELDS.forEach((field, index) => {
    raw[field] = row[index + 1];
  });

  return {
    vehicleId: normalizeRegistration(raw.RegistrationNumber),
    // URA's own fleet number. Only used to build an id when a bus reports no
    // registration, so that a vehicle never has to be identified by its position.
    uraVehicleId: raw.VehicleID ?? null,
    naptanId: raw.StopCode2 ?? null,
    lineName: raw.LineName === null || raw.LineName === undefined ? null : String(raw.LineName),
    directionId: raw.DirectionID ?? null,
    destinationName: raw.DestinationName ?? null,
    stationName: raw.StopPointName ?? null,
    lat: finiteCoord(raw.Latitude),
    lon: finiteCoord(raw.Longitude),
    // Already absolute epoch milliseconds, so no clock-skew triangulation is
    // needed the way the Unified feed's relative countdown requires.
    expectedArrivalMs: Number.isFinite(raw.EstimatedTime) ? raw.EstimatedTime : null,
  };
}

// Greater London with a wide margin. Not a filter — a tripwire for the failure
// mode where a field order changes in a way that preserves column count, which
// the arity check alone cannot catch.
const PLAUSIBLE_LAT = [51.2, 51.8];
const PLAUSIBLE_LON = [-0.7, 0.4];
const PLAUSIBLE_CLOCK_SKEW_MS = 2 * 60 * 60 * 1000;

function validateUraSample(arrival, feedClockMs) {
  if (arrival.lat !== undefined && (arrival.lat < PLAUSIBLE_LAT[0] || arrival.lat > PLAUSIBLE_LAT[1])) {
    throw new UraShapeError(`latitude ${arrival.lat} is outside London — fields may be transposed`);
  }
  if (arrival.lon !== undefined && (arrival.lon < PLAUSIBLE_LON[0] || arrival.lon > PLAUSIBLE_LON[1])) {
    throw new UraShapeError(`longitude ${arrival.lon} is outside London — fields may be transposed`);
  }
  if (arrival.expectedArrivalMs !== null && Number.isFinite(feedClockMs)) {
    const skew = Math.abs(arrival.expectedArrivalMs - feedClockMs);
    if (skew > PLAUSIBLE_CLOCK_SKEW_MS) {
      throw new UraShapeError(`arrival time is ${Math.round(skew / 60000)} minutes from the feed clock`);
    }
  }
  return true;
}

/** How many leading arrivals get the structural check. */
const SAMPLE_SIZE = 20;

/**
 * Incremental reader over the line-delimited body.
 *
 * Hand-rolled rather than a parser dependency because the format is one
 * `JSON.parse` per line, and because the two things that actually bite here —
 * CRLF terminators and a body whose final line has no terminator at all — are
 * exactly what a generic NDJSON reader tends to get wrong.
 *
 * Reading incrementally also matters beyond correctness: it keeps the parse in
 * per-chunk slices rather than one uninterruptible pass over the whole body,
 * which is what allows the bus feed to run on the main thread at all.
 */
function createUraRowReader({ onArrival, onHeader } = {}) {
  let carry = '';
  let checked = 0;
  let feedClockMs = null;
  const stats = { arrivals: 0, headers: 0, baseVersions: 0, unknownRows: 0, dropped: { noRegistration: 0, noStop: 0, noCoords: 0 } };

  function consume(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      throw new UraShapeError(`unparseable row: ${trimmed.slice(0, 80)}`);
    }
    if (!Array.isArray(row)) {
      throw new UraShapeError('row is not an array');
    }

    switch (row[0]) {
      case ROW_HEADER:
        stats.headers += 1;
        feedClockMs = Number.isFinite(row[2]) ? row[2] : null;
        onHeader?.(feedClockMs);
        return;
      case ROW_BASE_VERSION:
        stats.baseVersions += 1;
        return;
      case ROW_ARRIVAL:
        break;
      default:
        // A `ReturnList` URA does not recognise answers 200 with differently
        // shaped rows rather than an error, so an unexpected type is a signal
        // that the request is wrong, not that the row is uninteresting.
        stats.unknownRows += 1;
        return;
    }

    const arrival = uraArrivalFromRow(row);
    if (checked < SAMPLE_SIZE) {
      checked += 1;
      validateUraSample(arrival, feedClockMs);
    }

    if (!arrival.naptanId) {
      stats.dropped.noStop += 1;
      return;
    }
    if (!arrival.vehicleId && arrival.uraVehicleId === null) {
      stats.dropped.noRegistration += 1;
      return;
    }
    if (arrival.lat === undefined || arrival.lon === undefined) {
      stats.dropped.noCoords += 1;
    }

    stats.arrivals += 1;
    onArrival?.(arrival);
  }

  return {
    push(chunk) {
      carry += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index = carry.indexOf('\n');
      while (index !== -1) {
        consume(carry.slice(0, index));
        carry = carry.slice(index + 1);
        index = carry.indexOf('\n');
      }
    },
    /** The last row carries no terminator, so it only exists once the body ends. */
    end() {
      if (carry.length > 0) {
        consume(carry);
        carry = '';
      }
      return stats;
    },
    get feedClockMs() {
      return feedClockMs;
    },
    stats,
  };
}

module.exports = {
  URA_CANONICAL_ORDER,
  URA_FIELDS,
  URA_REQUESTED,
  UraShapeError,
  createUraRowReader,
  normalizeRegistration,
  uraArrivalFromRow,
  uraRequestUrl,
  validateUraSample,
};
