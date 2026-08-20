/**
 * The "screenshot" behind every store asset.
 *
 * These samples exist to choose an aesthetic, and a grey placeholder rectangle
 * would tell you nothing about how the frame sits against the product. So the
 * plate is drawn from the same route geometry the app itself ships —
 * frontend/public/data/routes.json, 662 real lines — projected with Web
 * Mercator and dotted with vehicles sampled along those lines. It is not a
 * live capture: positions come from a seeded PRNG, not TfL. Everything else
 * (line colours, chrome, panel treatment) is the app's own.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, FILTERS, colorForMode, isRail } from './palette.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const routes = JSON.parse(
  readFileSync(join(root, 'frontend/public/data/routes.json'), 'utf8'),
).features;

const CHARING_CROSS = [-0.1276, 51.5074];

/** Deterministic PRNG — the same seed must give the same plate every run. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * Web Mercator into pixels. The y term is converted back into degree-equivalent
 * units so one scale factor covers both axes and the aspect stays true.
 */
function projector({ width, height, centre: [clon, clat], lonSpan }) {
  const scale = width / lonSpan;
  const cy = mercY(clat);
  return ([lon, lat]) => [
    (lon - clon) * scale + width / 2,
    height / 2 - (mercY(lat) - cy) * (180 / Math.PI) * scale,
  ];
}

/**
 * Split a projected line into the runs that touch the viewport.
 *
 * Filtering points by "is it on screen" instead joins the last point before a
 * route leaves the plate to the first one after it returns — a straight chord
 * ruled clean across the whole image. A point is kept if it or either
 * neighbour is visible, so each run still runs off the edge properly.
 */
function clipRuns(points, inside) {
  const runs = [];
  let run = [];
  for (let i = 0; i < points.length; i++) {
    const visible = inside(points[i]) || (i > 0 && inside(points[i - 1])) || (i < points.length - 1 && inside(points[i + 1]));
    if (visible) {
      run.push(points[i]);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1);
}

/** Drop points closer than `minPx` to the last kept one. A full-detail path is
 *  ~100k coordinates across the network, which makes an SVG librsvg chews on
 *  for minutes; at plate scale the dropped points are sub-pixel anyway. */
function decimate(points, minPx) {
  const out = [points[0]];
  for (const p of points) {
    const last = out[out.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minPx) out.push(p);
  }
  return out.length > 1 ? out : null;
}


/** The points behind index `i`, up to `length` pixels back along the line.
 *  A vehicle's trail is the road it just came down, not a straight tail. */
function walkBack(points, i, length) {
  const out = [points[i]];
  let travelled = 0;
  for (let j = i - 1; j >= 0 && travelled < length; j--) {
    const [ax, ay] = points[j + 1];
    const [bx, by] = points[j];
    travelled += Math.hypot(bx - ax, by - ay);
    out.push(points[j]);
  }
  return out.length > 1 ? out : null;
}

/** A triangular arrowhead of `size`, centred on (x,y) and pointing at `angle`.
 *  Notched at the back so it reads as a chevron rather than a blob. */
export function arrowHead(x, y, angle, size) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (dx, dy) => `${(x + dx * cos - dy * sin).toFixed(1)},${(y + dx * sin + dy * cos).toFixed(1)}`;
  return `M${at(size, 0)}L${at(-size * 0.78, size * 0.66)}L${at(-size * 0.34, 0)}L${at(-size * 0.78, -size * 0.66)}Z`;
}

const fmt = (points) =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');


/**
 * A vehicle drawn as motion rather than a marker: the road it has just covered,
 * stroked three times over the same points — long and faint, then shorter and
 * heavier — so it thickens and brightens into a round head at the front.
 *
 * Three flat strokes rather than one gradient-stroked path because librsvg
 * resolves a gradient per element, and there are a thousand of these.
 */
function streak(trail, colour, w) {
  if (!trail || trail.length < 2) return '';
  const cut = (fraction) => trail.slice(0, Math.max(2, Math.ceil(trail.length * fraction)));
  const layers = [
    [1, w * 0.5, 0.2],
    [0.55, w * 0.8, 0.45],
    [0.25, w * 1.05, 0.85],
  ];
  const head = trail[0];
  return (
    layers
      .map(
        ([fraction, width, opacity]) =>
          `<path d="${fmt(cut(fraction))}" stroke="${colour}" stroke-width="${width.toFixed(1)}" stroke-opacity="${opacity}"/>`,
      )
      .join('') +
    `<circle cx="${head[0].toFixed(1)}" cy="${head[1].toFixed(1)}" r="${(w * 0.62).toFixed(1)}" fill="${colour}" stroke="none"/>`
  );
}

