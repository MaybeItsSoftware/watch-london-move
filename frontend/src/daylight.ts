/**
 * Where the sun is over London, so the basemap can follow the time of day.
 *
 * This solves for the sun's altitude directly rather than for sunrise and
 * sunset times, which is both shorter and gives the dusk band for free: a
 * threshold on altitude is the same thing as "within N minutes of sunset", but
 * it stays correct through the year without special-casing London's midsummer
 * evenings or midwinter afternoons.
 *
 * The astronomy is the standard low-precision solar position model (the same
 * one SunCalc uses), accurate to well under a degree — far tighter than the
 * thresholds below care about.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
/** Obliquity of the ecliptic. */
const E = RAD * 23.4397;

export const LONDON: [lat: number, lon: number] = [51.5072, -0.1276];

const toDays = (date: Date) => date.getTime() / DAY_MS - 0.5 + J1970 - J2000;

function solarAltitudeDegrees(date: Date, lat: number, lon: number): number {
  const d = toDays(date);

  const meanAnomaly = RAD * (357.5291 + 0.98560028 * d);
  const equationOfCentre =
    RAD *
    (1.9148 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly) +
      0.0003 * Math.sin(3 * meanAnomaly));
  const eclipticLongitude = meanAnomaly + equationOfCentre + RAD * 102.9372 + Math.PI;

  const declination = Math.asin(Math.sin(E) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.sin(eclipticLongitude) * Math.cos(E),
    Math.cos(eclipticLongitude),
  );

  const westLongitude = RAD * -lon;
  const siderealTime = RAD * (280.16 + 360.9856235 * d) - westLongitude;
  const hourAngle = siderealTime - rightAscension;

  const phi = RAD * lat;
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(declination) +
      Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle),
  );
  return altitude / RAD;
}

export type DaylightPhase = 'day' | 'dusk' | 'night';

/** Above this the sun is high enough for full daylight colours. */
const DAY_ALTITUDE = 4;
/** Below this there is no usable light left; roughly civil twilight. */
const NIGHT_ALTITUDE = -8;

export function daylightPhase(now: Date = new Date()): DaylightPhase {
  const altitude = solarAltitudeDegrees(now, LONDON[0], LONDON[1]);
  if (altitude > DAY_ALTITUDE) {
    return 'day';
  }
  if (altitude > NIGHT_ALTITUDE) {
    return 'dusk';
  }
  return 'night';
}

/** How often to re-check. The dusk band is tens of minutes wide, so a few
 *  minutes of lag either side of a transition is imperceptible. */
export const DAYLIGHT_POLL_MS = 5 * 60 * 1000;
