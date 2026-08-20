/**
 * Store artwork, flow suite — smooth line trails, and an icon of staggered
 * streaks entering from the left.
 *
 *   node scripts/store-assets/samples-flow.mjs   # writes store/samples-flow/
 *
 * The motif is motion rather than markers: a vehicle is the stretch of road it
 * has just covered, thickening and brightening into a head at the front. The
 * icon is the same idea reduced to six lines running in from the left edge,
 * each in a real line colour, each a different distance along — the point being
 * that they are independent vehicles, not a bar chart, so the heads are
 * deliberately not in ascending order.
 */
import '../lib/fonts.mjs'; // must come first: sets FONTCONFIG_FILE before sharp loads
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, PAPER, MODE_PALETTE, TUBE_PALETTE, forDark } from '../lib/palette.mjs';
import { mapPlate } from '../lib/map-plate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const sharp = createRequire(join(root, 'frontend', 'package.json'))('sharp');

const OUT = join(root, 'store', 'explorations', 'flow');
const PHONE = { width: 1290, height: 2796 };
const FEATURE = { width: 1024, height: 500 };
const ICON = 512;

const png = (svg) => sharp(Buffer.from(svg)).png();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const SANS = 'Inter, Helvetica, sans-serif';
const SERIF = 'Arvo, serif';
const MONO = 'Geist Mono, monospace';

/**
 * The line colours, in the order the app's own sidebar lists its six modes:
 * bus red, Underground navy, Overground orange, DLR teal, tram green,
 * Elizabeth purple. These are the service's identity as the product already
 * uses it, which is the point — someone who knows London should recognise the
 * icon before they read the name.
 *
 * `LINES` is the dark-ground set, where the Underground navy is lifted off the
 * background (see liftToFloor). `LINES_LIGHT` is the true brand hex, which only
 * works on paper.
 */
const LINES = forDark(MODE_PALETTE);
const LINES_LIGHT = MODE_PALETTE;

/**
 * How far along each streak's head sits, as a fraction of the run.
 *
 * Deliberately not ascending. A monotonic staircase reads as a chart; scattered
 * heads read as six vehicles that happen to be at different points of their
 * journeys, which is the thing the app actually shows.
 */
const STAGGER = [0.88, 0.55, 0.99, 0.47, 0.79, 0.66];

/**
 * One tapered streak from (x0,y) to (x1,y): three flat strokes over the same
 * run — long and faint, then shorter and heavier — plus a round head.
 * `bow` bends it into a shallow curve, the way real route geometry never runs
 * dead straight.
 */
function streak({ x0, x1, y, weight, colour, bow = 0, head = true }) {
  const run = x1 - x0;
  const path = (from) =>
    bow
      ? `M${from} ${y + bow} Q${(from + x1) / 2} ${y + bow * 0.35} ${x1} ${y}`
      : `M${from} ${y}H${x1}`;
  const layers = [
    [0, weight * 0.62, 0.26],
    [0.5, weight * 0.84, 0.55],
    [0.78, weight, 1],
  ];
  return (
    layers
      .map(
        ([start, w, opacity]) =>
          `<path d="${path(x0 + run * start)}" fill="none" stroke="${colour}" stroke-width="${w.toFixed(2)}" stroke-opacity="${opacity}" stroke-linecap="round"/>`,
      )
      .join('') +
    (head ? `<circle cx="${x1.toFixed(2)}" cy="${y.toFixed(2)}" r="${(weight * 0.62).toFixed(2)}" fill="${colour}"/>` : '')
  );
}

