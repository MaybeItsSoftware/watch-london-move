/**
 * Store artwork, type suite — four aesthetics with genuinely different voices.
 *
 *   node scripts/store-assets/samples-type.mjs   # writes store/samples-type/
 *
 * The streak icon and the six mode colours are settled; this pass changes
 * everything around them. No slab serif and no warm paper anywhere: each
 * direction commits to its own family, its own ground, and its own idea of what
 * the app is — a poster, an instrument, a shout, or a soft consumer product.
 *
 *   L · Archivo, very heavy and very tight, on cold white. Swiss poster.
 *   M · JetBrains Mono only, hairline grid, coordinates. Instrument.
 *   N · Anton and Bebas Neue, condensed caps at full volume. Transit poster.
 *   O · Figtree with Space Grotesk labels, tinted washes, big radii. Consumer.
 */
import '../lib/fonts.mjs'; // must come first: sets FONTCONFIG_FILE before sharp loads
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, FILTERS, MODE_PALETTE } from '../lib/palette.mjs';
import { LINES, LINES_LIGHT, streakBand, iconStreaks } from '../lib/streaks.mjs';
import { mapPlate } from '../lib/map-plate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const sharp = createRequire(join(root, 'frontend', 'package.json'))('sharp');

const OUT = join(root, 'store', 'explorations', 'type');
const PHONE = { width: 1290, height: 2796 };
const FEATURE = { width: 1024, height: 500 };

const png = (svg) => sharp(Buffer.from(svg)).png();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const ARCHIVO = 'Archivo, sans-serif';
const MONO = 'JetBrains Mono, monospace';
const ANTON = 'Anton, sans-serif';
const BEBAS = 'Bebas Neue, sans-serif';
const FIGTREE = 'Figtree, sans-serif';
const GROTESK = 'Space Grotesk, sans-serif';

/** Rounded (or square) clip of a rendered plate. */
async function plate(svg, width, height, radius = 0) {
  if (!radius) return sharp(Buffer.from(svg)).png().toBuffer();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`,
  );
  return sharp(Buffer.from(svg)).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

const city = (opts) =>
  mapPlate({ theme: 'night', glyph: 'streak', trailLength: 110, dots: 900, ...opts });

// ---------------------------------------------------------------------------
// L — Swiss poster. Archivo at 900, set tight, on cold white.
// ---------------------------------------------------------------------------

const L_PAPER = '#f1f1ef';
const L_INK = '#0e0e11';

async function swissPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const w = PHONE.width - 112;
  const h = 1400;
  const body = await plate(city({ width: w, height: h, lonSpan, chrome: true, seed }), w, h, 0);
  const lines = caption.split('\n');
  const top = 1180;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${L_PAPER}"/>` +
    // A rule and a number, the way a poster series is indexed.
    `<line x1="56" y1="230" x2="${PHONE.width - 56}" y2="230" stroke="${L_INK}" stroke-width="4"/>` +
    `<text x="56" y="300" font-family="${ARCHIVO}" font-weight="700" font-size="34" letter-spacing="3" fill="${L_INK}">${esc(eyebrow.toUpperCase())}</text>` +
    `<text x="${PHONE.width - 56}" y="300" text-anchor="end" font-family="${ARCHIVO}" font-weight="700" font-size="34" letter-spacing="3" fill="#DC241F">${String(index).padStart(2, '0')}/04</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="50" y="${520 + i * 128}" font-family="${ARCHIVO}" font-weight="900" font-size="132" letter-spacing="-6" fill="${L_INK}">${esc(line)}</text>`,
      )
      .join('') +
    streakBand({ x: 0, y: 900, width: 700, height: 190, weight: 22, colours: LINES_LIGHT }) +
    `<rect x="${56 - 1}" y="${top - 1}" width="${w + 2}" height="${h + 2}" fill="none" stroke="${L_INK}" stroke-width="3"/>` +
    `<text x="56" y="${PHONE.height - 90}" font-family="${ARCHIVO}" font-weight="700" font-size="28" letter-spacing="2" fill="${L_INK}">${FILTERS.map(([label]) => label.toUpperCase()).join(' · ')}</text>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: 56, top }]).png().toBuffer();
}

async function swissFeature() {
  const w = 420;
  const body = await plate(city({ width: w, height: FEATURE.height, lonSpan: 0.12, dots: 500, seed: 5 }), w, FEATURE.height, 0);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${L_PAPER}"/>` +
    `<text x="46" y="150" font-family="${ARCHIVO}" font-weight="900" font-size="86" letter-spacing="-4" fill="${L_INK}">WATCH</text>` +
    `<text x="46" y="234" font-family="${ARCHIVO}" font-weight="900" font-size="86" letter-spacing="-4" fill="${L_INK}">LONDON</text>` +
    `<text x="46" y="318" font-family="${ARCHIVO}" font-weight="900" font-size="86" letter-spacing="-4" fill="#DC241F">MOVE</text>` +
    streakBand({ x: 0, y: 380, width: 480, height: 90, weight: 13, colours: LINES_LIGHT }) +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: FEATURE.width - w, top: 0 }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// M — Instrument. JetBrains Mono only, hairline grid, live readouts.
