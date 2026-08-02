class StateStore {
  constructor() {
    this.current = new Map();
    this.previousSnapshot = new Map();
    this.lastUpdatedAt = null;
  }

  upsertVehicles(vehicles) {
    const now = new Date().toISOString();

    vehicles.forEach((vehicle) => {
      const existing = this.current.get(vehicle.id);
      if (existing) {
        vehicle.heading = this.calculateHeading(existing, vehicle);
      }
      this.current.set(vehicle.id, {
        ...existing,
        ...vehicle,
        updated_at: now,
      });
    });

    this.lastUpdatedAt = now;
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

  getSnapshot() {
    return [...this.current.values()];
  }

  getDelta() {
    const changed = [];
    for (const [id, vehicle] of this.current.entries()) {
      const previous = this.previousSnapshot.get(id);
      if (!previous || previous.lat !== vehicle.lat || previous.lon !== vehicle.lon || previous.heading !== vehicle.heading) {
        changed.push(vehicle);
      }
    }

    this.previousSnapshot = new Map(this.current);
    return changed;
  }
}

module.exports = {
  StateStore,
};