/** A field of streaks running in from the left of a box. */
function streakBand({ x, y, width, height, count = 6, weight, bow = 0, colours = LINES, alternate = true, flat = true }) {
  const spacing = height / (count - 1 || 1);
  return Array.from({ length: count }, (_, i) => {
    const y1 = y + i * spacing;
    const x1 = x + width * STAGGER[i % STAGGER.length];
    const colour = colours[i % colours.length];
    const curve = alternate ? bow * (i % 2 ? -1 : 1) : bow;
    if (!flat) return streak({ x0: x, x1, y: y1, weight, colour, bow: curve });
    const d = curve
      ? `M${x} ${y1 + curve} Q${(x + x1) / 2} ${y1 + curve * 0.35} ${x1} ${y1}`
      : `M${x} ${y1}H${x1}`;
    return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${weight}" stroke-linecap="round"/>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * The icon: six streaks running in from the left edge, one per mode, each a
 * different distance along.
 *
 * @param {object} opts
 * @param {string[]} opts.colours
 * @param {'dark'|'light'} [opts.ground]
 * @param {boolean} [opts.bleed] run off the left edge, or inset to the
 *   maskable safe zone an Android launcher guarantees.
 */
function iconStreaks({ colours, ground = 'dark', bleed = true }) {
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
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${ground === 'light' ? PAPER.chalk : APP.bg}"/>${body}</svg>`
  );
}

// ---------------------------------------------------------------------------
// I — Flow, dark. The product shot: every vehicle drawn as its own trail.
// ---------------------------------------------------------------------------

async function flowDarkPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const plate = mapPlate({
    ...PHONE,
    theme: 'night',
    lonSpan,
    chrome: true,
    dots: 850,
    seed,
    glyph: 'streak',
    trailLength: 120,
  });
  const lines = caption.split('\n');
  const overlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<defs><linearGradient id="s" x1="0" y1="1" x2="0" y2="0">` +
    `<stop offset="0" stop-color="#0b0f1a" stop-opacity="0"/><stop offset="0.5" stop-color="#0b0f1a" stop-opacity="0.94"/></linearGradient></defs>` +
    `<rect x="0" y="${PHONE.height - 820}" width="${PHONE.width}" height="820" fill="url(#s)"/>` +
    streakBand({ x: 0, y: PHONE.height - 560, width: 560, height: 0, count: 1, weight: 10, colours: [APP.accent] }) +
    `<text x="72" y="${PHONE.height - 470}" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="5" fill="${APP.accent}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="72" y="${PHONE.height - 350 + i * 102}" font-family="${SERIF}" font-weight="700" font-size="84" fill="#ffffff">${esc(line)}</text>`,
      )
      .join('') +
    streakBand({ x: 72, y: PHONE.height - 150, width: 420, height: 0, count: 1, weight: 12 }) +
    '</svg>';
  return sharp(Buffer.from(plate)).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}

async function flowDarkFeature() {
  const plate = mapPlate({
    ...FEATURE,
    theme: 'night',
    lonSpan: 0.3,
    dots: 560,
    seed: 4,
    glyph: 'streak',
    trailLength: 90,
  });
  const overlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0b0f1a" stop-opacity="0.96"/><stop offset="0.62" stop-color="#0b0f1a" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="url(#g)"/>` +
    streakBand({ x: 0, y: 118, width: 300, height: 0, count: 1, weight: 9, colours: [APP.accent] }) +
    `<text x="54" y="212" font-family="${SERIF}" font-weight="700" font-size="60" fill="#ffffff">Watch London</text>` +
    `<text x="54" y="280" font-family="${SERIF}" font-weight="700" font-size="60" fill="#ffffff">Move</text>` +
    `<text x="56" y="336" font-family="${MONO}" font-weight="700" font-size="20" letter-spacing="4" fill="${APP.textDim}">LIVE · EVERY MODE</text>` +
    streakBand({ x: 56, y: 386, width: 300, height: 60, count: 4, weight: 7 }) +
    '</svg>';
  return sharp(Buffer.from(plate)).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// J — Flow, paper. The streak band as the graphic, the app underneath it.
// ---------------------------------------------------------------------------

async function flowPaperPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const plateW = PHONE.width - 120;
  const plateH = 1560;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plateW}" height="${plateH}"><rect width="${plateW}" height="${plateH}" rx="28" fill="#fff"/></svg>`,
  );
  const plate = await sharp(
    Buffer.from(
      mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan, chrome: true, dots: 900, seed, glyph: 'streak', trailLength: 110 }),
    ),
  )
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const lines = caption.split('\n');
  const top = 1030;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${PAPER.chalk}"/>` +
    streakBand({ x: 0, y: 210, width: 620, height: 210, count: 6, weight: 17, colours: LINES_LIGHT }) +
    `<text x="60" y="580" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="5" fill="${PAPER.muted}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="60" y="${700 + i * 106}" font-family="${SERIF}" font-weight="700" font-size="86" fill="${PAPER.ink}">${esc(line)}</text>`,
      )
      .join('') +
    `<rect x="59" y="${top - 1}" width="${plateW + 2}" height="${plateH + 2}" rx="29" fill="none" stroke="${PAPER.inputBorder}" stroke-width="2"/>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: plate, left: 60, top }]).png().toBuffer();
}

async function flowPaperFeature() {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${PAPER.chalk}"/>` +
    streakBand({ x: 0, y: 96, width: 470, height: 300, count: 6, weight: 20, colours: LINES_LIGHT }) +
    `<text x="560" y="212" font-family="${SERIF}" font-weight="700" font-size="58" fill="${PAPER.ink}">Watch London</text>` +
    `<text x="560" y="278" font-family="${SERIF}" font-weight="700" font-size="58" fill="${PAPER.ink}">Move</text>` +
    `<text x="562" y="336" font-family="${MONO}" font-weight="700" font-size="19" letter-spacing="4" fill="${PAPER.muted}">6,500 VEHICLES · LIVE · ALL MODES</text>` +
    '</svg>';
  return png(svg).toBuffer();
}

