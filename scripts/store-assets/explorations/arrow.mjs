/**
 * Store artwork, arrow suite — four readings of "arrow".
 *
 *   node scripts/store-assets/samples-arrow.mjs   # writes store/samples-arrow/
 *
 * "Arrow" is a broad brief, so rather than guess once these are four distinct
 * takes on it: the vehicle as a vector, the chevron as a layout system, the
 * arrow as a window onto the map, and the arrow as transport signage. Same
 * plate machinery as the first suite (real route geometry, seeded positions),
 * but every vehicle is now an arrowhead carrying a heading and a trail — which
 * is the point of the motif: the app's subject is 6,500 things going somewhere.
 */
import '../lib/fonts.mjs'; // must come first: sets FONTCONFIG_FILE before sharp loads
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, PAPER, BUS_RED, MODE_COLORS, FILTERS } from '../lib/palette.mjs';
import { mapPlate, arrowHead } from '../lib/map-plate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const sharp = createRequire(join(root, 'frontend', 'package.json'))('sharp');

const OUT = join(root, 'store', 'explorations', 'arrow');
const PHONE = { width: 1290, height: 2796 };
const FEATURE = { width: 1024, height: 500 };
const ICON = 512;

const png = (svg) => sharp(Buffer.from(svg)).png();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const SANS = 'Inter, Helvetica, sans-serif';
const SERIF = 'Arvo, serif';
const MONO = 'Geist Mono, monospace';

/** Clip a rendered plate to an arbitrary path. */
async function maskedPlate(svg, width, height, maskPath) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${maskPath}" fill="#fff"/></svg>`,
  );
  return sharp(Buffer.from(svg)).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

const rect = (w, h, r) => `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;

/** A band whose top edge points up and whose foot is notched to match, so a
 *  stack of them reads as one arrow travelling up the page. */
const chevronBand = (w, h, notch) =>
  `M0 ${notch}L${w / 2} 0L${w} ${notch}V${h}L${w / 2} ${h - notch}L0 ${h}Z`;

/** One large arrow pointing up: full-width head, shaft down the middle. */
const bigArrow = (w, h, headH, shaft) =>
  `M${w / 2} 0L${w} ${headH}H${w / 2 + shaft / 2}V${h}H${w / 2 - shaft / 2}V${headH}H0Z`;

/** Signage arrow pointing right: rounded shaft, triangular head. */
function signArrow(x, y, length, weight, colour) {
  const head = weight * 1.9;
  const shaftEnd = x + length - head;
  return (
    `<rect x="${x}" y="${y - weight / 2}" width="${length - head * 0.6}" height="${weight}" rx="${weight / 2}" fill="${colour}"/>` +
    `<path d="M${x + length} ${y}L${shaftEnd} ${y - head * 0.82}L${shaftEnd} ${y + head * 0.82}Z" fill="${colour}"/>`
  );
}

// ---------------------------------------------------------------------------
// E — Vector field. The swarm as arrowheads and trails, unframed.
// ---------------------------------------------------------------------------

async function vectorPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const plate = mapPlate({
    ...PHONE,
    theme: 'night',
    lonSpan,
    chrome: true,
    dots: 900,
    seed,
    glyph: 'arrow',
    trails: true,
  });
  const lines = caption.split('\n');
  const overlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<defs><linearGradient id="s" x1="0" y1="1" x2="0" y2="0">` +
    `<stop offset="0" stop-color="#0b0f1a" stop-opacity="0"/><stop offset="0.55" stop-color="#0b0f1a" stop-opacity="0.92"/></linearGradient></defs>` +
    `<rect x="0" y="${PHONE.height - 760}" width="${PHONE.width}" height="760" fill="url(#s)"/>` +
    `<text x="72" y="${PHONE.height - 500}" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="5" fill="${APP.accent}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="72" y="${PHONE.height - 380 + i * 102}" font-family="${SERIF}" font-weight="700" font-size="84" fill="#ffffff">${esc(line)}</text>`,
      )
      .join('') +
    signArrow(72, PHONE.height - 170, 300, 14, APP.accent) +
    '</svg>';
  return sharp(Buffer.from(plate)).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}

