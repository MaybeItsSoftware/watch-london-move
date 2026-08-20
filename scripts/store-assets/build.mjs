/**
 * Build the store listing artwork for both stores, in the L/swiss language.
 *
 *   node scripts/store-assets/build.mjs
 *
 * Writes straight into the layout fastlane already expects:
 *
 *   fastlane/screenshots/en-GB/                     deliver  (App Store)
 *   fastlane/metadata/android/en-GB/images/         supply   (Play)
 *   store/build/                                    icons + a contact sheet
 *
 * Nothing uploads as a result. Both lanes in fastlane/Fastfile still pass
 * skip_metadata / skip_screenshots / skip_upload_images, exactly as the comment
 * there describes; these files sit inert until someone flips those flags.
 *
 * ── The map imagery ────────────────────────────────────────────────────────
 * By default each screenshot's map is drawn from the app's real route geometry
 * with vehicles placed by a seeded PRNG. That is a stand-in, not live TfL data,
 * and it must not be what ships. Drop real captures into store/captures/ named
 * after the scene ids below (01-fleet.png, 02-modes.png, …) and every target
 * picks them up automatically, cover-cropped into the frame.
 */
import './lib/fonts.mjs'; // must come first: sets FONTCONFIG_FILE before sharp loads
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTERS } from './lib/palette.mjs';
import { LINES_LIGHT, streakBand, iconStreaks } from './lib/streaks.mjs';
import { mapPlate } from './lib/map-plate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const sharp = createRequire(join(root, 'frontend', 'package.json'))('sharp');

const IOS_SHOTS = join(root, 'fastlane', 'screenshots', 'en-GB');
const PLAY_IMAGES = join(root, 'fastlane', 'metadata', 'android', 'en-GB', 'images');
const BUILD = join(root, 'store', 'build');
const CAPTURES = join(root, 'store', 'captures');

// The L/swiss palette: cold white, near-black ink, bus red as the one accent.
const PAPER = '#f1f1ef';
const INK = '#0e0e11';
const ACCENT = '#DC241F';
const ARCHIVO = 'Archivo, sans-serif';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const exists = (p) => access(p).then(() => true, () => false);

/**
 * Strip the alpha channel — as a second pass, which is the whole point.
 *
 * Both stores reject artwork carrying alpha: App Store Connect fails the upload
 * outright, and Play requires a 24-bit feature graphic. sharp runs `flatten`
 * early in its fixed pipeline, *before* `composite`, so flattening in the same
 * chain that composites an RGBA plate quietly hands back a 32-bit PNG anyway.
 * Re-opening the buffer is what actually forces three channels.
 */
const opaque = (buffer, background = PAPER) =>
  sharp(buffer).flatten({ background }).png().toBuffer();

// ---------------------------------------------------------------------------
// Scenes — the four screenshots, in listing order.
// ---------------------------------------------------------------------------

const SCENES = [
  {
    id: '01-fleet',
    eyebrow: 'Live now',
    caption: ['6,500', 'vehicles,', 'all moving.'],
    lonSpan: 0.13,
    seed: 11,
    theme: 'night',
  },
  {
    id: '02-modes',
    eyebrow: 'Every mode',
    caption: ['Bus, tube,', 'DLR, tram,', 'one map.'],
    lonSpan: 0.09,
    seed: 23,
    theme: 'night',
  },
  {
    id: '03-daylight',
    eyebrow: 'Follows the sun',
    caption: ['The map', 'tracks', 'London\u2019s day.'],
    lonSpan: 0.11,
    seed: 31,
    theme: 'day',
  },
  {
    id: '04-close',
    eyebrow: 'Down to the street',
    caption: ['Follow', 'any vehicle', 'you like.'],
    lonSpan: 0.06,
    seed: 43,
    theme: 'night',
    dots: 1500,
  },
];

// ---------------------------------------------------------------------------
// Targets — every size the two stores ask for.
// ---------------------------------------------------------------------------

const TARGETS = [
  // App Store. 6.9" and iPad 13" are the required pair for an app whose
  // TARGETED_DEVICE_FAMILY is "1,2"; the rest are accepted alternates that cost
  // nothing to emit and save a resize later.
  { key: 'iphone-6.9', width: 1320, height: 2868, dir: IOS_SHOTS },
  { key: 'iphone-6.7', width: 1290, height: 2796, dir: IOS_SHOTS },
  { key: 'iphone-6.5', width: 1242, height: 2688, dir: IOS_SHOTS },
  { key: 'ipad-13', width: 2064, height: 2752, dir: IOS_SHOTS },
  { key: 'ipad-12.9', width: 2048, height: 2732, dir: IOS_SHOTS },
  // Play. 1080x1920 is exactly 9:16 — a 1290x2796 phone shot is 2.17:1 and
  // trips Play's 2:1 aspect ceiling, so the iOS masters cannot be reused here.
  { key: 'phone', width: 1080, height: 1920, dir: join(PLAY_IMAGES, 'phoneScreenshots') },
  { key: 'seven-inch', width: 1200, height: 1920, dir: join(PLAY_IMAGES, 'sevenInchScreenshots') },
  { key: 'ten-inch', width: 1600, height: 2560, dir: join(PLAY_IMAGES, 'tenInchScreenshots') },
];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Type and rule weights scale with the canvas width, but a 4:3 iPad is far
 * squarer than a 19.5:9 phone — scaling by width alone would push the header
 * down until the map had nowhere left to go. The square-root term pulls the
 * scale back on squarer canvases without flattening the poster entirely.
 */