// ---------------------------------------------------------------------------

const M_BG = '#08090b';
const M_RULE = '#1c1f26';
const M_DIM = '#6b7382';

const grid = (width, height, step) => {
  const out = [];
  for (let x = step; x < width; x += step) out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
  for (let y = step; y < height; y += step) out.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  return `<g stroke="${M_RULE}" stroke-width="1">${out.join('')}</g>`;
};

async function instrumentPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const w = PHONE.width - 96;
  const h = 1360;
  const body = await plate(city({ width: w, height: h, lonSpan, chrome: false, seed }), w, h, 0);
  const lines = caption.split('\n');
  const top = 1140;
  const readout = (x, y, label, value, colour) =>
    `<text x="${x}" y="${y}" font-family="${MONO}" font-weight="500" font-size="24" letter-spacing="3" fill="${M_DIM}">${label}</text>` +
    `<text x="${x}" y="${y + 44}" font-family="${MONO}" font-weight="700" font-size="40" fill="${colour}">${value}</text>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${M_BG}"/>` +
    grid(PHONE.width, PHONE.height, 90) +
    `<text x="48" y="220" font-family="${MONO}" font-weight="700" font-size="26" letter-spacing="6" fill="${APP.accent}">${esc(eyebrow.toUpperCase())}</text>` +
    `<text x="${PHONE.width - 48}" y="220" text-anchor="end" font-family="${MONO}" font-weight="500" font-size="26" letter-spacing="4" fill="${M_DIM}">${String(index).padStart(2, '0')}</text>` +
    `<line x1="48" y1="260" x2="${PHONE.width - 48}" y2="260" stroke="${M_RULE}" stroke-width="2"/>` +
    lines
      .map(
        (line, i) =>
          `<text x="48" y="${372 + i * 74}" font-family="${MONO}" font-weight="700" font-size="62" letter-spacing="-1" fill="#ffffff">${esc(line)}</text>`,
      )
      .join('') +
    readout(48, 620, 'ACTIVE', '6,431', '#ffffff') +
    readout(360, 620, 'TICK', '12.0s', '#ffffff') +
    readout(672, 620, 'CENTRE', '51.5074N', APP.accent) +
    streakBand({ x: 48, y: 780, width: 900, height: 220, weight: 8, colours: LINES }) +
    `<line x1="48" y1="1070" x2="${PHONE.width - 48}" y2="1070" stroke="${M_RULE}" stroke-width="2"/>` +
    `<rect x="47" y="${top - 1}" width="${w + 2}" height="${h + 2}" fill="none" stroke="${M_RULE}" stroke-width="2"/>` +
    `<text x="48" y="${PHONE.height - 96}" font-family="${MONO}" font-weight="500" font-size="24" letter-spacing="4" fill="${M_DIM}">BUS / TUBE / OVERGROUND / DLR / TRAM / ELIZABETH</text>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: 48, top }]).png().toBuffer();
}

async function instrumentFeature() {
  const w = 400;
  const body = await plate(city({ width: w, height: FEATURE.height, lonSpan: 0.12, dots: 460, seed: 8 }), w, FEATURE.height, 0);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${M_BG}"/>` +
    grid(FEATURE.width, FEATURE.height, 62) +
    `<text x="46" y="120" font-family="${MONO}" font-weight="700" font-size="19" letter-spacing="6" fill="${APP.accent}">LIVE / ALL MODES</text>` +
    `<text x="46" y="212" font-family="${MONO}" font-weight="700" font-size="52" letter-spacing="-1" fill="#ffffff">WATCH LONDON</text>` +
    `<text x="46" y="276" font-family="${MONO}" font-weight="700" font-size="52" letter-spacing="-1" fill="#ffffff">MOVE</text>` +
    `<text x="48" y="330" font-family="${MONO}" font-weight="500" font-size="21" letter-spacing="3" fill="${M_DIM}">6,431 ACTIVE / TICK 12.0s</text>` +
    streakBand({ x: 46, y: 372, width: 420, height: 90, weight: 8, colours: LINES }) +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: FEATURE.width - w, top: 0 }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// N — Transit poster. Anton and Bebas, condensed caps, full volume.
