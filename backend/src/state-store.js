const { tileKey } = require('./tiles');

// ~10m: below this the movement is GPS jitter, not travel, and a heading
// computed from it would spin the marker randomly.
const HEADING_MIN_MOVE_METERS = 10;
const METERS_PER_DEGREE_LAT = 111320;

class StateStore {
  constructor(tileSizeDeg) {
    this.tileSizeDeg = tileSizeDeg;
    this.current = new Map();
    // Only the fields getDelta compares, not whole vehicles: cloning the entire
    // fleet every emit tick allocated a second copy of it for no benefit.
    this.previous = new Map();
    // tile key -> ids currently in it, so a per-tile snapshot is a lookup rather
    // than a scan of the whole fleet once per tile.
    this.byTile = new Map();
    // id -> the tile it was last broadcast in, so a removal can be addressed to
    // the room that was actually told about the vehicle.
    this.pendingRemovals = new Map();
    this.lastUpdatedAt = null;
  }

  upsertVehicles(vehicles) {
    const now = new Date().toISOString();
    const nowMs = Date.now();

    vehicles.forEach((vehicle) => {
      const existing = this.current.get(vehicle.id);
      if (existing) {
        vehicle.heading = this.resolveHeading(existing, vehicle);
      }

      const tile = tileKey(vehicle.lat, vehicle.lon, this.tileSizeDeg);
      if (existing && existing.tile !== tile) {
        this.tileMembers(existing.tile).delete(vehicle.id);
      }
      this.tileMembers(tile).add(vehicle.id);

      this.current.set(vehicle.id, {
        ...existing,
        ...vehicle,
        tile,
        updated_at: now,
        last_seen_at: nowMs,
      });
    });

    this.lastUpdatedAt = now;
  }

  tileMembers(tile) {
    let members = this.byTile.get(tile);
    if (!members) {
      members = new Set();
      this.byTile.set(tile, members);
    }
    return members;
  }

  resolveHeading(previous, next) {
    if (this.approxDistanceMeters(previous, next) < HEADING_MIN_MOVE_METERS) {
      return previous.heading;
    }
    // Buses report a real GPS bearing; trust it over a bearing derived from two
    // stop positions. Zero means "not reported" in the TfL feed, not due north.
    if (Number.isFinite(next.heading) && next.heading !== 0) {
      return next.heading;
    }
    return this.calculateHeading(previous, next);
  }

  // Equirectangular approximation — plenty accurate at a 10m threshold and far
  // cheaper than haversine when it runs for every vehicle every poll.
  approxDistanceMeters(a, b) {
    const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const dLat = (b.lat - a.lat) * METERS_PER_DEGREE_LAT;
    const dLon = (b.lon - a.lon) * METERS_PER_DEGREE_LAT * Math.cos(meanLat);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  calculateHeading(previous, next) {
    const lat1 = (previous.lat * Math.PI) / 180;
    const lat2 = (next.lat * Math.PI) / 180;
    const deltaLon = ((next.lon - previous.lon) * Math.PI) / 180;
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    const bearing = (Math.atan2(y, x) * 180) / Math.PI;
    return (bearing + 360) % 360;
  }

  prune(staleMs) {
    const cutoff = Date.now() - staleMs;
    let pruned = 0;

    for (const [id, vehicle] of this.current.entries()) {
      if (vehicle.last_seen_at < cutoff) {
        this.current.delete(id);
        this.previous.delete(id);
        this.byTile.get(vehicle.tile)?.delete(id);
        this.pendingRemovals.set(id, vehicle.tile);
        pruned += 1;
      }
    }

    return pruned;
  }

  get(id) {
    return this.current.get(id) ?? null;
  }

  getSnapshot() {
    return [...this.current.values()];
  }

  /** Every vehicle in one tile. Empty tiles are dropped so they stop being polled. */
  snapshotForTile(tile) {
    const members = this.byTile.get(tile);
    if (!members || members.size === 0) {
      this.byTile.delete(tile);
      return [];
    }
    const vehicles = [];
    for (const id of members) {
      const vehicle = this.current.get(id);
      if (vehicle) {
        vehicles.push(vehicle);
      }
    }
    return vehicles;
  }

  occupiedTiles() {
    return [...this.byTile.keys()];
  }

  /**
   * Changes and removals grouped by the tile room they belong to. A vehicle that
   * crossed a boundary appears twice: as a change in its new tile, and as a
   * removal from the old one, whose watchers will never hear about it again.
   */
  getDelta() {
    const byTile = new Map();
    let changedCount = 0;
    let removedCount = 0;

    const bucket = (tile) => {
      let entry = byTile.get(tile);
      if (!entry) {
        entry = { changed: [], removedIds: [] };
        byTile.set(tile, entry);
      }
      return entry;
    };

    for (const [id, tile] of this.pendingRemovals) {
      bucket(tile).removedIds.push(id);
      removedCount += 1;
    }
    this.pendingRemovals.clear();

    for (const [id, vehicle] of this.current.entries()) {
      const previous = this.previous.get(id);
      if (
        previous &&
        previous.lat === vehicle.lat &&
        previous.lon === vehicle.lon &&
        previous.heading === vehicle.heading
      ) {
        continue;
      }

      bucket(vehicle.tile).changed.push(vehicle);
      changedCount += 1;

      if (previous && previous.tile !== vehicle.tile) {
        bucket(previous.tile).removedIds.push(id);
        removedCount += 1;
      }

      this.previous.set(id, {
        lat: vehicle.lat,
        lon: vehicle.lon,
        heading: vehicle.heading,
        tile: vehicle.tile,
      });
    }

    return { byTile, changedCount, removedCount };
  }
}

module.exports = {
  StateStore,
};
