/**
 * Point fontconfig at the bundled faces before anything renders text.
 *
 * sharp rasterises SVG through librsvg, which resolves font-family through
 * fontconfig — i.e. through whatever is installed on the machine. Arvo and
 * Geist Mono are the house faces and are not macOS system fonts, so without
 * this the captions silently fall back to Helvetica and every sample lies
 * about the typography. Import this module *first*: it writes a fontconfig
 * file naming scripts/store-assets/fonts/ plus the system directories, and
 * sets FONTCONFIG_FILE before the sharp binary is loaded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(tmpdir(), 'wlm-store-fontcache');
mkdirSync(cache, { recursive: true });

const conf = join(cache, 'fonts.conf');
writeFileSync(
  conf,
  `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${join(here, '..', 'fonts')}</dir>
  <dir>/System/Library/Fonts</dir>
  <dir>/System/Library/Fonts/Supplemental</dir>
  <dir>/Library/Fonts</dir>
  <dir>~/Library/Fonts</dir>
  <cachedir>${cache}</cachedir>
</fontconfig>
`,
);
process.env.FONTCONFIG_FILE = conf;
