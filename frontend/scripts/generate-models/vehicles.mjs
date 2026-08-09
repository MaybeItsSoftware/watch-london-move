// The vehicle shapes. Each builder returns { name, parts } and takes a detail
// level, so a lower-poly variant is a parameter rather than a second model.
//
// Wheels and bogies are separate parts with their own pivots and spin tracks;
// nothing plays them yet (see gltf.mjs), but the nodes are where an animation
// would attach.

import { addBox, addPrism, addRailCar, part, ring } from './geometry.mjs';

/** One full wheel revolution at roughly urban speed, for a ~0.9m wheel. */
const WHEEL_PERIOD_S = 0.35;

function wheel(name, position, radius, width) {
  const node = part(name, {
    translation: position,
    spin: { axis: 'z', periodSeconds: WHEEL_PERIOD_S },
  });
  // Authored about the part's own origin so the spin track rotates it in place.
  addBox(node, 'black', 0, 0, 0, radius * 2, radius * 2, width);
  return node;
}

/** New Routemaster: 11.2m long, 2.5m wide, 4.4m tall, two window bands. */
export function buildBus(detail) {
  const body = part('body');
  const parts = [body];

  addBox(body, 'darkGrey', 0, 0.5, 0, 10.9, 0.5, 2.35); // skirt / chassis
  addBox(body, 'bodyWhite', 0, 1.6, 0, 11.2, 1.7, 2.5); // lower deck
  // Upper deck tapers slightly and the front rakes back, echoing the NB4L nose.
  addPrism(body, 'bodyWhite', [...ring(-5.6, 5.6, 2.45, 1.25), ...ring(-5.6, 5.2, 4.2, 1.1)]);
  addPrism(body, 'bodyWhite', [
    ...ring(-5.55, 5.05, 4.18, 1.08),
    ...ring(-5.4, 4.8, 4.4, 0.9),
  ]); // roof cap

  if (detail === 'low') {
    return { name: 'bus', parts };
  }

  // NB4L twin rear axles.
  for (const [label, x] of [['front', 3.3], ['rear.inner', -2.6], ['rear.outer', -3.9]]) {
    for (const [side, z] of [['left', -1.05], ['right', 1.05]]) {
      parts.push(wheel(`wheel.${label}.${side}`, [x, 0.45, z], 0.45, 0.35));
    }
  }

  // Window bands sit a couple of cm proud of the body to avoid z-fighting.
  for (const z of [-1.26, 1.26]) {
    addBox(body, 'glass', -0.4, 1.95, z, 9.2, 0.8, 0.06); // lower deck side windows
    addBox(body, 'glass', -0.4, 3.45, z * 0.94, 9.0, 0.85, 0.06); // upper deck side windows
  }
  addBox(body, 'glass', 5.58, 1.85, 0, 0.12, 1.1, 1.9); // lower windscreen
  addPrism(body, 'glass', [
    ...ring(5.28, 5.5, 3.0, 0.95),
    ...ring(5.05, 5.27, 4.05, 0.9),
  ]); // raked upper windscreen
  addBox(body, 'glass', 4.35, 1.6, 1.26, 1.1, 1.7, 0.06); // front door
  addBox(body, 'glass', -5.61, 3.45, 0, 0.1, 0.85, 1.7); // rear upper window

  addBox(body, 'black', 5.6, 2.62, 0, 0.1, 0.4, 1.5); // destination display
  for (const z of [-0.8, 0.8]) {
    addBox(body, 'lampWhite', 5.62, 0.95, z, 0.08, 0.25, 0.4); // headlights
  }

  return { name: 'bus', parts };
}

/** Deep-tube stock: three ~13m cars with rounded roofs and a cab at each end. */
export function buildTrain(detail) {
  return railVehicle('train', { cars: 3, carLength: 13, gap: 0.7, halfWidth: 1.275, cab: true, detail });
}

/**
 * DLR: two articulated cars, driverless — so the nose is a full-height passenger
 * window where a tube train has a cab windscreen, which is the whole point of
 * sitting at the front of one.
 */
