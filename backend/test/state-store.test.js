const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { StateStore } = require('../src/state-store');
const { tileKey } = require('../src/tiles');

const SIZE = 0.05;

function vehicle(overrides = {}) {
  return { id: 'v1', lat: 51.5, lon: -0.12, heading: 90, ...overrides };
}

/** Tiles that actually carry something, as a plain object for comparison. */
function deltaShape(delta) {
  const out = {};
  for (const [tile, { changed, removedIds }] of delta.byTile) {
    if (changed.length || removedIds.length) {
      out[tile] = { changed: changed.map((v) => v.id), removedIds };
    }
  }
  return out;
}

describe('upsertVehicles', () => {
  it('indexes a vehicle into the tile its position falls in', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    const tile = tileKey(51.5, -0.12, SIZE);
    assert.equal(store.get('v1').tile, tile);
    assert.ok(store.byTile.get(tile).has('v1'));
  });

  it('moves tile membership when a vehicle crosses a boundary', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    const before = tileKey(51.5, -0.12, SIZE);
    store.upsertVehicles([vehicle({ lat: 51.7 })]);
    const after = tileKey(51.7, -0.12, SIZE);

    assert.notEqual(before, after);
    // Left behind in the old cell it would be broadcast to watchers of a tile
    // it is no longer in, forever.
    assert.equal(store.byTile.get(before).has('v1'), false);
    assert.ok(store.byTile.get(after).has('v1'));
  });

  it('merges rather than replaces, so fields absent from a poll survive', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle({ destination: 'Ealing' })]);
    store.upsertVehicles([vehicle({ lat: 51.51 })]);
    assert.equal(store.get('v1').destination, 'Ealing');
  });
});

describe('heading', () => {
  it('keeps the previous heading when the move is GPS jitter', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle({ heading: 90 })]);
    // ~1m north: below the 10m threshold, so a derived bearing would be noise.
    store.upsertVehicles([vehicle({ lat: 51.500009, heading: 0 })]);
    assert.equal(store.get('v1').heading, 90);
  });

  it('prefers a reported bearing over one derived from two positions', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle({ heading: 90 })]);
    store.upsertVehicles([vehicle({ lat: 51.51, heading: 275 })]);
    assert.equal(store.get('v1').heading, 275);
  });

  it('derives a bearing when the feed reports zero, which means "not reported"', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle({ heading: 90 })]);
    store.upsertVehicles([vehicle({ lat: 51.51, heading: 0 })]);
    // Due north from a move that is purely northward.
    assert.equal(Math.round(store.get('v1').heading), 0);
  });
});

describe('getDelta', () => {
  it('reports everything on the first call and nothing on a repeat', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    assert.deepEqual(Object.values(deltaShape(store.getDelta()))[0].changed, ['v1']);

    store.upsertVehicles([vehicle()]);
    assert.deepEqual(deltaShape(store.getDelta()), {});
  });

  it('emits a boundary crossing as a change in the new tile and a removal from the old', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    store.getDelta();

    const before = tileKey(51.5, -0.12, SIZE);
    store.upsertVehicles([vehicle({ lat: 51.7 })]);
    const after = tileKey(51.7, -0.12, SIZE);

    // Watchers of the old tile would otherwise never hear about it again and
    // would keep drawing it where it was.
    assert.deepEqual(deltaShape(store.getDelta()), {
      [after]: { changed: ['v1'], removedIds: [] },
      [before]: { changed: [], removedIds: ['v1'] },
    });
  });

  it('does not manufacture a delta from a revised arrival below the threshold', () => {
    const store = new StateStore(SIZE, 15000);
    store.upsertVehicles([vehicle({ expected_arrival_ms: 1000 })]);
    store.getDelta();

    // TfL nudges predictions by a second or two on every poll; an equality test
    // here would mark the whole fleet changed every cycle.
    store.upsertVehicles([vehicle({ expected_arrival_ms: 3000 })]);
    assert.deepEqual(deltaShape(store.getDelta()), {});
  });

  it('emits a delta once a revised arrival clears the threshold', () => {
    const store = new StateStore(SIZE, 15000);
    store.upsertVehicles([vehicle({ expected_arrival_ms: 1000 })]);
    store.getDelta();
    store.upsertVehicles([vehicle({ expected_arrival_ms: 40000 })]);
    assert.deepEqual(Object.values(deltaShape(store.getDelta()))[0].changed, ['v1']);
  });

  it('emits a delta when the stop sequence advances, even from an identical position', () => {
    const store = new StateStore(SIZE);
    const schedule = [{ naptan: 'a' }, { naptan: 'b' }];
    store.upsertVehicles([vehicle({ schedule })]);
    store.getDelta();

    // The vehicle reached a stop and TfL dropped it off the front: the client's
    // queue of legs is stale and must be replaced.
    store.upsertVehicles([vehicle({ schedule: [{ naptan: 'b' }, { naptan: 'c' }] })]);
    assert.deepEqual(Object.values(deltaShape(store.getDelta()))[0].changed, ['v1']);
  });
});

describe('prune', () => {
  it('drops stale vehicles and reports them as removals from their last tile', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    store.getDelta();

    // Negative window puts the cutoff in the future, so everything is stale.
    assert.equal(store.prune(-1), 1);
    assert.equal(store.get('v1'), null);
    assert.deepEqual(deltaShape(store.getDelta()), {
      [tileKey(51.5, -0.12, SIZE)]: { changed: [], removedIds: ['v1'] },
    });
  });

  it('reports a removal exactly once', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    store.getDelta();
    store.prune(-1);
    store.getDelta();
    assert.deepEqual(deltaShape(store.getDelta()), {});
  });

  it('keeps a vehicle seen within the window', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    assert.equal(store.prune(60000), 0);
    assert.ok(store.get('v1'));
  });
});

describe('snapshotForTile', () => {
  it('returns the vehicles in one cell', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle(), vehicle({ id: 'v2' }), vehicle({ id: 'v3', lat: 51.7 })]);
    const tile = tileKey(51.5, -0.12, SIZE);
    assert.deepEqual(store.snapshotForTile(tile).map((v) => v.id).sort(), ['v1', 'v2']);
  });

  it('forgets a cell once it empties, so idle tiles stop being walked', () => {
    const store = new StateStore(SIZE);
    store.upsertVehicles([vehicle()]);
    const tile = tileKey(51.5, -0.12, SIZE);
    store.prune(-1);
    assert.deepEqual(store.snapshotForTile(tile), []);
    assert.equal(store.byTile.has(tile), false);
  });
});