/**
 * @param {object} opts
 * @param {number} opts.width  @param {number} opts.height
 * @param {'night'|'day'} [opts.theme]
 * @param {number} [opts.lonSpan]  degrees of longitude across the plate
 * @param {boolean} [opts.chrome]  draw the app's panels over the map
 * @param {number} [opts.dots]     roughly how many vehicles to place
 */
export function mapPlate({
  width,
  height,
  theme = 'night',
  centre = CHARING_CROSS,
  lonSpan = 0.3,
  chrome = false,
  dots = 1100,
  seed = 7,
  glyph = 'dot',
  trails = false,
  trailLength = 34,
}) {
  const project = projector({ width, height, centre, lonSpan });
  const margin = 40;
  const inside = ([x, y]) =>
    x > -margin && x < width + margin && y > -margin && y < height + margin;

  const night = theme === 'night';
  const bus = { stroke: night ? '#2a3346' : '#d8d3cc', width: 1.1, opacity: night ? 0.85 : 0.9 };
  const railWidth = Math.max(1.6, width / 700);

  const busPaths = [];
  const railPaths = [];
  const vehicles = [];
  const rnd = mulberry32(seed);

  for (const feature of routes) {
    const { mode } = feature.properties;
    const rail = isRail(mode);
    const colour = colorForMode(mode);
    const lines =
      feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];

    for (const line of lines) {
      for (const run of clipRuns(line.map(project), inside)) {
        const simplified = decimate(run, rail ? 1.2 : 2);
        if (!simplified) continue;
        (rail ? railPaths : busPaths).push({ d: fmt(simplified), colour });

        // Vehicles: one every so many kept points, jittered off the centreline
        // so the two directions of a route do not stack into one dotted line.
        const step = rail ? 7 : 26;
        for (let i = 2; i < simplified.length; i += step) {
          if (rnd() > 0.55) continue;
          const [x, y] = simplified[i];
          // Heading from the local tangent. TfL gives no bearing, and the app
          // derives one the same way — from the geometry either side.
          const [px, py] = simplified[i - 1];
          const [nx, ny] = simplified[Math.min(i + 1, simplified.length - 1)];
          vehicles.push({
            x: x + (rnd() - 0.5) * 3,
            y: y + (rnd() - 0.5) * 3,
            heading: Math.atan2(ny - py, nx - px),
            trail: walkBack(simplified, i, trailLength),
            colour,
            rail,
          });
        }
      }
    }
  }

  // Thin to the requested count, keeping the mix rather than the first N.
  const keep = Math.min(1, dots / vehicles.length);
  const shown = vehicles.filter(() => rnd() < keep);
  const r = Math.max(2.2, width / 430);

  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  svg.push(`<rect width="${width}" height="${height}" fill="${night ? APP.bg : '#f2efe9'}"/>`);

  // Bus network first as texture, rail over it as the readable structure.
  svg.push(`<g fill="none" stroke="${bus.stroke}" stroke-width="${bus.width}" stroke-opacity="${bus.opacity}" stroke-linecap="round">`);
  for (const p of busPaths) svg.push(`<path d="${p.d}"/>`);
  svg.push('</g>');

  svg.push(`<g fill="none" stroke-width="${railWidth}" stroke-opacity="${night ? 0.9 : 0.75}" stroke-linecap="round" stroke-linejoin="round">`);
  for (const p of railPaths) svg.push(`<path d="${p.d}" stroke="${p.colour}"/>`);
  svg.push('</g>');

  // Streaks carry their own head, so they replace the marker pass entirely.
  if (glyph === 'streak') {
    svg.push('<g fill="none" stroke-linecap="round" stroke-linejoin="round">');
    for (const v of shown) svg.push(streak(v.trail, v.colour, v.rail ? r * 1.5 : r * 1.05));
    svg.push('</g>');
  }

  // Trails first, so every arrowhead sits on top of its own tail.
  if (trails && glyph !== 'streak') {
    svg.push(`<g fill="none" stroke-linecap="round">`);
    for (const v of shown) {
      if (!v.trail) continue;
      svg.push(`<path d="${fmt(v.trail)}" stroke="${v.colour}" stroke-width="${(r * 0.9).toFixed(1)}" stroke-opacity="0.42"/>`);
    }
    svg.push('</g>');
  }

  // Vehicles. The halo is what makes the swarm read as lit rather than printed;
  // deck.gl gets it from additive blending, which SVG has no equivalent for.
  if (night && glyph === 'dot') {
    svg.push('<g>');
    for (const v of shown)
      svg.push(`<circle cx="${v.x.toFixed(1)}" cy="${v.y.toFixed(1)}" r="${(r * 2.4).toFixed(1)}" fill="${v.colour}" opacity="0.16"/>`);
    svg.push('</g>');
  }
  svg.push('<g>');
  for (const v of shown) {
    if (glyph === 'streak') {
      continue;
    } else if (glyph === 'arrow') {
      svg.push(`<path d="${arrowHead(v.x, v.y, v.heading, (v.rail ? r * 2.6 : r * 2.1))}" fill="${v.colour}" stroke="${night ? '#0b0f1a' : '#ffffff'}" stroke-width="${(r * 0.3).toFixed(2)}" stroke-linejoin="round"/>`);
    } else {
      svg.push(`<circle cx="${v.x.toFixed(1)}" cy="${v.y.toFixed(1)}" r="${(v.rail ? r * 1.25 : r).toFixed(1)}" fill="${v.colour}" stroke="${night ? '#0b0f1a' : '#ffffff'}" stroke-width="${(r * 0.35).toFixed(2)}"/>`);
    }
  }
  svg.push('</g>');

  if (chrome) svg.push(appChrome({ width, height }));
  svg.push('</svg>');
  return svg.join('');
}

