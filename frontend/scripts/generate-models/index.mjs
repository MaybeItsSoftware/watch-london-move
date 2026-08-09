// Generates the low-poly vehicle models in frontend/public/models as binary
// glTF.
//
// Run with: npm run models          (high detail, what the app loads)
//           npm run models -- --low (also emit the reduced variants)
//
// The low variants are not shipped by default. At the current geometry budget —
// a few hundred triangles per vehicle — they save little, and the map's cost is
// instance count rather than vertex count. The switch exists so that when the
// models grow, the reduced set is a flag rather than a refactor.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toGlb } from './gltf.mjs';
import { BUILDERS } from './vehicles.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'models');
const withLow = process.argv.includes('--low');

mkdirSync(OUT_DIR, { recursive: true });

const levels = withLow ? ['high', 'low'] : ['high'];
for (const [name, build] of Object.entries(BUILDERS)) {
  for (const detail of levels) {
    const path = join(OUT_DIR, detail === 'low' ? `${name}.low.glb` : `${name}.glb`);
    const glb = toGlb(build(detail));
    writeFileSync(path, glb);
    console.log(`wrote ${path} (${(glb.byteLength / 1024).toFixed(1)} kB)`);
  }
}
