const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  URA_CANONICAL_ORDER,
  URA_FIELDS,
  URA_REQUESTED,
  UraShapeError,
  createUraRowReader,
  normalizeRegistration,
  uraArrivalFromRow,
  uraRequestUrl,
  validateUraSample,
} = require('../src/ura-feed');

const NOW = 1_700_000_000_000;

/** A well-formed arrival row, in URA's canonical field order. */
function row(overrides = {}) {
  const values = {
    StopPointName: 'Tottenham Court Road Station',
    StopCode2: '490000235V',
    Latitude: 51.516377,
    Longitude: -0.131954,
    LineName: '55',
    DirectionID: 2,
    DestinationName: 'Walthamstow Central',
    VehicleID: 5985,
    RegistrationNumber: 'LTZ1385',
    EstimatedTime: NOW + 60000,
    ...overrides,
  };
  return [1, ...URA_FIELDS.map((f) => values[f])];
}

const line = (r) => JSON.stringify(r);

describe('field order', () => {
  // The highest-value test in this file. URA answers in its own canonical order
  // regardless of the order fields are requested in, so a parse order that drifted
  // from the request would not throw — it would put longitude into lineName and
  // keep running. Every value here IS its own field name, so any transposition
  // shows up as a mismatched string rather than as plausible-looking data.
  it('maps every column to the field it is actually named after', () => {
    const selfDescribing = [1, ...URA_FIELDS];
    const parsed = uraArrivalFromRow(selfDescribing);

    assert.equal(parsed.stationName, 'StopPointName');
    assert.equal(parsed.naptanId, 'StopCode2');
    assert.equal(parsed.lineName, 'LineName');
    assert.equal(parsed.directionId, 'DirectionID');
    assert.equal(parsed.destinationName, 'DestinationName');
    assert.equal(parsed.uraVehicleId, 'VehicleID');
    assert.equal(parsed.vehicleId, 'REGISTRATIONNUMBER'); // normalised to upper case
  });

  it('requests fields in the order URA will answer with them', () => {
    // If these ever diverge, the request and the parse disagree and every row is
    // silently transposed. Deriving both from one list is what prevents it.
    const canonicalPositions = URA_FIELDS.map((f) => URA_CANONICAL_ORDER.indexOf(f));
    assert.deepEqual(canonicalPositions, [...canonicalPositions].sort((a, b) => a - b));
    assert.ok(canonicalPositions.every((p) => p !== -1), 'every requested field is in the canonical list');
  });

  it('asks for exactly the fields it declares an interest in', () => {
    assert.deepEqual(new Set(URA_FIELDS), URA_REQUESTED);
  });

  it('does not request ExpireTime, which carries no information', () => {
    // Always EstimatedTime + 30000 exactly; requesting it only widens the surface
    // for a field-order change.
    assert.equal(URA_REQUESTED.has('ExpireTime'), false);
  });
});

describe('uraRequestUrl', () => {
  it('names every requested field and the circle', () => {
    const url = uraRequestUrl({ uraCircle: '51.5072,-0.1276,60000' });
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    assert.deepEqual(params.get('ReturnList').split(','), URA_FIELDS);
    assert.equal(params.get('Circle'), '51.5072,-0.1276,60000');
  });
});

describe('uraArrivalFromRow', () => {
  it('normalises a row to the Unified feed\'s field names', () => {
    // The names matter: tfl-client's accumulator, compareArrivals and
    // selectSchedules consume both feeds unmodified because of them.
    const parsed = uraArrivalFromRow(row());
    assert.equal(parsed.vehicleId, 'LTZ1385');
    assert.equal(parsed.naptanId, '490000235V');
    assert.equal(parsed.lineName, '55');
    assert.equal(parsed.expectedArrivalMs, NOW + 60000);
    assert.equal(parsed.lat, 51.516377);
  });

  // Arity is the first line of defence: a short row means URA changed its
  // response shape, and mapping it anyway would produce plausible nonsense.
  it('throws when the column count does not match the request', () => {
    assert.throws(() => uraArrivalFromRow([1, 'only', 'three']), UraShapeError);
    assert.throws(() => uraArrivalFromRow([1, ...URA_FIELDS, 'extra']), UraShapeError);
  });

  it('treats (0, 0) coordinates as absent rather than as a position', () => {
    // TfL reports a handful of unsurveyed stops this way; placing a bus there
    // would put it in the Gulf of Guinea.
    const parsed = uraArrivalFromRow(row({ Latitude: 0, Longitude: 0 }));
    assert.equal(parsed.lat, undefined);
    assert.equal(parsed.lon, undefined);
  });

  it('keeps the URA fleet number so a vehicle never needs a position-derived id', () => {
    const parsed = uraArrivalFromRow(row({ RegistrationNumber: null }));
    assert.equal(parsed.vehicleId, null);
    assert.equal(parsed.uraVehicleId, 5985);
  });
});

