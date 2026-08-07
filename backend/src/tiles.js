// Vehicles are bucketed into a fixed lat/lon grid so a client can subscribe to
// only the cells its viewport covers. The grid is deliberately independent of
// map zoom: with a fixed cell, a vehicle's room membership changes only when it
// actually crosses a boundary, rather than every time somebody zooms.

// A socket whose viewport is too large to express as cells sits here instead,
// and every tile payload is addressed to this room as well as its own. Sockets
// are in ALL_ROOM or in tile rooms, never both, so recipient counts stay a
// simple sum.
const ALL_ROOM = 't:all';

function tileKey(lat, lon, sizeDeg) {
  return `${Math.floor(lon / sizeDeg)},${Math.floor(lat / sizeDeg)}`;
}

function roomForTile(key) {
  return `t:${key}`;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Tile keys covering a bounds box. Returns null when the box is unusable or
 * needs more cells than `maxTiles` allows — the caller reads that as "this
 * client wants everything", which is honest, where silently clipping to the
 * first N cells would leave holes in the map.
 */
function tileKeysForBounds(bounds, sizeDeg, maxTiles) {
  if (!bounds || typeof bounds !== 'object') {
    return null;
  }

  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(isFiniteNumber)) {
    return null;
  }
  // A viewport wide enough to wrap the antimeridian is, at London's scale,
  // already asking for the whole network.
  if (west > east || south > north) {
    return null;
  }

  const minCol = Math.floor(west / sizeDeg);
  const maxCol = Math.floor(east / sizeDeg);
  const minRow = Math.floor(Math.max(south, -85) / sizeDeg);
  const maxRow = Math.floor(Math.min(north, 85) / sizeDeg);

  const width = maxCol - minCol + 1;
  const height = maxRow - minRow + 1;
  if (width <= 0 || height <= 0 || width * height > maxTiles) {
    return null;
  }

  const keys = [];
  for (let col = minCol; col <= maxCol; col += 1) {
    for (let row = minRow; row <= maxRow; row += 1) {
      keys.push(`${col},${row}`);
    }
  }
  return keys;
}

module.exports = {
  ALL_ROOM,
  roomForTile,
  tileKey,
  tileKeysForBounds,
};