// ---------------------------------------------------------------------------

async function posterPhone({ index, words, kicker, lonSpan, seed, colour }) {
  const w = PHONE.width;
  const h = 1180;
  const body = await plate(city({ width: w, height: h, lonSpan, chrome: false, seed }), w, h, 0);
  const top = PHONE.height - h;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${colour}"/>` +
    `<text x="56" y="270" font-family="${BEBAS}" font-size="58" letter-spacing="6" fill="rgba(255,255,255,0.85)">${esc(kicker.toUpperCase())}</text>` +
    words
      .map(
        (word, i) =>
          `<text x="46" y="${450 + i * 176}" font-family="${ANTON}" font-size="196" letter-spacing="-2" fill="#ffffff">${esc(word.toUpperCase())}</text>`,
      )
      .join('') +
    streakBand({ x: 0, y: 1060, width: 760, height: 170, weight: 20, colours: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'], opacity: 0.9 }) +
    `<text x="56" y="${top - 62}" font-family="${BEBAS}" font-size="44" letter-spacing="4" fill="rgba(255,255,255,0.82)">BUS · TUBE · OVERGROUND · DLR · TRAM</text>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: 0, top }]).png().toBuffer();
}

async function posterFeature() {
  const w = 380;
  const body = await plate(city({ width: w, height: FEATURE.height, lonSpan: 0.11, dots: 460, seed: 12 }), w, FEATURE.height, 0);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="#DC241F"/>` +
    `<text x="44" y="150" font-family="${ANTON}" font-size="112" letter-spacing="-2" fill="#ffffff">WATCH</text>` +
    `<text x="44" y="256" font-family="${ANTON}" font-size="112" letter-spacing="-2" fill="#ffffff">LONDON</text>` +
    `<text x="44" y="362" font-family="${ANTON}" font-size="112" letter-spacing="-2" fill="#ffffff">MOVE</text>` +
    `<text x="46" y="424" font-family="${BEBAS}" font-size="42" letter-spacing="5" fill="rgba(255,255,255,0.85)">6,500 VEHICLES · LIVE</text>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: FEATURE.width - w, top: 0 }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// O — Consumer. Figtree, Space Grotesk labels, tinted washes, big radii.
// ---------------------------------------------------------------------------

const O_BG = '#f6f5f8';
const O_INK = '#211f29';
const O_MUTED = '#6f6b7d';

async function softPhone({ index, eyebrow, caption, lonSpan, seed }) {
  const w = PHONE.width - 96;
  const h = 1480;
  const body = await plate(city({ width: w, height: h, lonSpan, chrome: true, seed }), w, h, 44);
  const lines = caption.split('\n');
  const top = 1180;
  const chips = FILTERS.map(([label, colour], i) => {
    const x = 48 + (i % 3) * 400;
    const y = 800 + Math.floor(i / 3) * 104;
    return (
      `<rect x="${x}" y="${y}" width="368" height="80" rx="40" fill="${colour}14" stroke="${colour}55" stroke-width="2"/>` +
      `<circle cx="${x + 44}" cy="${y + 40}" r="13" fill="${colour}"/>` +
      `<text x="${x + 74}" y="${y + 51}" font-family="${FIGTREE}" font-weight="600" font-size="32" fill="${O_INK}">${label}</text>`
    );
  }).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHONE.width}" height="${PHONE.height}">` +
    `<rect width="${PHONE.width}" height="${PHONE.height}" fill="${O_BG}"/>` +
    `<rect x="48" y="180" width="${PHONE.width - 96}" height="560" rx="52" fill="#ffffff"/>` +
    `<text x="96" y="290" font-family="${GROTESK}" font-weight="700" font-size="28" letter-spacing="4" fill="${O_MUTED}">${esc(eyebrow.toUpperCase())} · ${String(index).padStart(2, '0')}</text>` +
    lines
      .map(
        (line, i) =>
          `<text x="94" y="${400 + i * 86}" font-family="${FIGTREE}" font-weight="700" font-size="76" letter-spacing="-2" fill="${O_INK}">${esc(line)}</text>`,
      )
      .join('') +
    streakBand({ x: 94, y: 600, width: 640, height: 92, weight: 14, colours: LINES_LIGHT }) +
    chips +
    `<rect x="47" y="${top - 1}" width="${w + 2}" height="${h + 2}" rx="45" fill="none" stroke="#e4e1ea" stroke-width="2"/>` +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: 48, top }]).png().toBuffer();
}