export function buildDlr(detail) {
  return railVehicle('dlr', {
    cars: 2,
    carLength: 14,
    gap: 0.5,
    halfWidth: 1.35,
    cab: false,
    detail,
  });
}

/**
 * Class 345: mainline stock, wider and much longer than a tube train. Modelled
 * as five cars rather than the real nine — a 205m train is accurate and
 * unreadable, three times the length of anything else on the map.
 */
export function buildElizabeth(detail) {
  return railVehicle('elizabeth', {
    cars: 5,
    carLength: 20,
    gap: 0.6,
    halfWidth: 1.45,
    cab: true,
    detail,
  });
}

function railVehicle(name, { cars, carLength, gap, halfWidth, cab, detail }) {
  const body = part('body');
  const parts = [body];
  const pitch = carLength + gap;
  const first = -((cars - 1) / 2) * pitch;

  for (let index = 0; index < cars; index += 1) {
    addRailCar(body, {
      cx: first + index * pitch,
      length: carLength,
      halfWidth,
      roofY: 2.95,
      bodyY: 1.55,
      detail,
    });
  }

  if (detail === 'low') {
    return { name, parts };
  }

  const nose = first + (cars - 1) * pitch + carLength / 2;
  for (const sign of [1, -1]) {
    if (cab) {
      addBox(body, 'glass', sign * nose, 1.9, 0, 0.12, 0.85, halfWidth * 1.5);
    } else {
      // Full-height window instead of a cab.
      addBox(body, 'glass', sign * nose, 1.95, 0, 0.12, 1.5, halfWidth * 1.7);
    }
    for (const z of [-0.7, 0.7]) {
      addBox(body, 'lampWhite', sign * (nose + 0.02), 1.05, z, 0.08, 0.2, 0.3); // headlights
    }
  }

  return { name, parts };
}

/** Croydon tram: three low-floor articulated sections, big windows, raked nose. */
export function buildTram(detail) {
  const body = part('body');
  const parts = [body];
  const sectionLength = 8;
  const gap = 0.35;
  const centers = [-(sectionLength + gap), 0, sectionLength + gap];

  for (const cx of centers) {
    addBox(body, 'black', cx, 0.25, 0, sectionLength - 0.8, 0.3, 2.1); // underframe
    addBox(body, 'bodyWhite', cx, 1.4, 0, sectionLength, 2.0, 2.4); // low-floor body
    addPrism(body, 'bodyWhite', [
      ...ring(cx - sectionLength / 2 + 0.1, cx + sectionLength / 2 - 0.1, 2.38, 1.19),
      ...ring(cx - sectionLength / 2 + 0.1, cx + sectionLength / 2 - 0.1, 2.75, 0.8),
    ]); // roof

    if (detail === 'low') {
      continue;
    }
    for (const z of [-1.21, 1.21]) {
      addBox(body, 'glass', cx, 1.75, z, sectionLength - 1.0, 0.85, 0.05); // deep window band
      addBox(body, 'doorGrey', cx, 1.15, z, 1.5, 1.5, 0.06); // centre doors
    }
  }

  if (detail === 'low') {
    return { name: 'tram', parts };
  }

  const nose = centers[2] + sectionLength / 2;
  for (const sign of [1, -1]) {
    addPrism(body, 'glass', [
      ...ring(sign * (nose - 0.35), sign * (nose + 0.01), 1.3, 0.95),
      ...ring(sign * (nose - 0.9), sign * (nose - 0.45), 2.3, 0.9),
    ]); // raked windscreen
  }

  return { name: 'tram', parts };
}

/**
 * The models the app loads, keyed by the name it fetches them under. Vehicle
 * `type` selects between them in src/model-layers.ts.
 *
 * There is no single-decker bus here on purpose: the TfL feed reports every road
 * vehicle as `bus` with no body type, so choosing between a double- and a
 * single-decker would mean inventing the distinction. The builder is a
 * twenty-line addition to this file the day the data can support it.
 */
export const BUILDERS = {
  bus: buildBus,
  train: buildTrain,
  tram: buildTram,
  dlr: buildDlr,
  elizabeth: buildElizabeth,
};
