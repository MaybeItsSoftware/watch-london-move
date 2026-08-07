/**
 * Rasterises the roundel from public/favicon.svg into the PNG masters that
 * @capacitor/assets expands into the iOS and Android icon sets.
 *
 *   node scripts/generate-icons.mjs   # writes assets/ and public/apple-touch-icon.png
 *   npm run assets                    # then expands them into ios/ and android/
 *
 * The three sizes exist because the platforms crop differently:
 *  - icon.png            iOS. Squircle-masked, no transparency allowed, so the
 *                        mark is inset and the background is painted in.
 *  - icon-foreground.png Android adaptive. The launcher can crop to a circle
 *                        and parallaxes the layer, so only the middle ~66% is
 *                        guaranteed visible — the mark is inset further still.
 *  - splash.png          Shown at the window's aspect ratio, cropped from the
 *                        centre, so the mark stays small and centred.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#0b0f1a';
const RING = '#38bdf8';
const BAR = '#e6eaf2';

/** The favicon roundel, drawn at `size` with the disc filling the viewBox. */
function roundel(size, { disc }) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
      (disc ? `<circle cx="32" cy="32" r="30" fill="${BG}"/>` : '') +
      `<circle cx="32" cy="32" r="24" fill="none" stroke="${RING}" stroke-width="5"/>` +
      `<rect x="6" y="27.5" width="52" height="9" rx="4.5" fill="${BAR}"/>` +
      `</svg>`,
  );
}

/**
 * Centre `markSize` px of roundel on a solid (or transparent) `size` canvas.
 * A `markSize` of 0 gives the bare canvas, which is what the Android adaptive
 * background layer is.
 */
async function compose(size, markSize, { background, disc }) {
  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  if (markSize > 0) {
    const mark = await sharp(roundel(markSize, { disc })).png().toBuffer();
    canvas.composite([{ input: mark, gravity: 'centre' }]);
  }
  return canvas.png().toBuffer();
}

const solid = { r: 0x0b, g: 0x0f, b: 0x1a, alpha: 1 };

const outputs = [
  // iOS + the @capacitor/assets fallback for everything else.
  ['assets/icon.png', await compose(1024, 800, { background: solid, disc: false })],
  ['assets/icon-dark.png', await compose(1024, 800, { background: solid, disc: false })],
  // Android adaptive layers.
  ['assets/icon-foreground.png', await compose(1024, 560, { disc: false })],
  ['assets/icon-background.png', await compose(1024, 0, { background: solid, disc: false })],
  // Splash. One image for both themes — the app is dark either way.
  ['assets/splash.png', await compose(2732, 640, { background: solid, disc: false })],
  ['assets/splash-dark.png', await compose(2732, 640, { background: solid, disc: false })],
  // Home-screen icon for the web build.
  ['public/apple-touch-icon.png', await compose(180, 180, { background: solid, disc: true })],
];

await mkdir(join(root, 'assets'), { recursive: true });
for (const [relative, buffer] of outputs) {
  await writeFile(join(root, relative), buffer);
  console.log(`${relative}  ${(buffer.length / 1024).toFixed(1)} kB`);
}
