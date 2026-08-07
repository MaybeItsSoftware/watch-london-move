// Generates the low-poly vehicle models in frontend/public/models as glTF.
// Run with: node frontend/scripts/generate-models.mjs
//
// Models are authored in metres at real-world scale: +x is the direction of
// travel, +y is up, z is across the vehicle. App.tsx applies the same
// orientation convention the old placeholder arrows used ([0, -heading, 90]).
//
// The train and tram bodies are near-white so ScenegraphLayer's getColor tint
// multiplies them into the line colour; the bus carries its own baked red.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Box/prism topology: corners are 8 points, bottom ring then top ring, each
// ring ordered (-x,-z) (+x,-z) (+x,+z) (-x,+z). Faces are wound CCW from
// outside; vertices are duplicated per face for flat shading.
const FACES = [
  [0, 1, 2, 3], // -y
  [4, 7, 6, 5], // +y
  [0, 4, 5, 1], // -z
  [3, 2, 6, 7], // +z
  [0, 3, 7, 4], // -x
  [1, 5, 6, 2], // +x
];

function addPrism(group, corners) {
  for (const face of FACES) {
    const [a, b, c, d] = face.map((i) => corners[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const len = Math.hypot(...n) || 1;
    const normal = n.map((value) => value / len);

    const base = group.positions.length / 3;
    for (const point of [a, b, c, d]) {
      group.positions.push(...point);
      group.normals.push(...normal);
    }
    group.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function ring(x0, x1, y, halfWidth) {
  return [
    [x0, y, -halfWidth],
    [x1, y, -halfWidth],
    [x1, y, halfWidth],
    [x0, y, halfWidth],
  ];
}

function addBox(group, cx, cy, cz, lx, ly, lz) {
  const [x0, x1] = [cx - lx / 2, cx + lx / 2];
  const [y0, y1] = [cy - ly / 2, cy + ly / 2];
  const [z0, z1] = [cz - lz / 2, cz + lz / 2];
  addPrism(group, [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ]);
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const COLORS = {
  busRed: [0.88, 0.13, 0.11],
  glass: [0.09, 0.1, 0.13],
  black: [0.05, 0.05, 0.05],
  darkGrey: [0.22, 0.22, 0.24],
  bodyWhite: [0.93, 0.93, 0.93],
  doorGrey: [0.72, 0.72, 0.75],
  lampWhite: [0.95, 0.9, 0.7],
};

function makeGroups() {
  const groups = {};
  for (const name of Object.keys(COLORS)) {
    groups[name] = { positions: [], normals: [], indices: [], color: COLORS[name] };
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

// New Routemaster: 11.2m long, 2.5m wide, 4.4m tall, two window bands.
function buildBus() {
  const g = makeGroups();

  addBox(g.darkGrey, 0, 0.5, 0, 10.9, 0.5, 2.35); // skirt / chassis
  for (const x of [3.3, -2.6, -3.9]) {
    for (const z of [-1.05, 1.05]) {
      addBox(g.black, x, 0.45, z, 0.9, 0.9, 0.35); // wheels (NB4L twin rear axles)
    }
  }

  addBox(g.busRed, 0, 1.6, 0, 11.2, 1.7, 2.5); // lower deck
  // Upper deck tapers slightly and the front rakes back, echoing the NB4L nose.
  addPrism(g.busRed, [
    ...ring(-5.6, 5.6, 2.45, 1.25),
    ...ring(-5.6, 5.2, 4.2, 1.1),
  ]);
  addPrism(g.busRed, [
    ...ring(-5.55, 5.05, 4.18, 1.08),
    ...ring(-5.4, 4.8, 4.4, 0.9),
  ]); // roof cap

  // Window bands sit a couple of cm proud of the body to avoid z-fighting.
  for (const z of [-1.26, 1.26]) {
    addBox(g.glass, -0.4, 1.95, z, 9.2, 0.8, 0.06); // lower deck side windows
    addBox(g.glass, -0.4, 3.45, z * 0.94, 9.0, 0.85, 0.06); // upper deck side windows
  }
  addBox(g.glass, 5.58, 1.85, 0, 0.12, 1.1, 1.9); // lower windscreen
  addPrism(g.glass, [
    ...ring(5.28, 5.5, 3.0, 0.95),
    ...ring(5.05, 5.27, 4.05, 0.9),
  ]); // raked upper windscreen
  addBox(g.glass, 4.35, 1.6, 1.26, 1.1, 1.7, 0.06); // front door
  addBox(g.glass, -5.61, 3.45, 0, 0.1, 0.85, 1.7); // rear upper window

  addBox(g.black, 5.6, 2.62, 0, 0.1, 0.4, 1.5); // destination display
  for (const z of [-0.8, 0.8]) {
    addBox(g.lampWhite, 5.62, 0.95, z, 0.08, 0.25, 0.4); // headlights
  }

  return g;
}

// Deep-tube stock: three ~13m cars with rounded roofs and a cab at each end.
// The body is white so the per-line tint colours the whole train.
function buildTrain() {
  const g = makeGroups();
  const carLength = 13;
  const gap = 0.7;
  const centers = [-(carLength + gap), 0, carLength + gap];

  for (const cx of centers) {
    addBox(g.black, cx, 0.45, 0, carLength - 0.6, 0.35, 2.2); // underframe
    for (const dx of [-1, 1]) {
      addBox(g.black, cx + dx * (carLength / 2 - 1.9), 0.35, 0, 1.7, 0.5, 2.0); // bogies
    }

    addBox(g.bodyWhite, cx, 1.55, 0, carLength, 1.9, 2.55); // body
    addPrism(g.bodyWhite, [
      ...ring(cx - carLength / 2 + 0.1, cx + carLength / 2 - 0.1, 2.48, 1.27),
      ...ring(cx - carLength / 2 + 0.1, cx + carLength / 2 - 0.1, 2.95, 0.85),
    ]); // rounded roof

    for (const z of [-1.29, 1.29]) {
      addBox(g.glass, cx, 2.0, z, carLength - 1.2, 0.55, 0.05); // window band
      for (const dx of [-1, 1]) {
        addBox(g.doorGrey, cx + (dx * carLength) / 4, 1.5, z, 1.6, 1.75, 0.07); // double doors
      }
    }
  }

  const nose = centers[2] + carLength / 2;
  for (const sign of [1, -1]) {
    addBox(g.glass, sign * nose, 1.9, 0, 0.12, 0.85, 1.9); // cab windscreen
    for (const z of [-0.7, 0.7]) {
      addBox(g.lampWhite, sign * (nose + 0.02), 1.05, z, 0.08, 0.2, 0.3); // headlights
    }
  }

  return g;
}

// Croydon tram: three low-floor articulated sections, big windows, raked nose.
function buildTram() {
  const g = makeGroups();
  const sectionLength = 8;
  const gap = 0.35;
  const centers = [-(sectionLength + gap), 0, sectionLength + gap];

  for (const cx of centers) {
    addBox(g.black, cx, 0.25, 0, sectionLength - 0.8, 0.3, 2.1); // underframe
    addBox(g.bodyWhite, cx, 1.4, 0, sectionLength, 2.0, 2.4); // low-floor body
    addPrism(g.bodyWhite, [
      ...ring(cx - sectionLength / 2 + 0.1, cx + sectionLength / 2 - 0.1, 2.38, 1.19),
      ...ring(cx - sectionLength / 2 + 0.1, cx + sectionLength / 2 - 0.1, 2.75, 0.8),
    ]); // roof

    for (const z of [-1.21, 1.21]) {
      addBox(g.glass, cx, 1.75, z, sectionLength - 1.0, 0.85, 0.05); // deep window band
      addBox(g.doorGrey, cx, 1.15, z, 1.5, 1.5, 0.06); // centre doors
    }
  }

  const nose = centers[2] + sectionLength / 2;
  for (const sign of [1, -1]) {
    addPrism(g.glass, [
      ...ring(sign * (nose - 0.35), sign * (nose + 0.01), 1.3, 0.95),
      ...ring(sign * (nose - 0.9), sign * (nose - 0.45), 2.3, 0.9),
    ]); // raked windscreen
  }

  return g;
}

// ---------------------------------------------------------------------------
// glTF assembly
// ---------------------------------------------------------------------------

function toGltf(groups) {
  const chunks = [];
  let byteOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const materials = [];
  const primitives = [];

  const pushChunk = (typedArray, target) => {
    // glTF requires 4-byte alignment between buffer views.
    const padding = (4 - (byteOffset % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    const buffer = Buffer.from(typedArray.buffer);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.byteLength, target });
    chunks.push(buffer);
    byteOffset += buffer.byteLength;
    return bufferViews.length - 1;
  };

  for (const group of Object.values(groups)) {
    if (!group.positions.length) continue;

    const positions = new Float32Array(group.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], positions[i + axis]);
        max[axis] = Math.max(max[axis], positions[i + axis]);
      }
    }

    const positionView = pushChunk(positions, 34962);
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: positions.length / 3,
      type: 'VEC3',
      min,
      max,
    });
    const positionAccessor = accessors.length - 1;

    const normalView = pushChunk(new Float32Array(group.normals), 34962);
    accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: group.normals.length / 3,
      type: 'VEC3',
    });
    const normalAccessor = accessors.length - 1;

    const indexView = pushChunk(new Uint16Array(group.indices), 34963);
    accessors.push({
      bufferView: indexView,
      componentType: 5123,
      count: group.indices.length,
      type: 'SCALAR',
    });
    const indexAccessor = accessors.length - 1;

    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: [...group.color, 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
      doubleSided: true,
    });

    primitives.push({
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
      indices: indexAccessor,
      material: materials.length - 1,
    });
  }

  const binary = Buffer.concat(chunks);
  return JSON.stringify({
    asset: { version: '2.0', generator: 'watch-london-move generate-models' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength: binary.byteLength,
        uri: `data:application/octet-stream;base64,${binary.toString('base64')}`,
      },
    ],
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, build] of [
  ['bus', buildBus],
  ['train', buildTrain],
  ['tram', buildTram],
]) {
  const path = join(OUT_DIR, `${name}.gltf`);
  writeFileSync(path, toGltf(build()));
  console.log(`wrote ${path}`);
}
