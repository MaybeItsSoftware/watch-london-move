const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ALL_ROOM, roomForTile, tileKey, tileKeysForBounds } = require('../src/tiles');

const SIZE = 0.05;

describe('tileKey', () => {
  it('floors both axes, including negative longitudes', () => {
    // London is west of Greenwich, so the negative case is the common one, not
    // the edge case — floor(-2.4) is -3, not -2.
    assert.equal(tileKey(51.5, -0.12, SIZE), '-3,1030');
  });

  it('puts two points in the same cell iff they share a cell', () => {
    assert.equal(tileKey(51.501, -0.121, SIZE), tileKey(51.502, -0.122, SIZE));
    assert.notEqual(tileKey(51.5, -0.12, SIZE), tileKey(51.6, -0.12, SIZE));
  });
});

describe('roomForTile', () => {
  it('namespaces tile rooms so they cannot collide with ALL_ROOM', () => {
    assert.notEqual(roomForTile('0,0'), ALL_ROOM);
    assert.ok(roomForTile('0,0').startsWith('t:'));
  });
});

describe('tileKeysForBounds', () => {
  const bounds = { west: -0.2, south: 51.45, east: -0.05, north: 51.55 };

  it('covers the box, with every cell distinct', () => {
    const keys = tileKeysForBounds(bounds, SIZE, 240);
    assert.ok(Array.isArray(keys));
    assert.equal(new Set(keys).size, keys.length);
  });

  it('includes the cell of a point inside the box', () => {
    const keys = tileKeysForBounds(bounds, SIZE, 240);
    assert.ok(keys.includes(tileKey(51.5, -0.12, SIZE)));
  });

  // null means "this client wants everything". Returning it for an unusable box
  // is what stops a malformed viewport from silently narrowing a client's feed
  // to nothing.
  for (const [name, value] of [
    ['null bounds', null],
    ['a non-object', 'everything'],
    ['a missing edge', { west: -0.2, south: 51.45, east: -0.05 }],
    ['a NaN edge', { west: NaN, south: 51.45, east: -0.05, north: 51.55 }],
    ['an inverted longitude span', { west: 0.1, south: 51.45, east: -0.05, north: 51.55 }],
    ['an inverted latitude span', { west: -0.2, south: 51.55, east: -0.05, north: 51.45 }],
  ]) {
    it(`returns null for ${name}`, () => {
      assert.equal(tileKeysForBounds(value, SIZE, 240), null);
    });
  }

  it('returns null rather than clipping when the box needs too many cells', () => {
    // Clipping to the first N would leave holes in the map; "send everything" is
    // the honest answer.
    assert.equal(tileKeysForBounds({ west: -10, south: 40, east: 10, north: 60 }, SIZE, 240), null);
  });

  it('honours the cap exactly at the boundary', () => {
    const square = { west: 0, south: 0, east: 0.05, north: 0.05 };
    assert.equal(tileKeysForBounds(square, SIZE, 4).length, 4);
    assert.equal(tileKeysForBounds(square, SIZE, 3), null);
  });
});
