/**
 * Rasterises the streak mark into the PNG masters that @capacitor/assets
 * expands into the iOS and Android icon sets.
 *
 *   node scripts/generate-icons.mjs   # writes assets/ and public/apple-touch-icon.png
 *   npm run assets                    # then expands them into ios/ and android/
 *
 * The mark itself is NOT defined here. It comes from
 * scripts/store-assets/lib/streaks.mjs, the same module that draws the App
 * Store and Play listing artwork, because App Store Connect takes the listing
 * icon from the binary's asset catalogue rather than from an upload — so a
 * second copy of the geometry here would show up as a listing whose icon and
 * screenshots disagree. That is exactly the drift this file used to have: it
 * drew the old roundel while store/build/app-icon-1024.png drew the streaks.
 *
 * Importing across the repo root is safe because this is a hand-run dev step —
 * `npm run build` does not touch it, so CI never resolves the path.
 *
 * The sizes exist because the platforms crop differently:
 *  - icon.png            iOS. Squircle-masked, no transparency allowed, so the
 *                        background is painted in and the streaks bleed off the
 *                        left edge; the mark's rows sit well inside the corners.
 *  - icon-foreground.png Android adaptive. The launcher can crop to a circle
 *                        and parallaxes the layer, so only the middle ~66% is
 *                        guaranteed visible — hence the inset mark, scaled so
 *                        its drawn extent lands exactly in that safe zone.
 *  - splash.png          Shown at the window's aspect ratio, cropped from the
 *                        centre, so the mark stays small and centred.
 *
 * It also writes the web app manifest's icons into public/. Those are a fourth
 * crop again: an Android launcher applies its own mask to a `maskable` icon and
 * only the middle 80% of it — the "safe zone" — is guaranteed to survive, so the
 * maskable variant uses the inset mark, while the `any` variant is the plain
 * square the desktop and the tab strip use.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { iconStreaks } from '../../scripts/store-assets/lib/streaks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The listing's cold white, from scripts/store-assets/build.mjs. */
const PAPER = '#f1f1ef';
/** App chrome, from src/App.css :root — the splash ground, and only that. */
const APP_BG_RGB = { r: 0x0b, g: 0x0f, b: 0x1a, alpha: 1 };

/**
 * Inset streaks span x 9..55 of the 64 viewBox — 71.875% of the mark's width.
 * Scaling by 0.66/0.71875 makes that drawn extent, not the canvas, the thing
 * that fills Android's guaranteed-visible middle 66%.
 */
const ADAPTIVE_SAFE = 0.66 / 0.71875;

const render = (size, { background, bleed }) =>
  sharp(Buffer.from(iconStreaks({ background, bleed, size }))).png().toBuffer();

/** The mark on its own ground, filling the canvas. */
const filled = (size, { bleed = true } = {}) => render(size, { background: PAPER, bleed });

/** Centre `markSize` px of transparent-ground mark on a `size` canvas. */
async function compose(size, markSize, { background, bleed }) {
  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  if (markSize > 0) {
    const mark = await render(markSize, { background: 'none', bleed });
    canvas.composite([{ input: mark, gravity: 'centre' }]);
  }
  return canvas.png().toBuffer();
}

/**
 * The mark as a rounded paper tile, for laying on the dark splash ground.
 * The streaks are London line colours on the listing's white; Underground navy
 * is #000f9f against an app background of #0b0f1a, so putting the mark straight
 * onto that ground would lose a whole line. The tile keeps the launch dark
 * without making the mark illegible.
 */
async function plate(canvas, tile) {
  const radius = Math.round(tile * 0.22); // the 8px-on-36 card radius, scaled
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}">` +
      `<rect width="${tile}" height="${tile}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
  const rounded = await sharp(await filled(tile))
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: APP_BG_RGB },
  })
    .composite([{ input: rounded, gravity: 'centre' }])
    .png()
    .toBuffer();
}

const outputs = [
  // iOS + the @capacitor/assets fallback for everything else.
  ['assets/icon.png', await filled(1024)],
  ['assets/icon-dark.png', await filled(1024)],
  // Android adaptive layers.
  ['assets/icon-foreground.png', await compose(1024, Math.round(1024 * ADAPTIVE_SAFE), { bleed: false })],
  ['assets/icon-background.png', await compose(1024, 0, { background: PAPER })],
  // Splash. One image for both themes — the app is dark either way.
  ['assets/splash.png', await plate(2732, 640)],
  ['assets/splash-dark.png', await plate(2732, 640)],
  // Home-screen icon for the web build.
  ['public/apple-touch-icon.png', await filled(180)],
  // Web app manifest. 192 is the install prompt and the task switcher, 512 the
  // splash Chrome synthesises from the manifest; both are required for an
  // installable PWA. The maskable copy uses the inset mark, whose 71.875%
  // extent already sits inside the 80% safe zone.
  ['public/icon-192.png', await filled(192)],
  ['public/icon-512.png', await filled(512)],
  ['public/icon-maskable-512.png', await filled(512, { bleed: false })],
];

await mkdir(join(root, 'assets'), { recursive: true });
for (const [relative, buffer] of outputs) {
  await writeFile(join(root, relative), buffer);
  console.log(`${relative}  ${(buffer.length / 1024).toFixed(1)} kB`);
}
