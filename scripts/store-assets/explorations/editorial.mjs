/**
 * Sample store artwork, four aesthetic directions side by side.
 *
 *   node scripts/store-assets/samples.mjs   # writes store/samples/
 *
 * Each direction gets a Play feature graphic (1024x500) and an iOS 6.7"
 * screenshot (1290x2796), plus three app-icon treatments and a contact sheet
 * that shows the four phone shots at the size a store grid actually renders
 * them — which is where most of these decisions are really made.
 *
 * Nothing here is wired into a release yet. It exists to pick a direction.
 */
import '../lib/fonts.mjs'; // must come first: sets FONTCONFIG_FILE before sharp loads
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, PAPER, BUS_RED, MODE_COLORS, FILTERS } from '../lib/palette.mjs';
import { mapPlate } from '../lib/map-plate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
// sharp lives in the frontend workspace; this script is repo-level.
const sharp = createRequire(join(root, 'frontend', 'package.json'))('sharp');

const OUT = join(root, 'store', 'explorations', 'editorial');
const PHONE = { width: 1290, height: 2796 }; // App Store 6.7"
const FEATURE = { width: 1024, height: 500 }; // Play feature graphic
const ICON = 512;

const png = (svg) => sharp(Buffer.from(svg)).png();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Rounded-corner clip of a rendered plate, as a compositable PNG buffer. */
async function roundedPlate(svg, width, height, radius) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`,
  );
  return sharp(Buffer.from(svg))
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// A — Night city. The app, unretouched, caption in its own panel treatment.
// ---------------------------------------------------------------------------

async function nightPhone(caption) {
  const plate = mapPlate({ ...PHONE, theme: 'night', lonSpan: 0.16, chrome: true, dots: 1400, seed: 11 });
  const band =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect x="70" y="1900" width="1150" height="300" rx="36" fill="rgba(11,15,26,0.9)" stroke="${APP.panelBorder}" stroke-width="2"/>` +
    caption
      .split('\n')
      .map(
        (line, i) =>
          `<text x="120" y="${2010 + i * 92}" font-family="Inter, Helvetica, sans-serif" font-weight="600" font-size="72" fill="${APP.text}">${esc(line)}</text>`,
      )
      .join('') +
    '</svg>';
  return sharp(Buffer.from(plate)).composite([{ input: Buffer.from(band) }]).png().toBuffer();
}

async function nightFeature() {
  const plate = mapPlate({ ...FEATURE, theme: 'night', lonSpan: 0.42, dots: 900, seed: 3 });
  const overlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="url(#g)"/>` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0b0f1a" stop-opacity="0.95"/><stop offset="0.62" stop-color="#0b0f1a" stop-opacity="0"/></linearGradient></defs>` +
    `<circle cx="86" cy="176" r="30" fill="none" stroke="${APP.accent}" stroke-width="6"/>` +
    `<rect x="53" y="171" width="66" height="11" rx="5.5" fill="${APP.text}"/>` +
    `<text x="140" y="190" font-family="Inter, Helvetica, sans-serif" font-weight="700" font-size="54" fill="${APP.text}">Watch London Move</text>` +
    `<text x="56" y="286" font-family="Inter, Helvetica, sans-serif" font-size="30" fill="${APP.textDim}">Every bus, tube, DLR and tram,</text>` +
    `<text x="56" y="330" font-family="Inter, Helvetica, sans-serif" font-size="30" fill="${APP.textDim}">live on one map.</text>` +
    '</svg>';
  return sharp(Buffer.from(plate)).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// B — Editorial timetable. Chalk paper, Arvo caption, mono micro-label.
// ---------------------------------------------------------------------------

async function paperPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const plateW = PHONE.width - 120;
  const plateH = 1700;
  const plate = await roundedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan, chrome: true, dots: 1200, seed }),
    plateW,
    plateH,
    28,
  );
  const lines = caption.split('\n');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${PAPER.chalk}"/>` +
    `<text x="60" y="300" font-family="Geist Mono, monospace" font-weight="700" font-size="34" letter-spacing="5" fill="${PAPER.muted}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="60" y="${420 + i * 108}" font-family="Arvo, serif" font-weight="700" font-size="88" fill="${PAPER.ink}">${esc(line)}</text>`,
      )
      .join('') +
    `<rect x="59" y="${700 + (lines.length - 2) * 108}" width="${plateW + 2}" height="${plateH + 2}" rx="29" fill="none" stroke="${PAPER.inputBorder}" stroke-width="2"/>` +
    // Line-colour chips along the foot: the palette as a printed key.
    FILTERS.map(([, colour], i) => `<rect x="${60 + i * 60}" y="${PHONE.height - 190}" width="44" height="14" rx="7" fill="${colour}"/>`).join('') +
    `<text x="60" y="${PHONE.height - 120}" font-family="Geist Mono, monospace" font-size="26" letter-spacing="3" fill="${PAPER.dim}">BUS · TUBE · OVERGROUND · DLR · TRAM · ELIZABETH</text>` +
    '</svg>';
  return sharp(Buffer.from(svg))
    .composite([{ input: plate, left: 60, top: 701 + (lines.length - 2) * 108 }])
    .png()
    .toBuffer();
}

