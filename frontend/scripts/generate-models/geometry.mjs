// Geometry primitives for the vehicle models.
//
// Everything is authored in metres at real-world scale: +x is the direction of
// travel, +y is up, +z is across the vehicle towards its right-hand side.
// model-layers.ts turns that into a compass heading with the orientation
// [0, 90 - heading, 90] — see the note there for why.
//
// Geometry is organised into *parts*, not just colour groups. A part becomes a
// named glTF node with its own transform, which is the prerequisite for
// animating anything: a wheel can only spin if it is a node with a pivot of its
// own. Within a part, faces are still batched by colour so each material is one
// draw call.

const FACES = [
  [0, 1, 2, 3], // -y
  [4, 7, 6, 5], // +y
  [0, 4, 5, 1], // -z
  [3, 2, 6, 7], // +z
  [0, 3, 7, 4], // -x
  [1, 5, 6, 2], // +x
];

/** Planar UVs per quad. Emitted only when a part opts in, so a model that has
 *  no texture does not carry a third of its vertex data for nothing. */
const QUAD_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * @param name  glTF node name. Dotted names group related parts by convention
 *              (`wheel.rear.left`), which is what an animation track selects on.
 * @param options.translation  the node's pivot, in vehicle space. Geometry added
 *              to the part is authored *relative* to it.
 * @param options.spin  `{ axis, periodSeconds }` to emit a rotation track for
 *              this node. Rolling stock spins about the z axis.
 * @param options.uv  emit TEXCOORD_0 for this part's geometry.
 */
export function part(name, { translation = [0, 0, 0], spin = null, uv = false } = {}) {
  return { name, translation, spin, uv, groups: new Map() };
}

function groupFor(target, colorKey) {
  let group = target.groups.get(colorKey);
  if (!group) {
    group = { positions: [], normals: [], uvs: [], indices: [] };
    target.groups.set(colorKey, group);
  }
  return group;
}

/**
 * Box/prism topology: corners are 8 points, bottom ring then top ring, each ring
 * ordered (-x,-z) (+x,-z) (+x,+z) (-x,+z). Faces are wound CCW from outside;
 * vertices are duplicated per face for flat shading.
 */
export function addPrism(target, colorKey, corners) {
  const group = groupFor(target, colorKey);
  for (const face of FACES) {
    const [a, b, c, d] = face.map((i) => corners[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(...n) || 1;
    const normal = n.map((value) => value / length);

    const base = group.positions.length / 3;
    let corner = 0;
    for (const point of [a, b, c, d]) {
      group.positions.push(...point);
      group.normals.push(...normal);
      if (target.uv) {
        group.uvs.push(...QUAD_UV[corner]);
      }
      corner += 1;
    }
    group.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

export function ring(x0, x1, y, halfWidth) {
  return [
    [x0, y, -halfWidth],
    [x1, y, -halfWidth],
    [x1, y, halfWidth],
    [x0, y, halfWidth],
  ];
}

export function addBox(target, colorKey, cx, cy, cz, lx, ly, lz) {
  const [x0, x1] = [cx - lx / 2, cx + lx / 2];
  const [y0, y1] = [cy - ly / 2, cy + ly / 2];
  const [z0, z1] = [cz - lz / 2, cz + lz / 2];
  addPrism(target, colorKey, [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ]);
}

/**
 * A rail car body: underframe, sides, window band, doors and a rounded roof.
 * Every train-like vehicle in the network is this shape at different lengths,
 * so they share one builder rather than three near-identical copies.
 */
export function addRailCar(target, { cx = 0, length, halfWidth, roofY, bodyY, detail }) {
  addBox(target, 'black', cx, 0.45, 0, length - 0.6, 0.35, halfWidth * 1.7); // underframe
  addBox(target, 'bodyWhite', cx, bodyY, 0, length, 1.9, halfWidth * 2); // body
  addPrism(target, 'bodyWhite', [
    ...ring(cx - length / 2 + 0.1, cx + length / 2 - 0.1, roofY - 0.47, halfWidth - 0.01),
    ...ring(cx - length / 2 + 0.1, cx + length / 2 - 0.1, roofY, halfWidth - 0.43),
  ]); // rounded roof

  if (detail === 'low') {
    return;
  }

  for (const dx of [-1, 1]) {
    addBox(target, 'black', cx + dx * (length / 2 - 1.9), 0.35, 0, 1.7, 0.5, halfWidth * 1.55);
  } // bogies
  for (const z of [-halfWidth - 0.02, halfWidth + 0.02]) {
    addBox(target, 'glass', cx, bodyY + 0.45, z, length - 1.2, 0.55, 0.05); // window band
    for (const dx of [-1, 1]) {
      addBox(target, 'doorGrey', cx + (dx * length) / 4, bodyY - 0.05, z, 1.6, 1.75, 0.07);
    } // double doors
  }
}