const scaleFor = (width, height) =>
  (width / 1290) * Math.sqrt(Math.min(1, height / width / (2796 / 1290)));

/**
 * The layout is a flow, not a set of fixed offsets: each block advances a
 * cursor and the map plate takes whatever vertical space is left. That is what
 * lets one function serve a 2.17:1 phone and a 1.33:1 tablet.
 */
function layout({ width, height, scene, index }) {
  const k = scaleFor(width, height);
  const px = (n) => Math.round(n * k);
  const pad = Math.round(width * 0.0434);

  const ruleY = Math.round(pad * 1.2) + px(155);
  const eyebrowY = ruleY + px(70);
  const headTop = eyebrowY + px(220);
  const lineStep = px(128);
  const headBottom = headTop + (scene.caption.length - 1) * lineStep;
  const bandY = headBottom + px(80);
  const bandH = px(190);
  const plateTop = bandY + bandH + px(90);
  const footerY = height - px(90);
  const plateH = footerY - px(74) - plateTop;
  const plateW = width - pad * 2;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${PAPER}"/>` +
    `<line x1="${pad}" y1="${ruleY}" x2="${width - pad}" y2="${ruleY}" stroke="${INK}" stroke-width="${Math.max(2, px(4))}"/>` +
    `<text x="${pad}" y="${eyebrowY}" font-family="${ARCHIVO}" font-weight="700" font-size="${px(34)}" letter-spacing="${px(3)}" fill="${INK}">${esc(scene.eyebrow.toUpperCase())}</text>` +
    `<text x="${width - pad}" y="${eyebrowY}" text-anchor="end" font-family="${ARCHIVO}" font-weight="700" font-size="${px(34)}" letter-spacing="${px(3)}" fill="${ACCENT}">${String(index + 1).padStart(2, '0')}/${String(SCENES.length).padStart(2, '0')}</text>` +
    scene.caption
      .map(
        (line, i) =>
          `<text x="${pad - px(6)}" y="${headTop + i * lineStep}" font-family="${ARCHIVO}" font-weight="900" font-size="${px(132)}" letter-spacing="${px(-6)}" fill="${INK}">${esc(line)}</text>`,
      )
      .join('') +
    streakBand({ x: 0, y: bandY, width: Math.round(width * 0.545), height: bandH, weight: px(22), colours: LINES_LIGHT }) +
    `<rect x="${pad - 1}" y="${plateTop - 1}" width="${plateW + 2}" height="${plateH + 2}" fill="none" stroke="${INK}" stroke-width="${Math.max(2, px(3))}"/>` +
    `<text x="${pad}" y="${footerY}" font-family="${ARCHIVO}" font-weight="700" font-size="${px(28)}" letter-spacing="${px(2)}" fill="${INK}">${FILTERS.map(([label]) => label.toUpperCase()).join(' · ')}</text>` +
    '</svg>';

  return { svg, plate: { left: pad, top: plateTop, width: plateW, height: plateH } };
}

/** The map inside the frame: a real capture if one was dropped in, else the
 *  seeded stand-in drawn from the app's own route geometry. */