describe('normalizeRegistration', () => {
  it('upper-cases and strips spaces so one bus is one vehicle', () => {
    assert.equal(normalizeRegistration('lk67 cya'), 'LK67CYA');
    assert.equal(normalizeRegistration('LTZ1385'), 'LTZ1385');
  });

  it('treats blank and missing as absent', () => {
    for (const value of ['', '   ', null, undefined]) {
      assert.equal(normalizeRegistration(value), null);
    }
  });
});

describe('validateUraSample', () => {
  const inLondon = { lat: 51.5, lon: -0.12, expectedArrivalMs: NOW };

  it('accepts a plausible row', () => {
    assert.equal(validateUraSample(inLondon, NOW), true);
  });

  // The case arity cannot catch: a reorder that preserves column count. Swapping
  // lat and lon puts latitude at -0.12, which is nowhere near London.
  it('rejects transposed coordinates', () => {
    assert.throws(() => validateUraSample({ lat: -0.12, lon: 51.5, expectedArrivalMs: NOW }, NOW), UraShapeError);
  });

  it('rejects an arrival time implausibly far from the feed clock', () => {
    assert.throws(
      () => validateUraSample({ ...inLondon, expectedArrivalMs: NOW + 6 * 60 * 60 * 1000 }, NOW),
      UraShapeError,
    );
  });

  it('tolerates an absent position', () => {
    assert.equal(validateUraSample({ lat: undefined, lon: undefined, expectedArrivalMs: NOW }, NOW), true);
  });
});

describe('createUraRowReader', () => {
  const body = [line([4, '1.0', NOW]), line(row()), line(row({ RegistrationNumber: 'LTZ1386' }))];

  function readAll(text, chunkSize = null) {
    const seen = [];
    let clock = null;
    const reader = createUraRowReader({ onArrival: (a) => seen.push(a), onHeader: (c) => { clock = c; } });
    if (chunkSize === null) {
      reader.push(text);
    } else {
      for (let i = 0; i < text.length; i += chunkSize) {
        reader.push(text.slice(i, i + chunkSize));
      }
    }
    return { seen, clock, stats: reader.end() };
  }

  it('reads CRLF-terminated rows', () => {
    // The live feed uses CRLF, which a naive split('\n') leaves a stray \r on.
    const { seen, stats } = readAll(body.join('\r\n'));
    assert.equal(seen.length, 2);
    assert.equal(stats.arrivals, 2);
  });

  it('reads the final row even though the body has no trailing newline', () => {
    // Verified against the live feed: the last line is unterminated, so a reader
    // that only emits on a newline silently loses one vehicle per poll.
    const { seen } = readAll(body.join('\r\n'));
    assert.equal(seen[1].vehicleId, 'LTZ1386');
  });

  it('produces identical results however the body is chunked', () => {
    // Rows straddle TCP chunk boundaries, mid-token and mid-number.
    const whole = readAll(body.join('\r\n'));
    for (const size of [1, 7, 13, 64]) {
      const chunked = readAll(body.join('\r\n'), size);
      assert.deepEqual(chunked.seen, whole.seen, `chunk size ${size}`);
    }
  });

  it('reports the feed clock from the header row', () => {
    const { clock } = readAll(body.join('\r\n'));
    assert.equal(clock, NOW);
  });

  it('skips the BaseVersion row without counting it as an arrival', () => {
    const { seen, stats } = readAll([line([4, '1.0', NOW]), line([3, '20260816']), line(row())].join('\r\n'));
    assert.equal(seen.length, 1);
    assert.equal(stats.baseVersions, 1);
  });

  // A ReturnList URA does not recognise answers 200 with differently shaped rows
  // rather than an error, so an unexpected type means the request is wrong.
  it('counts unrecognised row types instead of ignoring them', () => {
    const { stats } = readAll([line([4, '1.0', NOW]), line([0, '490001119W']), line(row())].join('\r\n'));
    assert.equal(stats.unknownRows, 1);
    assert.equal(stats.arrivals, 1);
  });

  it('drops rows with no stop and counts them', () => {
    const { seen, stats } = readAll([line([4, '1.0', NOW]), line(row({ StopCode2: null }))].join('\r\n'));
    assert.equal(seen.length, 0);
    assert.equal(stats.dropped.noStop, 1);
  });

  it('keeps a row with no coordinates, counting it for the stop-index fallback', () => {
    const { seen, stats } = readAll([line([4, '1.0', NOW]), line(row({ Latitude: 0, Longitude: 0 }))].join('\r\n'));
    assert.equal(seen.length, 1);
    assert.equal(stats.dropped.noCoords, 1);
  });

  it('rejects an unparseable row rather than skipping it', () => {
    // A partial fleet cached as real is worse than no fleet: the caller keeps the
    // previous snapshot on a throw, but caches whatever it is handed.
    const reader = createUraRowReader({});
    assert.throws(() => reader.push('[1,"broken\n'), UraShapeError);
  });

  it('handles an empty feed — header only, no arrivals', () => {
    const { seen, stats } = readAll(line([4, '1.0', NOW]));
    assert.equal(seen.length, 0);
    assert.equal(stats.headers, 1);
  });
});