async function softFeature() {
  const w = 380;
  const h = 420;
  const body = await plate(city({ width: w, height: h, lonSpan: 0.12, dots: 460, seed: 19 }), w, h, 36);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FEATURE.width}" height="${FEATURE.height}">` +
    `<rect width="${FEATURE.width}" height="${FEATURE.height}" fill="${O_BG}"/>` +
    `<text x="52" y="140" font-family="${GROTESK}" font-weight="700" font-size="20" letter-spacing="4" fill="${O_MUTED}">LIVE · ALL MODES</text>` +
    `<text x="50" y="232" font-family="${FIGTREE}" font-weight="700" font-size="64" letter-spacing="-2" fill="${O_INK}">Watch London</text>` +
    `<text x="50" y="304" font-family="${FIGTREE}" font-weight="700" font-size="64" letter-spacing="-2" fill="${O_INK}">Move</text>` +
    streakBand({ x: 52, y: 360, width: 420, height: 90, weight: 12, colours: LINES_LIGHT }) +
    '</svg>';
  return sharp(Buffer.from(svg)).composite([{ input: body, left: FEATURE.width - w - 44, top: 40 }]).png().toBuffer();
}

// ---------------------------------------------------------------------------

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

  const l = await write(
    'L-swiss-phone.png',
    await swissPhone({ index: 1, eyebrow: 'Live now', caption: '6,500\nvehicles,\nall moving.', lonSpan: 0.13, seed: 11 }),
  );
  await write('L-swiss-feature.png', await swissFeature());

  const m = await write(
    'M-instrument-phone.png',
    await instrumentPhone({ index: 1, eyebrow: 'Live network', caption: 'EVERY VEHICLE\nON ONE MAP', lonSpan: 0.13, seed: 11 }),
  );
  await write('M-instrument-feature.png', await instrumentFeature());

  const n = await write(
    'N-poster-phone.png',
    await posterPhone({ index: 1, kicker: 'Live, right now', words: ['6,500', 'moving'], lonSpan: 0.13, seed: 11, colour: '#DC241F' }),
  );
  await write(
    'N-poster-phone-2.png',
    await posterPhone({ index: 2, kicker: 'Every mode', words: ['One', 'city'], lonSpan: 0.09, seed: 23, colour: '#1e33ff' }),
  );
  await write('N-poster-feature.png', await posterFeature());

  const o = await write(
    'O-soft-phone.png',
    await softPhone({ index: 1, eyebrow: 'Live now', caption: '6,500 vehicles,\nall moving at once.', lonSpan: 0.13, seed: 11 }),
  );
  await write('O-soft-feature.png', await softFeature());

  await write('icon-dark.png', await png(iconStreaks({ colours: LINES })).toBuffer());
  await write('icon-light.png', await png(iconStreaks({ colours: LINES_LIGHT, ground: 'light' })).toBuffer());

  const thumbW = 300;
  const thumbH = Math.round((PHONE.height / PHONE.width) * thumbW);
  const gap = 28;
  const labels = ['L · swiss', 'M · instrument', 'N · poster', 'O · soft'];
  const thumbs = await Promise.all([l, m, n, o].map((b) => sharp(b).resize(thumbW, thumbH).png().toBuffer()));
  const sheetW = gap + (thumbW + gap) * 4;
  const sheetH = thumbH + gap * 2 + 60;
  const sheet =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">` +
    `<rect width="${sheetW}" height="${sheetH}" fill="#dedcd8"/>` +
    labels
      .map(
        (label, i) =>
          `<text x="${gap + i * (thumbW + gap)}" y="${thumbH + gap + 46}" font-family="${MONO}" font-weight="700" font-size="22" letter-spacing="1" fill="#5b5f68">${label.toUpperCase()}</text>`,
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