async function plateFor(scene, box) {
  const capture = join(CAPTURES, `${scene.id}.png`);
  if (await exists(capture)) {
    return sharp(capture)
      .resize(box.width, box.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
  }
  return sharp(
    Buffer.from(
      mapPlate({
        width: box.width,
        height: box.height,
        theme: scene.theme,
        lonSpan: scene.lonSpan,
        seed: scene.seed,
        chrome: true,
        glyph: 'streak',
        trailLength: 110,
        dots: scene.dots ?? 900,
      }),
    ),
  )
    .png()
    .toBuffer();
}

async function screenshot({ width, height, scene, index }) {
  const { svg, plate } = layout({ width, height, scene, index });
  const composed = await sharp(Buffer.from(svg))
    .composite([{ input: await plateFor(scene, plate), left: plate.left, top: plate.top }])
    .png()
    .toBuffer();
  return opaque(composed);
}

// ---------------------------------------------------------------------------
// Feature graphic + icons
// ---------------------------------------------------------------------------

/** Play's 1024x500 feature graphic. Landscape, so it gets its own composition:
 *  the wordmark stacked left, a slice of the live city bled off the right. */
async function featureGraphic() {
  const width = 1024;
  const height = 500;
  const plateW = 420;
  const body = await plateFor(SCENES[0], { width: plateW, height });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${PAPER}"/>` +
    `<text x="46" y="150" font-family="${ARCHIVO}" font-weight="900" font-size="86" letter-spacing="-4" fill="${INK}">WATCH</text>` +
    `<text x="46" y="234" font-family="${ARCHIVO}" font-weight="900" font-size="86" letter-spacing="-4" fill="${INK}">LONDON</text>` +
    `<text x="46" y="318" font-family="${ARCHIVO}" font-weight="900" font-size="86" letter-spacing="-4" fill="${ACCENT}">MOVE</text>` +
    streakBand({ x: 0, y: 380, width: 480, height: 90, weight: 13, colours: LINES_LIGHT }) +
    '</svg>';
  const composed = await sharp(Buffer.from(svg))
    .composite([{ input: body, left: width - plateW, top: 0 }])
    .png()
    .toBuffer();
  return opaque(composed); // Play rejects a 32-bit feature graphic.
}

/** The icon on the L/swiss ground, so listing artwork and mark agree. */
const icon = (size) =>
  sharp(Buffer.from(iconStreaks({ colours: LINES_LIGHT, ground: 'light', size })))
    .resize(size, size)
    .flatten({ background: PAPER }) // App Store rejects any alpha channel
    .png();

// ---------------------------------------------------------------------------

/**
 * Check every deliverable against the rules that actually cause a rejected
 * upload, because all of them fail late — at submission, not here.
 *
 *  - alpha: App Store Connect refuses any screenshot carrying an alpha channel,
 *    and Play wants a 24-bit feature graphic.
 *  - 8 MB: Play's per-image ceiling.
 *  - 2:1 and 320..3840 px: Play's bounds, which apply to *screenshots* only —
 *    the feature graphic is a fixed 1024x500 (2.05:1) and is exempt. A
 *    1290x2796 iOS master is 2.17:1, which is exactly why Play gets its own
 *    1080x1920 renders rather than a resize of the iPhone ones.
 *
 * store/build/contact-sheet.png is a preview for us, not a store deliverable,
 * so it is not checked.
 */
async function verify(written) {
  const problems = [];
  for (const [name, bytes] of written) {
    const deliverable = name.startsWith('fastlane/') || name.includes('app-icon-');
    if (!deliverable) continue;

    const { width, height, channels } = await sharp(join(root, name)).metadata();
    if (channels !== 3) problems.push(`${name}: ${channels} channels, expected 3 (no alpha)`);
    if (bytes > 8 * 1024 * 1024) problems.push(`${name}: ${(bytes / 1e6).toFixed(1)} MB exceeds Play's 8 MB`);

    if (name.includes('Screenshots/')) {
      if ([width, height].some((side) => side < 320 || side > 3840))
        problems.push(`${name}: ${width}x${height} outside Play's 320..3840`);
      if (Math.max(width, height) / Math.min(width, height) > 2)
        problems.push(`${name}: ${width}x${height} exceeds Play's 2:1 aspect ceiling`);
    }
  }
  if (problems.length) {
    throw new Error(`Store artwork failed validation:\n  ${problems.join('\n  ')}`);
  }
  console.log(`✓ store artwork passes alpha / size / aspect checks`);
}

/**
 * The store text, and the character ceilings each field is silently truncated
 * or rejected against. These are hand-written files rather than generated ones,
 * but they are checked here so `npm run store` is one gate for the whole
 * listing — a description that grew past 4000, or a Play changelog past its
 * unusually tight 500, otherwise surfaces at submission.
 */
const METADATA_LIMITS = [
  ['fastlane/metadata/en-GB/name.txt', 30],
  ['fastlane/metadata/en-GB/subtitle.txt', 30],
  ['fastlane/metadata/en-GB/keywords.txt', 100],
  ['fastlane/metadata/en-GB/promotional_text.txt', 170],
  ['fastlane/metadata/en-GB/description.txt', 4000],
  ['fastlane/metadata/en-GB/release_notes.txt', 4000],
  ['fastlane/metadata/android/en-GB/title.txt', 30],
  ['fastlane/metadata/android/en-GB/short_description.txt', 80],
  ['fastlane/metadata/android/en-GB/full_description.txt', 4000],
  ['fastlane/metadata/android/en-GB/changelogs/default.txt', 500],
];

async function verifyMetadata() {
  const problems = [];
  const report = [];
  for (const [name, limit] of METADATA_LIMITS) {
    const path = join(root, name);
    if (!(await exists(path))) {
      problems.push(`${name}: missing`);
      continue;
    }
    // Trailing newlines are not part of the field as either store counts it.
    const length = (await readFile(path, 'utf8')).trim().length;
    if (length > limit) problems.push(`${name}: ${length} chars exceeds ${limit}`);
    report.push([name.replace('fastlane/metadata/', ''), length, limit]);
  }
  if (problems.length) {
    throw new Error(`Store metadata failed validation:\n  ${problems.join('\n  ')}`);
  }
  for (const [name, length, limit] of report) {
    console.log(`  ${name.padEnd(42)} ${String(length).padStart(4)} / ${limit}`);
  }
  console.log('✓ store metadata within every field limit');
}

async function main() {
  // Which scenes have a real capture. Testing the directory is not enough — it
  // holds a README, so it exists from a fresh clone onwards and would report
  // every build as shippable.
  const captured = [];
  for (const scene of SCENES) {
    if (await exists(join(CAPTURES, `${scene.id}.png`))) captured.push(scene.id);
  }
  for (const dir of [IOS_SHOTS, PLAY_IMAGES, BUILD]) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const target of TARGETS) await mkdir(target.dir, { recursive: true });
  await mkdir(BUILD, { recursive: true });

  const written = [];
  const write = async (path, buffer) => {
    await writeFile(path, buffer);
    written.push([path.replace(`${root}/`, ''), buffer.length]);
    return buffer;
  };

  // Screenshots: every scene at every target size.
  const previews = [];
  for (const target of TARGETS) {
    for (const [index, scene] of SCENES.entries()) {
      const buffer = await screenshot({ width: target.width, height: target.height, scene, index });
      // Scene first, device second. deliver groups a locale's screenshots by
      // resolution and then orders each group by filename, so leading with the
      // scene number is what puts the listing in the intended order — and it
      // reads the same as the Play filenames, which need no device suffix.
      const name = target.dir === IOS_SHOTS ? `${scene.id}-${target.key}.png` : `${scene.id}.png`;
      await write(join(target.dir, name), buffer);
      if (target.key === 'iphone-6.9') previews.push(buffer);
    }
  }

  // Feature graphic — Play only; the App Store has no equivalent.
  await write(join(PLAY_IMAGES, 'featureGraphic.png'), await featureGraphic());

  // Icons. Play takes 512 in the images directory; App Store Connect takes the
  // 1024 master, which fastlane does not upload — it ships inside the binary —
  // so that one goes to store/build/ for uploading by hand or wiring into
  // frontend/scripts/generate-icons.mjs.
  await write(join(PLAY_IMAGES, 'icon.png'), await icon(512).toBuffer());
  await write(join(BUILD, 'app-icon-1024.png'), await icon(1024).toBuffer());
  await write(join(BUILD, 'app-icon-512.png'), await icon(512).toBuffer());

  // Contact sheet of the listing as a store grid would show it.
  const thumbW = 300;
  const thumbH = Math.round((2868 / 1320) * thumbW);
  const gap = 26;
  const sheetW = gap + (thumbW + gap) * previews.length;
  const sheetH = thumbH + gap * 2 + 54;
  const thumbs = await Promise.all(previews.map((b) => sharp(b).resize(thumbW, thumbH).png().toBuffer()));
  const sheet =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">` +
    `<rect width="${sheetW}" height="${sheetH}" fill="#dedcd8"/>` +
    SCENES.map(
      (scene, i) =>
        `<text x="${gap + i * (thumbW + gap)}" y="${thumbH + gap + 40}" font-family="${ARCHIVO}" font-weight="700" font-size="20" letter-spacing="1" fill="#5b5f68">${scene.id.toUpperCase()}</text>`,
    ).join('') +
    '</svg>';
  await write(
    join(BUILD, 'contact-sheet.png'),
    await sharp(Buffer.from(sheet))
      .composite(thumbs.map((input, i) => ({ input, left: gap + i * (thumbW + gap), top: gap })))
      .png()
      .toBuffer(),
  );

  await verify(written);
  await verifyMetadata();

  for (const [name, bytes] of written) console.log(`${name.padEnd(58)} ${(bytes / 1024).toFixed(0)} kB`);
  console.log(`\n${written.length} files`);
  const missing = SCENES.filter((scene) => !captured.includes(scene.id)).map((scene) => scene.id);
  if (!missing.length) {
    console.log(`Map imagery: real captures for all ${SCENES.length} scenes.`);
  } else {
    console.log(
      `Map imagery: ${captured.length}/${SCENES.length} real, SEEDED STAND-IN for ${missing.join(', ')}.\n` +
        'Not shippable until every scene has a real capture in store/captures/.',
    );
  }
}

await main();