// ---------------------------------------------------------------------------
// K — Flow, poster. No map at all: the streaks carry the whole frame.
// ---------------------------------------------------------------------------

async function flowPosterPhone({ index, eyebrow, caption }) {
  const lines = caption.split('\n');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${APP.bg}"/>` +
    // A deep field of streaks, weighted so the six brand colours lead and the
    // rest fall back into texture.
    `<g opacity="0.3">${streakBand({ x: 0, y: 260, width: PHONE.width - 90, height: 2260, count: 34, weight: 8, bow: 30, alternate: false })}</g>` +
    streakBand({ x: 0, y: 900, width: PHONE.width - 150, height: 820, count: 6, weight: 28, bow: 40, alternate: false }) +
    `<text x="72" y="640" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="5" fill="${APP.accent}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="72" y="${2100 + i * 104}" font-family="${SERIF}" font-weight="700" font-size="86" fill="#ffffff">${esc(line)}</text>`,
      )
      .join('') +
    `<text x="74" y="${2340}" font-family="${SANS}" font-size="36" fill="${APP.textDim}">Bus · Tube · Overground · DLR · Tram · Elizabeth</text>` +
    '</svg>';
  return png(svg).toBuffer();
}

async function flowPosterFeature() {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${APP.bg}"/>` +
    `<g opacity="0.28">${streakBand({ x: 0, y: 40, width: 940, height: 430, count: 22, weight: 5, bow: 16, alternate: false })}</g>` +
    streakBand({ x: 0, y: 150, width: 620, height: 210, count: 6, weight: 15, bow: 20, alternate: false }) +
    `<text x="600" y="238" font-family="${SERIF}" font-weight="700" font-size="56" fill="#ffffff">Watch London</text>` +
    `<text x="600" y="302" font-family="${SERIF}" font-weight="700" font-size="56" fill="#ffffff">Move</text>` +
    `<text x="602" y="356" font-family="${MONO}" font-weight="700" font-size="19" letter-spacing="4" fill="${APP.textDim}">LIVE · ALL MODES</text>` +
    '</svg>';
  return png(svg).toBuffer();
}

// ---------------------------------------------------------------------------

const CAPTIONS = [
  { eyebrow: 'LIVE NOW', caption: '6,500 vehicles,\nall moving at once.', lonSpan: 0.13, seed: 11 },
  { eyebrow: 'THE FLEET', caption: 'Every bus, tube\nand tram, in motion.', lonSpan: 0.09, seed: 23 },
];

