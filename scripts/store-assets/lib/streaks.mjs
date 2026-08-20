/**
 * The streak language: the icon, and the bands that echo it in the artwork.
 *
 * A vehicle is six lines running in from the left, each a different distance
 * along. Flat weight, round caps, no taper — the version that survives a Play
 * search row. Kept in one module because the stagger and the palette have to
 * agree between the icon and the artwork around it, and two copies would drift.
 */
import { MODE_PALETTE } from './palette.mjs';

/**
 * The line colours, in the order the app's own sidebar lists its six modes:
 * bus red, Underground navy, Overground orange, DLR teal, tram green,
 * Elizabeth purple. True brand hex, which is legible because everything here
 * sits on the listing's cold white — Underground navy has a luminance of 0.087
 * and would need lifting clear of a dark ground.
 */
export const LINES = MODE_PALETTE;

/**
 * How far along each streak's head sits, as a fraction of the run.
 *
 * Deliberately not ascending. A monotonic staircase reads as a bar chart;
 * scattered heads read as six vehicles at different points of their journeys,
 * which is the thing the app actually shows.
 */
const STAGGER = [0.88, 0.55, 0.99, 0.47, 0.79, 0.66];

/** A field of flat streaks running in from the left of a box. */
export function streakBand({
  x,
  y,
  width,
  height,
  count = 6,
  weight,
  bow = 0,
  colours = LINES,
  alternate = true,
  opacity = 1,
}) {
  const spacing = height / (count - 1 || 1);
  return Array.from({ length: count }, (_, i) => {
    const y1 = y + i * spacing;
    const x1 = x + width * STAGGER[i % STAGGER.length];
    const curve = alternate ? bow * (i % 2 ? -1 : 1) : bow;
    const d = curve
      ? `M${x} ${(y1 + curve).toFixed(1)} Q${((x + x1) / 2).toFixed(1)} ${(y1 + curve * 0.35).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`
      : `M${x} ${y1.toFixed(1)}H${x1.toFixed(1)}`;
    return `<path d="${d}" fill="none" stroke="${colours[i % colours.length]}" stroke-width="${weight}" stroke-linecap="round" stroke-opacity="${opacity}"/>`;
  }).join('');
}

/**
 * The icon.
 *
 * @param {object} opts
 * @param {string} opts.background  passed in rather than defaulted, so the mark
 *   sits on exactly the ground the artwork around it uses.
 * @param {string[]} [opts.colours]
 * @param {boolean} [opts.bleed] run off the left edge, or inset to the maskable
 *   safe zone an Android launcher guarantees.
 * @param {number} [opts.size]
 */
export function iconStreaks({ background, colours = LINES, bleed = true, size = 512 }) {
  const count = 6;
  const spacing = 6.8;
  const top = 32 - (spacing * (count - 1)) / 2;
  const x0 = bleed ? -4 : 9;
  const runEnd = bleed ? 60 : 55;
  const weight = 4.6;

  const body = Array.from({ length: count }, (_, i) => {
    const y = top + i * spacing;
    const x1 = x0 + (runEnd - x0) * STAGGER[i];
    return `<path d="M${x0} ${y}H${x1.toFixed(2)}" fill="none" stroke="${colours[i]}" stroke-width="${weight}" stroke-linecap="round"/>`;
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${background}"/>${body}</svg>`
  );
}