/**
 * The app's own floating panels, simplified: sidebar with search and mode
 * filters, status bar bottom-right. Same tokens as App.css — translucent navy,
 * hairline border, 12px radius — so a framed plate reads as the real product.
 *
 * Drawn in the design units of a 1290px-wide phone plate and scaled to fit,
 * so the chrome keeps its proportions on a wide feature graphic too.
 */
function appChrome({ width, height }) {
  const k = width / 1290;
  const W = width / k;
  const H = height / k;
  const edge = 44;
  const sidebarW = Math.min(600, W - edge * 2);
  const sans = 'Inter, Helvetica, sans-serif';
  const panel = (x, y, w, h, r) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${APP.panel}" stroke="${APP.panelBorder}" stroke-width="2"/>`;

  const out = [`<g transform="scale(${k.toFixed(4)})">`];

  out.push(panel(edge, edge, sidebarW, 470, 36));
  out.push(`<text x="${edge + 36}" y="${edge + 74}" font-family="${sans}" font-weight="600" font-size="40" fill="${APP.text}">Watch London Move</text>`);
  out.push(`<rect x="${edge + 34}" y="${edge + 104}" width="${sidebarW - 68}" height="78" rx="24" fill="rgba(255,255,255,0.05)" stroke="${APP.panelBorder}" stroke-width="2"/>`);
  out.push(`<text x="${edge + 58}" y="${edge + 155}" font-family="${sans}" font-size="32" fill="${APP.textDim}">Search a route or line</text>`);

  FILTERS.forEach(([label, colour], i) => {
    const y = edge + 240 + i * 42;
    out.push(`<circle cx="${edge + 52}" cy="${y - 10}" r="11" fill="${colour}"/>`);
    out.push(`<text x="${edge + 78}" y="${y}" font-family="${sans}" font-size="30" fill="${APP.text}">${label}</text>`);
  });

  const statusW = 430;
  const statusH = 78;
  const sx = W - edge - statusW;
  const sy = H - edge - statusH;
  out.push(panel(sx, sy, statusW, statusH, 26));
  out.push(`<circle cx="${sx + 40}" cy="${sy + statusH / 2}" r="10" fill="${APP.connected}"/>`);
  out.push(`<text x="${sx + 66}" y="${sy + statusH / 2 + 11}" font-family="${sans}" font-size="28" fill="${APP.textDim}">Live · 6,431 vehicles</text>`);

  out.push('</g>');
  return out.join('');
}