async function main() {
  // Own the output directory outright: a renamed variant left behind from a
  // previous run is worse than no sample at all, because it still looks current.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const written = [];
  const write = async (name, buffer) => {
    await writeFile(join(OUT, name), buffer);
    written.push([name, buffer.length]);
    return buffer;
  };

  const ICONS = [
    ['icon-1-modes.png', { colours: MODE_PALETTE }],
    ['icon-2-modes-lifted.png', { colours: LINES }],
    ['icon-3-modes-paper.png', { colours: LINES_LIGHT, ground: 'light' }],
    ['icon-4-tube.png', { colours: forDark(TUBE_PALETTE) }],
    ['icon-5-tube-paper.png', { colours: TUBE_PALETTE, ground: 'light' }],
    ['icon-6-modes-inset.png', { colours: LINES, bleed: false }],
  ];
  const iconBuffers = [];
  for (const [name, opts] of ICONS) {
    iconBuffers.push(await write(name, await png(iconStreaks(opts)).toBuffer()));
  }

  const i1 = await write('I-dark-phone.png', await flowDarkPhone({ index: 1, ...CAPTIONS[0] }));
  await write('I-dark-phone-2.png', await flowDarkPhone({ index: 2, ...CAPTIONS[1] }));
  await write('I-dark-feature.png', await flowDarkFeature());

  const j1 = await write('J-paper-phone.png', await flowPaperPhone({ index: 1, ...CAPTIONS[0] }));
  await write('J-paper-phone-2.png', await flowPaperPhone({ index: 2, ...CAPTIONS[1] }));
  await write('J-paper-feature.png', await flowPaperFeature());

  const k1 = await write('K-poster-phone.png', await flowPosterPhone({ index: 1, ...CAPTIONS[0] }));
  await write('K-poster-feature.png', await flowPosterFeature());

  // Icon legibility strip: 512 master, then the sizes a store list actually
  // renders — a Play search row is about 56px on a phone.
  const big = 200;
  const mid = 96;
  const small = 56;
  const pad = 26;
  const col = big + pad;
  const row2 = pad + big + 16;
  const labelY = row2 + mid + 38;
  const stripW = pad + ICONS.length * col;
  const stripH = labelY + 24;
  const strip =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${stripW}" height="${stripH}">` +
    `<rect width="${stripW}" height="${stripH}" fill="#e9e6e0"/>` +
    ICONS.map(
      ([name], i) =>
        `<text x="${pad + i * col}" y="${labelY}" font-family="${MONO}" font-weight="700" font-size="18" letter-spacing="1" fill="${PAPER.muted}">${name.replace('icon-', '').replace('.png', '').toUpperCase()}</text>`,
    ).join('') +
    '</svg>';
  const tiles = [];
  for (const [i, buffer] of iconBuffers.entries()) {
    const left = pad + i * col;
    tiles.push({ input: await sharp(buffer).resize(big, big).png().toBuffer(), left, top: pad });
    tiles.push({ input: await sharp(buffer).resize(mid, mid).png().toBuffer(), left, top: row2 });
    tiles.push({ input: await sharp(buffer).resize(small, small).png().toBuffer(), left: left + mid + 14, top: row2 });
  }
  await write(
    'icon-sizes.png',
    await sharp(Buffer.from(strip)).composite(tiles).png().toBuffer(),
  );

  const thumbW = 300;
  const thumbH = Math.round((PHONE.height / PHONE.width) * thumbW);
  const gap = 28;
  const labels = ['I · dark', 'J · paper', 'K · poster'];
  const thumbs = await Promise.all([i1, j1, k1].map((b) => sharp(b).resize(thumbW, thumbH).png().toBuffer()));
  const sheetW = gap + (thumbW + gap) * 3;
  const sheetH = thumbH + gap * 2 + 60;
  const sheet =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">` +
    `<rect width="${sheetW}" height="${sheetH}" fill="#e9e6e0"/>` +
    labels
      .map(
        (label, i) =>
          `<text x="${gap + i * (thumbW + gap)}" y="${thumbH + gap + 46}" font-family="${MONO}" font-weight="700" font-size="22" letter-spacing="2" fill="${PAPER.muted}">${label.toUpperCase()}</text>`,
      )
      .join('') +
    '</svg>';
  await write(
    'contact-sheet.png',
    await sharp(Buffer.from(sheet))
      .composite(thumbs.map((input, i) => ({ input, left: gap + i * (thumbW + gap), top: gap })))
      .png()
      .toBuffer(),
  );

  for (const [name, bytes] of written) console.log(`${name.padEnd(24)} ${(bytes / 1024).toFixed(0)} kB`);
  console.log(`\n${written.length} files → ${OUT}`);
}

await main();
