const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS_M = 6371000;

/** Initial great-circle bearing in degrees (0..360) from one [lon, lat] to another. */
export function bearingBetween(from: [number, number], to: [number, number]): number {
  const phi1 = from[1] * DEG_TO_RAD;
  const phi2 = to[1] * DEG_TO_RAD;
  const deltaLambda = (to[0] - from[0]) * DEG_TO_RAD;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/** Interpolate between two headings along the shortest arc. */
export function lerpAngle(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * t;
}

export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** Starts at full speed and decelerates to rest. For a glide picked up partway
 *  along a route rather than departing a stop, where `easeInOutSine` would have
 *  the vehicle accelerate from a standstill it was never at. */
export function easeOutSine(t: number): number {
  return Math.sin((Math.PI * t) / 2);
}

/** Fast equirectangular distance in metres between two [lon, lat] points. */
export function approxDistanceMeters(from: [number, number], to: [number, number]): number {
  const meanLat = ((from[1] + to[1]) / 2) * DEG_TO_RAD;
  const x = (to[0] - from[0]) * DEG_TO_RAD * Math.cos(meanLat);
  const y = (to[1] - from[1]) * DEG_TO_RAD;
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}
