const VEHICLE_SCHEMA = ['id', 'type', 'line_name', 'lat', 'lon', 'heading'];

function toTuple(vehicle) {
  return [vehicle.id, vehicle.type, vehicle.line_name, vehicle.lat, vehicle.lon, vehicle.heading];
}

function validateTuple(tuple) {
  return (
    Array.isArray(tuple) &&
    tuple.length === 6 &&
    typeof tuple[0] === 'string' &&
    typeof tuple[1] === 'string' &&
    typeof tuple[2] === 'string' &&
    Number.isFinite(tuple[3]) &&
    Number.isFinite(tuple[4]) &&
    Number.isFinite(tuple[5])
  );
}

module.exports = {
  VEHICLE_SCHEMA,
  toTuple,
  validateTuple,
};