async function paperFeature() {
  const plateW = 460;
  const plateH = 404;
  const plate = await roundedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan: 0.14, dots: 700, seed: 5 }),
    plateW,
    plateH,
    18,
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${PAPER.chalk}"/>` +
    `<text x="56" y="120" font-family="Geist Mono, monospace" font-weight="700" font-size="20" letter-spacing="4" fill="${PAPER.muted}">LIVE  ·  LONDON  ·  ALL MODES</text>` +
    `<text x="54" y="220" font-family="Arvo, serif" font-weight="700" font-size="66" fill="${PAPER.ink}">Watch London</text>` +
    `<text x="54" y="292" font-family="Arvo, serif" font-weight="700" font-size="66" fill="${PAPER.ink}">Move</text>` +
    `<line x1="56" y1="340" x2="490" y2="340" stroke="${PAPER.border}" stroke-width="2"/>` +
    `<text x="56" y="392" font-family="Arvo, serif" font-size="26" fill="${PAPER.muted}">6,500 vehicles, drawn where they are now.</text>` +
    FILTERS.map(([, colour], i) => `<rect x="${56 + i * 42}" y="428" width="30" height="10" rx="5" fill="${colour}"/>`).join('') +
    `<rect x="${FEATURE.width - plateW - 47}" y="47" width="${plateW + 2}" height="${plateH + 2}" rx="19" fill="none" stroke="${PAPER.inputBorder}" stroke-width="2"/>` +
    '</svg>';
  return sharp(Buffer.from(svg))
    .composite([{ input: plate, left: FEATURE.width - plateW - 46, top: 48 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// C — Departure board. Dot-matrix caption over near-black.
// ---------------------------------------------------------------------------

/** Punch a dot grid through a rendered text layer, the way a real matrix sign
 *  only lights discrete lamps. dest-in keeps the glyph only where a dot is. */
async function dotMatrix(svg, width, height, pitch = 9, radius = 3.4) {
  const dots =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="p" width="${pitch}" height="${pitch}" patternUnits="userSpaceOnUse">` +
    `<circle cx="${pitch / 2}" cy="${pitch / 2}" r="${radius}" fill="#fff"/></pattern></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#p)"/></svg>`;
  return sharp(Buffer.from(svg))
    .composite([{ input: Buffer.from(dots), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function boardPhone({ route, dest, mins, caption, seed }) {
  const plateW = PHONE.width - 96;
  const plateH = PHONE.height - 780 - 48;
  const plate = await roundedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan: 0.11, chrome: true, dots: 1100, seed }),
    plateW,
    plateH,
    20,
  );
  const boardText =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="420">` +
    `<text x="60" y="150" font-family="Geist Mono, monospace" font-weight="700" font-size="96" fill="${PAPER.amber}">${esc(route)}</text>` +
    `<text x="330" y="150" font-family="Geist Mono, monospace" font-weight="500" font-size="76" fill="${PAPER.amber}">${esc(dest)}</text>` +
    `<text x="60" y="270" font-family="Geist Mono, monospace" font-weight="700" font-size="76" fill="${APP.accent}">${esc(mins)}</text>` +
    '</svg>';
  const matrix = await dotMatrix(boardText, PHONE.width, 420);
  const base =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="#08090c"/>` +
    `<rect x="40" y="150" width="${PHONE.width - 80}" height="420" rx="14" fill="#101216" stroke="#23262e" stroke-width="2"/>` +
    `<text x="60" y="700" font-family="Geist Mono, monospace" font-weight="600" font-size="46" letter-spacing="2" fill="#e6eaf2">${esc(caption)}</text>` +
    `<rect x="47" y="779" width="${plateW + 2}" height="${plateH + 2}" rx="21" fill="none" stroke="#23262e" stroke-width="2"/>` +
    '</svg>';
  return sharp(Buffer.from(base))
    .composite([
      { input: matrix, left: 0, top: 190 },
      { input: plate, left: 48, top: 780 },
    ])
    .png()
    .toBuffer();
}

async function boardFeature() {
  const strip =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="220">` +
    `<text x="40" y="90" font-family="Geist Mono, monospace" font-weight="700" font-size="64" fill="${PAPER.amber}">WATCH LONDON MOVE</text>` +
    `<text x="40" y="175" font-family="Geist Mono, monospace" font-weight="500" font-size="42" fill="${APP.accent}">LIVE · ALL MODES · NOW</text>` +
    '</svg>';
  const matrix = await dotMatrix(strip, FEATURE.width, 220, 7, 2.6);
  const base =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="#08090c"/>` +
    `<rect x="28" y="120" width="${FEATURE.width - 56}" height="260" rx="12" fill="#101216" stroke="#23262e" stroke-width="2"/>` +
    '</svg>';
  return sharp(Buffer.from(base)).composite([{ input: matrix, left: 20, top: 160 }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// D — Line-colour ribbon. One flat TfL hue per shot.
// ---------------------------------------------------------------------------

async function ribbonPhone({ colour, caption, lonSpan, seed }) {
  const plateW = PHONE.width - 200;
  const plateH = 1560;
  const plate = await roundedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan, chrome: true, dots: 1100, seed }),
    plateW,
    plateH,
    40,
  );
  const lines = caption.split('\n');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${colour}"/>` +
    lines
      .map(
        (line, i) =>
          `<text x="100" y="${360 + i * 104}" font-family="Arvo, serif" font-weight="700" font-size="82" fill="#ffffff">${esc(line)}</text>`,
      )
      .join('') +
    '</svg>';
  return sharp(Buffer.from(svg))
    .composite([{ input: plate, left: 100, top: 760 }])
    .png()
    .toBuffer();
}

async function ribbonFeature() {
  const bands = FILTERS.map(
    ([, colour], i) =>
      `<rect x="${(i * FEATURE.width) / 6}" y="0" width="${FEATURE.width / 6 + 1}" height="${FEATURE.height}" fill="${colour}"/>`,
  ).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    bands +
    `<rect x="60" y="150" width="904" height="200" rx="16" fill="#0b0f1a"/>` +
    `<text x="100" y="245" font-family="Arvo, serif" font-weight="700" font-size="58" fill="#ffffff">Watch London Move</text>` +
    `<text x="102" y="300" font-family="Inter, Helvetica, sans-serif" font-size="28" fill="${APP.textDim}">Six modes. One live map.</text>` +
    '</svg>';
  return png(svg).toBuffer();
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const iconCurrent = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" fill="${APP.bg}"/>` +
  `<circle cx="32" cy="32" r="24" fill="none" stroke="${APP.accent}" stroke-width="5"/>` +
  `<rect x="6" y="27.5" width="52" height="9" rx="4.5" fill="${APP.text}"/></svg>`;

/** The bar keeps the roundel silhouette; the ring becomes vehicles on it. */
const iconTrail = () => {
  const beads = [
    [0, MODE_COLORS.central],
    [40, MODE_COLORS.elizabeth],
    [95, MODE_COLORS.dlr],
    [150, MODE_COLORS.victoria],
    [205, MODE_COLORS.tram],
    [255, MODE_COLORS.overground],
    [310, MODE_COLORS.metropolitan],
  ]
    .map(([deg, colour]) => {
      const a = (deg * Math.PI) / 180;
      return `<circle cx="${(32 + 24 * Math.cos(a)).toFixed(2)}" cy="${(32 + 24 * Math.sin(a)).toFixed(2)}" r="4.6" fill="${colour}" stroke="${APP.bg}" stroke-width="1.6"/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${APP.bg}"/>` +
    `<circle cx="32" cy="32" r="24" fill="none" stroke="${APP.accent}" stroke-width="3.4" stroke-opacity="0.45"/>` +
    beads +
    `<rect x="8" y="28.4" width="48" height="7.2" rx="3.6" fill="${APP.text}"/></svg>`
  );
};

/** No roundel: the swarm itself, which is what the app actually looks like. */
const iconSwarm = () => {
  const hues = [
    BUS_RED,
    MODE_COLORS.elizabeth,
    MODE_COLORS.dlr,
    MODE_COLORS.victoria,
    MODE_COLORS.overground,
    MODE_COLORS.tram,
    MODE_COLORS.piccadilly,
    MODE_COLORS.circle,
  ];
  const dots = [];
  let i = 0;
  for (const [radius, count] of [
    [0, 1],
    [8, 6],
    [15.5, 11],
    [22.5, 15],
  ]) {
    for (let n = 0; n < count; n++) {
      const a = (n / count) * Math.PI * 2 + radius * 0.21;
      dots.push(
        `<circle cx="${(32 + radius * Math.cos(a)).toFixed(2)}" cy="${(32 + radius * Math.sin(a)).toFixed(2)}" r="${radius > 20 ? 2.6 : 3.2}" fill="${hues[i++ % hues.length]}"/>`,
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${APP.bg}"/>` +
    dots.join('') +
    '</svg>'
  );
};

// ---------------------------------------------------------------------------

const CAPTIONS = [
  { eyebrow: 'LIVE NOW', caption: 'Every bus, tube\nand tram, moving.', lonSpan: 0.16, seed: 11 },
  { eyebrow: 'THE FLEET', caption: '6,500 vehicles.\nOne live map.', lonSpan: 0.09, seed: 23 },
  { eyebrow: 'FOLLOW', caption: 'Ride along with\nany vehicle.', lonSpan: 0.05, seed: 31 },
  { eyebrow: 'AFTER DARK', caption: 'Watch the network\nbreathe all night.', lonSpan: 0.22, seed: 43 },
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

  // One phone shot per direction, using the first caption, so they compare
  // like for like; plus every caption for the recommended direction.
  const a = await write('A-night-phone.png', await nightPhone(CAPTIONS[0].caption));
  await write('A-night-feature.png', await nightFeature());

  const b = await write('B-paper-phone.png', await paperPhone({ index: 1, ...CAPTIONS[0] }));
  await write('B-paper-feature.png', await paperFeature());
  for (const [i, c] of CAPTIONS.slice(1).entries()) {
    await write(`B-paper-phone-${i + 2}.png`, await paperPhone({ index: i + 2, ...c }));
  }

  const c = await write(
    'C-board-phone.png',
    await boardPhone({
      route: '149',
      dest: 'EDMONTON GRN',
      mins: 'DUE · 2 MIN',
      caption: 'EVERY VEHICLE, EVERY MODE, LIVE',
      seed: 11,
    }),
  );
  await write('C-board-feature.png', await boardFeature());

  const d = await write(
    'D-ribbon-phone.png',
    await ribbonPhone({ colour: BUS_RED, caption: 'Every bus, tube\nand tram, moving.', lonSpan: 0.16, seed: 11 }),
  );
  await write('D-ribbon-feature.png', await ribbonFeature());

  await write('icon-1-current.png', await png(iconCurrent()).toBuffer());
  await write('icon-2-trail.png', await png(iconTrail()).toBuffer());
  await write('icon-3-swarm.png', await png(iconSwarm()).toBuffer());

  // Contact sheet: the four directions at store-grid thumbnail size.
  const thumbW = 300;
  const thumbH = Math.round((PHONE.height / PHONE.width) * thumbW);
  const gap = 28;
  const labels = ['A · night', 'B · paper', 'C · board', 'D · ribbon'];
  const thumbs = await Promise.all(
    [a, b, c, d].map((buf) => sharp(buf).resize(thumbW, thumbH).png().toBuffer()),
  );
  const sheetW = gap + (thumbW + gap) * 4;
  const sheetH = thumbH + gap * 2 + 60;
  const sheetBase =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">` +
    `<rect width="${sheetW}" height="${sheetH}" fill="#e9e6e0"/>` +
    labels
      .map(
        (label, i) =>
          `<text x="${gap + i * (thumbW + gap)}" y="${thumbH + gap + 46}" font-family="Geist Mono, monospace" font-weight="700" font-size="22" letter-spacing="2" fill="${PAPER.muted}">${label.toUpperCase()}</text>`,
      )
      .join('') +
    '</svg>';
  await write(
    'contact-sheet.png',
    await sharp(Buffer.from(sheetBase))
      .composite(thumbs.map((input, i) => ({ input, left: gap + i * (thumbW + gap), top: gap })))
      .png()
      .toBuffer(),
  );

  for (const [name, bytes] of written) {
    console.log(`${name.padEnd(26)} ${(bytes / 1024).toFixed(0)} kB`);
  }
  console.log(`\n${written.length} files → ${OUT}`);
}

await main();
