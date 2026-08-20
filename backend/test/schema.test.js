const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { FIELD, encodeAll, toDetail, validateTuple } = require('../src/schema');

const NOW = 1_700_000_000_000;

function vehicle(overrides = {}) {
  return {
    id: 'v1',
    type: 'bus',
    line_name: '55',
    lat: 51.512345678,
    lon: -0.123456789,
    heading: 91.6,
    route_group: 'bus-55',
    expected_arrival_ms: NOW + 30000,
    schedule: [],
    ...overrides,
  };
}

describe('validateTuple', () => {
  const valid = ['a', 0, '1', 51.5, -0.1, 0, 0, null, []];

  it('accepts a well-formed tuple, with or without a schedule', () => {
    assert.ok(validateTuple(valid));
    assert.ok(validateTuple(['a', 0, '1', 51.5, -0.1, 0, 0, 30, [51.5, -0.1, 90]]));
  });

  // This is the only gate before the wire and encodeAll drops silently, so a
  // gap here shows up as an empty map rather than as an error.
  for (const [name, tuple] of [
    ['a short tuple', valid.slice(0, 8)],
    ['a null schedule', [...valid.slice(0, 8), null]],
    ['a schedule that is not whole triples', ['a', 0, '1', 51.5, -0.1, 0, 0, 30, [51.5, -0.1]]],
    ['a NaN inside the schedule', ['a', 0, '1', 51.5, -0.1, 0, 0, 30, [51.5, -0.1, NaN]]],
    ['a non-string id', [1, 0, '1', 51.5, -0.1, 0, 0, null, []]],
    ['a non-integer type index', ['a', 0.5, '1', 51.5, -0.1, 0, 0, null, []]],
    ['a NaN latitude', ['a', 0, '1', NaN, -0.1, 0, 0, null, []]],
    ['a null heading', ['a', 0, '1', 51.5, -0.1, null, 0, null, []]],
  ]) {
    it(`rejects ${name}`, () => assert.equal(validateTuple(tuple), false));
  }
});

describe('encodeAll', () => {
  it('rounds coordinates to 5dp and heading to whole degrees', () => {
    const { tuples } = encodeAll([vehicle()], NOW);
    assert.equal(tuples[0][FIELD.lat], 51.51235);
    assert.equal(tuples[0][FIELD.lon], -0.12346);
    assert.equal(tuples[0][FIELD.heading], 92);
  });

  it('interns type and route_group into a per-payload dictionary', () => {
    const { tuples, dictionary } = encodeAll(
      [vehicle(), vehicle({ id: 'v2' }), vehicle({ id: 'v3', type: 'tube', route_group: 'victoria' })],
      NOW,
    );
    // Two of three share a type, so the table holds two entries, not three.
    assert.deepEqual(dictionary.type, ['bus', 'tube']);
    assert.equal(tuples[0][FIELD.type], tuples[1][FIELD.type]);
    assert.notEqual(tuples[0][FIELD.type], tuples[2][FIELD.type]);
    assert.equal(dictionary.type[tuples[2][FIELD.type]], 'tube');
  });

  it('recomputes the countdown against the payload instant, not poll time', () => {
    const { tuples } = encodeAll([vehicle()], NOW);
    assert.equal(tuples[0][FIELD.timeToStation], 30);
    // Same vehicle, a payload stamped 10s later: the countdown must have moved.
    const later = encodeAll([vehicle()], NOW + 10000);
    assert.equal(later.tuples[0][FIELD.timeToStation], 20);
  });

  it('lets the countdown go negative rather than clamping', () => {
    // The prediction expired: the vehicle is at or past the stop, and the client
    // needs to know that rather than see it frozen at zero.
    const { tuples } = encodeAll([vehicle()], NOW + 45000);
    assert.equal(tuples[0][FIELD.timeToStation], -15);
  });

  it('drops a malformed vehicle without losing the rest of the fleet', () => {
    const { tuples } = encodeAll([vehicle(), vehicle({ id: 'bad', lat: NaN }), vehicle({ id: 'v3' })], NOW);
    assert.deepEqual(tuples.map((t) => t[FIELD.id]), ['v1', 'v3']);
  });

  describe('schedule triples', () => {
    const stops = [
      { naptan: 'a', lat: 51.5, lon: -0.1, due_at_ms: NOW + 30000 },
      { naptan: 'b', lat: 51.51, lon: -0.11, due_at_ms: NOW + 90000 },
      { naptan: 'c', lat: 51.52, lon: -0.12, due_at_ms: NOW + 150000 },
    ];

    it('emits the stops after the current one, as [lat, lon, secs]', () => {
      const { tuples } = encodeAll([vehicle({ schedule: stops })], NOW);
      assert.deepEqual(tuples[0][FIELD.schedule], [51.51, -0.11, 90, 51.52, -0.12, 150]);
    });

    it('truncates where rounding to seconds would make a zero-length leg', () => {
      // Two stops <1s apart round to the same second; a client interpolating
      // across that leg divides by zero.
      const collapsed = [stops[0], stops[1], { ...stops[2], due_at_ms: NOW + 90400 }];
      const { tuples } = encodeAll([vehicle({ schedule: collapsed })], NOW);
      assert.deepEqual(tuples[0][FIELD.schedule], [51.51, -0.11, 90]);
    });

    it('truncates at the first stop missing a coordinate', () => {
      const partial = [stops[0], { naptan: 'b', due_at_ms: NOW + 90000 }, stops[2]];
      const { tuples } = encodeAll([vehicle({ schedule: partial })], NOW);
      assert.deepEqual(tuples[0][FIELD.schedule], []);
    });
  });
});

describe('toDetail', () => {
  it('names upcoming stops by coordinate, rounded exactly as the wire rounds', () => {
    const detail = toDetail(
      vehicle({
        destination: 'Bakerloo',
        schedule: [{ name: 'Oxford Circus', lat: 51.512345678, lon: -0.123456789, due_at_ms: NOW }],
      }),
    );
    // Must match encodeAll's rounding, or the client cannot match a detail to a
    // schedule entry and the panel names a stop the vehicle has passed.
    assert.deepEqual(detail.next_stops, [{ name: 'Oxford Circus', lat: 51.51235, lon: -0.12346 }]);
  });

  it('substitutes a placeholder destination rather than emitting undefined', () => {
    assert.equal(toDetail(vehicle()).destination, 'Unknown');
  });

  it('skips stops with no usable position', () => {
    const detail = toDetail(vehicle({ schedule: [{ name: 'nowhere' }, { name: 'here', lat: 51.5, lon: -0.1 }] }));
    assert.deepEqual(detail.next_stops.map((s) => s.name), ['here']);
  });
});