async function vectorFeature() {
  const plate = mapPlate({
    ...FEATURE,
    theme: 'night',
    lonSpan: 0.34,
    dots: 620,
    seed: 4,
    glyph: 'arrow',
    trails: true,
  });
  const overlay =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0b0f1a" stop-opacity="0.96"/><stop offset="0.66" stop-color="#0b0f1a" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="url(#g)"/>` +
    `<text x="56" y="150" font-family="${MONO}" font-weight="700" font-size="20" letter-spacing="4" fill="${APP.accent}">LIVE VECTORS</text>` +
    `<text x="54" y="238" font-family="${SERIF}" font-weight="700" font-size="60" fill="#ffffff">Watch London</text>` +
    `<text x="54" y="306" font-family="${SERIF}" font-weight="700" font-size="60" fill="#ffffff">Move</text>` +
    signArrow(56, 372, 210, 10, APP.accent) +
    `<text x="56" y="430" font-family="${SANS}" font-size="26" fill="${APP.textDim}">6,500 vehicles, each pointed where it is going.</text>` +
    '</svg>';
  return sharp(Buffer.from(plate)).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// F — Chevron. The arrow as a layout system: stacked bands travelling up.
// ---------------------------------------------------------------------------

async function chevronPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const plateW = PHONE.width - 96;
  const plateH = 1620;
  const notch = 120;
  const plate = await maskedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan, dots: 1050, seed, glyph: 'arrow', trails: true }),
    plateW,
    plateH,
    chevronBand(plateW, plateH, notch),
  );
  const lines = caption.split('\n');
  const top = 900;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${PAPER.chalk}"/>` +
    // The mode palette as a run of chevrons pointing the way the page reads.
    FILTERS.map(([, colour], i) => {
      const y = 168 + i * 34;
      return `<path d="M${72} ${y + 22}L${72 + 46} ${y}L${72 + 92} ${y + 22}" fill="none" stroke="${colour}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="${(1 - i * 0.1).toFixed(2)}"/>`;
    }).join('') +
    `<text x="196" y="248" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="5" fill="${PAPER.muted}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="72" y="${470 + i * 106}" font-family="${SERIF}" font-weight="700" font-size="86" fill="${PAPER.ink}">${esc(line)}</text>`,
      )
      .join('') +
    `<path d="${chevronBand(plateW, plateH, notch)}" transform="translate(48 ${top})" fill="none" stroke="${PAPER.inputBorder}" stroke-width="3"/>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: plate, left: 48, top }]).png().toBuffer();
}

async function chevronFeature() {
  const plateW = 400;
  const plateH = FEATURE.height;
  const notch = 0;
  const plate = await maskedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan: 0.13, dots: 520, seed: 9, glyph: 'arrow', trails: true }),
    plateW,
    plateH,
    `M110 0H${plateW}V${plateH}H110L0 ${plateH / 2}Z`,
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${PAPER.chalk}"/>` +
    FILTERS.map(([, colour], i) => {
      const x = 56 + i * 30;
      return `<path d="M${x} ${118}L${x + 20} ${100}L${x + 40} ${118}" fill="none" stroke="${colour}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('') +
    `<text x="56" y="222" font-family="${SERIF}" font-weight="700" font-size="62" fill="${PAPER.ink}">Watch London</text>` +
    `<text x="56" y="292" font-family="${SERIF}" font-weight="700" font-size="62" fill="${PAPER.ink}">Move</text>` +
    `<text x="58" y="360" font-family="${MONO}" font-weight="700" font-size="20" letter-spacing="4" fill="${PAPER.muted}">EVERY MODE · LIVE · NOW</text>` +
    '</svg>';
  return sharp(Buffer.from(svg))
    .composite([{ input: plate, left: FEATURE.width - plateW, top: 0 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// G — Hero arrow. One enormous arrow, the live map showing through it.
// ---------------------------------------------------------------------------

async function heroPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const w = PHONE.width - 160;
  const h = 1900;
  const plate = await maskedPlate(
    mapPlate({ width: w, height: h, theme: 'night', lonSpan: lonSpan * 0.8, dots: 1250, seed, glyph: 'arrow', trails: true }),
    w,
    h,
    bigArrow(w, h, 620, w * 0.52),
  );
  const lines = caption.split('\n');
  const top = 740;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${PAPER.chalk}"/>` +
    `<text x="80" y="300" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="5" fill="${PAPER.muted}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="80" y="${430 + i * 106}" font-family="${SERIF}" font-weight="700" font-size="86" fill="${PAPER.ink}">${esc(line)}</text>`,
      )
      .join('') +
    `<path d="${bigArrow(w, h, 620, w * 0.52)}" transform="translate(80 ${top})" fill="none" stroke="${PAPER.inputBorder}" stroke-width="3" stroke-linejoin="round"/>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: plate, left: 80, top }]).png().toBuffer();
}

async function heroFeature() {
  const w = 300;
  const h = 420;
  const plate = await maskedPlate(
    mapPlate({ width: w, height: h, theme: 'night', lonSpan: 0.1, dots: 420, seed: 15, glyph: 'arrow', trails: true }),
    w,
    h,
    bigArrow(w, h, 150, w * 0.54),
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${PAPER.chalk}"/>` +
    `<text x="56" y="150" font-family="${MONO}" font-weight="700" font-size="20" letter-spacing="4" fill="${PAPER.muted}">LIVE · LONDON · ALL MODES</text>` +
    `<text x="54" y="240" font-family="${SERIF}" font-weight="700" font-size="64" fill="${PAPER.ink}">Watch London</text>` +
    `<text x="54" y="312" font-family="${SERIF}" font-weight="700" font-size="64" fill="${PAPER.ink}">Move</text>` +
    signArrow(56, 372, 220, 10, PAPER.azure) +
    `<path d="${bigArrow(w, h, 150, w * 0.54)}" transform="translate(${FEATURE.width - w - 90} 40)" fill="none" stroke="${PAPER.inputBorder}" stroke-width="3" stroke-linejoin="round"/>` +
    '</svg>';
  return sharp(Buffer.from(svg))
    .composite([{ input: plate, left: FEATURE.width - w - 90, top: 40 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// H — Wayfinding. The arrow as transport signage.
// ---------------------------------------------------------------------------

async function signPhone({ index, eyebrow, caption, lonSpan, seed, colour }) {
  const plateW = PHONE.width - 96;
  const plateH = 1420;
  const plate = await maskedPlate(
    mapPlate({ width: plateW, height: plateH, theme: 'night', lonSpan, chrome: true, dots: 900, seed, glyph: 'arrow', trails: true }),
    plateW,
    plateH,
    rect(plateW, plateH, 10),
  );
  const lines = caption.split('\n');
  const top = 1280;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="#0d0d10"/>` +
    // The sign panel: colour bar, arrow, destination text — station vocabulary.
    `<rect x="48" y="150" width="${PHONE.width - 96}" height="1020" rx="10" fill="#151519"/>` +
    `<rect x="48" y="150" width="${PHONE.width - 96}" height="18" rx="9" fill="${colour}"/>` +
    signArrow(120, 400, 420, 44, '#ffffff') +
    `<text x="120" y="600" font-family="${MONO}" font-weight="700" font-size="32" letter-spacing="6" fill="${colour}">${esc(eyebrow)}  ·  ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="120" y="${720 + i * 104}" font-family="${SERIF}" font-weight="700" font-size="80" fill="#ffffff">${esc(line)}</text>`,
      )
      .join('') +
    FILTERS.map(([, c], i) => `<rect x="${120 + i * 58}" y="1040" width="42" height="12" rx="6" fill="${c}"/>`).join('') +
    `<rect x="47" y="${top - 1}" width="${plateW + 2}" height="${plateH + 2}" rx="11" fill="none" stroke="#26262c" stroke-width="2"/>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: plate, left: 48, top }]).png().toBuffer();
}

async function signFeature() {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="#0d0d10"/>` +
    `<rect x="0" y="0" width="${FEATURE.width}" height="14" fill="${APP.accent}"/>` +
    signArrow(56, 210, 240, 30, '#ffffff') +
    `<text x="330" y="200" font-family="${SERIF}" font-weight="700" font-size="58" fill="#ffffff">Watch London</text>` +
    `<text x="330" y="266" font-family="${SERIF}" font-weight="700" font-size="58" fill="#ffffff">Move</text>` +
    `<text x="332" y="330" font-family="${MONO}" font-weight="700" font-size="20" letter-spacing="4" fill="${APP.textDim}">LIVE · BUS · TUBE · DLR · TRAM</text>` +
    FILTERS.map(([, c], i) => `<rect x="${332 + i * 52}" y="366" width="38" height="11" rx="5.5" fill="${c}"/>`).join('') +
    '</svg>';
  return png(svg).toBuffer();
}

// ---------------------------------------------------------------------------
// Icons — three arrow marks
// ---------------------------------------------------------------------------

/** The roundel keeps its silhouette; the bar becomes an arrow through it. */
const iconRoundelArrow = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" fill="${APP.bg}"/>` +
  `<circle cx="32" cy="32" r="23" fill="none" stroke="${APP.accent}" stroke-width="5"/>` +
  `<rect x="7" y="28.6" width="40" height="6.8" rx="3.4" fill="${APP.text}"/>` +
  `<path d="M57 32L44 24.6V39.4Z" fill="${APP.text}"/></svg>`;

/** Three chevrons in line colours, travelling up. */
const iconChevrons = () => {
  const hues = [MODE_COLORS.elizabeth, APP.accent, BUS_RED];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${APP.bg}"/>` +
    hues
      .map(
        (colour, i) =>
          `<path d="M14 ${44 + i * 0 - i * -0}L14 ${44 - i * 13}" fill="none"/><path d="M14 ${46 - i * 13}L32 ${30 - i * 13}L50 ${46 - i * 13}" fill="none" stroke="${colour}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join('') +
    '</svg>'
  );
};

/** A single vehicle as a comet: arrowhead plus the road behind it. The tail is
 *  three strokes of the same curve rather than a gradient, which librsvg
 *  renders identically at every icon size. */
const iconComet = () => {
  const curve = 'M11 53C21 47 29 37 42 21';
  const tail = [
    [5.6, 0.16],
    [3.6, 0.34],
    [2.0, 0.62],
  ]
    .map(
      ([width, opacity]) =>
        `<path d="${curve}" fill="none" stroke="${APP.accent}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round"/>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${APP.bg}"/>` +
    tail +
    `<path d="${arrowHead(45, 19, -Math.PI / 3.05, 13)}" fill="${APP.text}" stroke="${APP.bg}" stroke-width="1.4" stroke-linejoin="round"/></svg>`
  );
};

// ---------------------------------------------------------------------------

const CAPTIONS = [
  { eyebrow: 'LIVE NOW', caption: '6,500 vehicles,\nall going somewhere.', lonSpan: 0.14, seed: 11 },
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

  const e = await write('E-vector-phone.png', await vectorPhone({ index: 1, ...CAPTIONS[0] }));
  await write('E-vector-phone-2.png', await vectorPhone({ index: 2, ...CAPTIONS[1] }));
  await write('E-vector-feature.png', await vectorFeature());

  const f = await write('F-chevron-phone.png', await chevronPhone({ index: 1, ...CAPTIONS[0] }));
  await write('F-chevron-phone-2.png', await chevronPhone({ index: 2, ...CAPTIONS[1] }));
  await write('F-chevron-feature.png', await chevronFeature());

  const g = await write('G-hero-phone.png', await heroPhone({ index: 1, ...CAPTIONS[0] }));
  await write('G-hero-phone-2.png', await heroPhone({ index: 2, ...CAPTIONS[1] }));
  await write('G-hero-feature.png', await heroFeature());

  const h = await write('H-sign-phone.png', await signPhone({ index: 1, ...CAPTIONS[0], colour: APP.accent }));
  await write('H-sign-phone-2.png', await signPhone({ index: 2, ...CAPTIONS[1], colour: MODE_COLORS.elizabeth }));
  await write('H-sign-feature.png', await signFeature());

  await write('icon-1-roundel-arrow.png', await png(iconRoundelArrow()).toBuffer());
  await write('icon-2-chevrons.png', await png(iconChevrons()).toBuffer());
  await write('icon-3-comet.png', await png(iconComet()).toBuffer());

  const thumbW = 300;
  const thumbH = Math.round((PHONE.height / PHONE.width) * thumbW);
  const gap = 28;
  const labels = ['E · vector', 'F · chevron', 'G · hero', 'H · sign'];
  const thumbs = await Promise.all(
    [e, f, g, h].map((buf) => sharp(buf).resize(thumbW, thumbH).png().toBuffer()),
  );
  const sheetW = gap + (thumbW + gap) * 4;
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

  for (const [name, bytes] of written) console.log(`${name.padEnd(26)} ${(bytes / 1024).toFixed(0)} kB`);
  console.log(`\n${written.length} files → ${OUT}`);
}

await main();
