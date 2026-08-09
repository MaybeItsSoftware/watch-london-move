import type { DaylightPhase } from './daylight';
import type { FilterKey } from './types';

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4010';
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || BACKEND_URL;
export const INTERPOLATION_MS = Number(import.meta.env.VITE_INTERPOLATION_MS || 12000);

// The backend streams per grid tile, so the client tells it what is on screen.
// Panning fires continuously; this collapses a gesture into one subscription
// change at the end of it.
export const VIEWPORT_DEBOUNCE_MS = 250;
// Subscribe to a box this much larger than the viewport in each direction, so
// vehicles are already known by the time they cross into view.
export const VIEWPORT_PADDING_RATIO = 0.25;
// Destination and next stop are fetched per selection and refreshed while the
// info panel is open, since the next stop changes as the vehicle moves.
export const DETAIL_REFRESH_MS = 10000;
export const DETAIL_REQUEST_TIMEOUT_MS = 5000;
// Every tick re-derives the whole fleet's interpolated pose and rebuilds the
// deck.gl layers, so the tick rate is the app's main power draw. Interpolation
// is time-based rather than frame-counted, so a lower rate costs only
// smoothness. Phones get half the frames; a hot device is a worse experience
// than slightly steppier motion.
export const TARGET_FPS = matchMedia('(pointer: coarse)').matches ? 30 : 60;

// A phone screen is a fraction of a desktop window's area, and the map is
// pitched, so zoom 10 opens on the Home Counties with London a smear of
// vehicles near the horizon. Starting closer in puts the camera on the city.
export const IS_NARROW = matchMedia('(max-width: 640px)').matches;
export const INITIAL_ZOOM = IS_NARROW ? 12 : 10;
// Selecting a vehicle brings the camera in to watch it, and the level-of-detail
// bands decide how far in that has to be. Below LOD_MIN_ZOOM (13.5, layers.ts) a
// vehicle is a dot; the cross-fade to models finishes at 14.5 and route blinds
// start at 14, so anything under ~15 is following a dot with no label on it.
// The other end is the model sizing: a bus holds its 24px plateau size until the
// crossover to true scale at z≈16.7 (model-layers.ts), past which it starts
// shrinking into the street. 16 sits between the two — street geometry around
// the vehicle, the vehicle still drawn at full size with its blind.
export const FOLLOW_ZOOM = 16;
// demotiles is a world-scale demo style with no data below country level, so it
// renders as flat blue over London. OpenFreeMap is keyless and serves real
// OpenMapTiles vector data at street zooms.
//
// The basemap follows London's daylight: `bright` in the day for parks, water
// and built-up areas that give the city some shape under the vehicles, `liberty`
// through dusk for a warmer and quieter version of the same, and `dark` at
// night, where the line colours carry the whole image. VITE_MAP_STYLE still
// overrides all three, which is what the mobile builds and any self-hosted tile
// server use.
const OPENFREEMAP = 'https://tiles.openfreemap.org/styles';
const STYLE_OVERRIDE = import.meta.env.VITE_MAP_STYLE;

export const MAP_STYLES: Record<DaylightPhase, string> = {
  day: STYLE_OVERRIDE || `${OPENFREEMAP}/bright`,
  dusk: STYLE_OVERRIDE || `${OPENFREEMAP}/liberty`,
  night: STYLE_OVERRIDE || `${OPENFREEMAP}/dark`,
};

/** The user's basemap choice: follow the sun, or pin it. */
export type BasemapMode = 'auto' | 'day' | 'night';

export function styleForMode(mode: BasemapMode, phase: DaylightPhase): DaylightPhase {
  return mode === 'auto' ? phase : mode;
}

/** Whether a phase's basemap is light, which drives the contrast colours the
 *  route casing and vehicle dots need to stay visible over it. */
export const isLightBasemap = (phase: DaylightPhase) => phase !== 'night';

// The official TfL line colours. Correct wherever a colour is drawn *on* a
// background — sidebar swatches, route polylines. Not correct as a vehicle
// tint: see LIVERY_COLORS below.
export const MODE_COLORS: Record<string, [number, number, number]> = {
  overground: [239, 123, 16],
  lioness: [250, 166, 26],
  mildmay: [0, 119, 187],
  windrush: [237, 27, 80],
  weaver: [130, 58, 88],
  suffragette: [91, 189, 43],
  liberty: [93, 103, 113],
  dlr: [0, 175, 173],
  tram: [0, 189, 25],
  elizabeth: [147, 100, 204],
  bakerloo: [178, 99, 0],
  central: [220, 36, 31],
  circle: [255, 211, 41],
  district: [0, 125, 50],
  'hammersmith-city': [244, 169, 190],
  jubilee: [161, 165, 167],
  metropolitan: [155, 0, 88],
  northern: [35, 31, 32],
  piccadilly: [0, 25, 168],
  victoria: [0, 152, 216],
  'waterloo-city': [147, 206, 186],
};

export const MODE_CATEGORIES: Record<FilterKey, string[]> = {
  bus: ['bus'],
  tube: [
    'bakerloo',
    'central',
    'circle',
    'district',
    'hammersmith-city',
    'jubilee',
    'metropolitan',
    'northern',
    'piccadilly',
    'victoria',
    'waterloo-city',
  ],
  overground: ['overground', 'lioness', 'mildmay', 'windrush', 'weaver', 'suffragette', 'liberty'],
  dlr: ['dlr'],
  tram: ['tram'],
  elizabeth: ['elizabeth'],
};

export const FILTER_ORDER: FilterKey[] = ['bus', 'tube', 'overground', 'dlr', 'tram', 'elizabeth'];

// Representative swatch per category (canonical TfL-inspired colours).
export const FILTER_COLORS: Record<FilterKey, string> = {
  bus: '#DC241F',
  tube: '#000f9f',
  overground: '#EF7B10',
  dlr: '#00AFAD',
  tram: '#00BD19',
  elizabeth: '#9364cc',
};

export const FILTER_LABELS: Record<FilterKey, string> = {
  bus: 'Bus',
  tube: 'Tube',
  overground: 'Overground',
  dlr: 'DLR',
  tram: 'Tram',
  elizabeth: 'Elizabeth line',
};

const TYPE_TO_FILTER: Record<string, FilterKey> = Object.fromEntries(
  (Object.entries(MODE_CATEGORIES) as [FilterKey, string[]][]).flatMap(([key, types]) =>
    types.map((type) => [type, key] as const),
  ),
);

export function filterKeyForType(type: string): FilterKey | null {
  return TYPE_TO_FILTER[type] ?? null;
}

/**
 * The `line` property route features use for a vehicle: buses carry their route
 * number, everything else its route group.
 *
 * Lower-cased because the two sides disagree on case. TfL's arrivals feed
 * reports a lettered route as `SL8` or `C10`, while the route geometry is keyed
 * by the line id, which is `sl8` and `c10`. Matching them literally silently
 * drops every lettered route — 560 vehicles, around 12% of the fleet — from both
 * route highlighting and route-following. Numbered routes were never affected,
 * which is why it went unnoticed. Rail route groups are already lower case, so
 * this is a no-op for them.
 */
export function routeLineId(vehicle: { line: string; routeGroup: string }): string {
  return (vehicle.routeGroup === 'bus' ? vehicle.line : vehicle.routeGroup).toLowerCase();
}

export const BUS_RED = '#DC241F';

const FALLBACK_GREY = '#6b7280';

export function modeColorHex(mode: string): string {
  if (mode === 'bus') {
    return BUS_RED;
  }
  const rgb = MODE_COLORS[mode];
  if (!rgb) {
    return FALLBACK_GREY;
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Livery colours
// ---------------------------------------------------------------------------
//
// Vehicle models are near-white so ScenegraphLayer's getColor multiplies them
// into the line colour. A multiply can only ever darken, so the darkest brand
// colours crush the whole model: Northern (#231F20) rendered a train as a
// featureless black slab, and Piccadilly (#0019A8) as barely distinguishable
// from it. Livery colours are the same hues lifted to a luminance floor —
// bright enough to survive the multiply, close enough to still read as the
// line. Brand colours stay untouched for swatches and route lines.

type Rgb = [number, number, number];

const LIVERY_MIN_LUMINANCE = 0.38;

function relativeLuminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const clamp255 = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/**
 * Brighten to a luminance floor. Gain first — multiplying all three channels
 * preserves hue and saturation — and only once a channel would clip does the
 * remainder come from white, which desaturates. So Piccadilly's navy lifts to a
 * vivid blue rather than a pale one, while a near-neutral like Northern, which
 * has no saturation to preserve, lifts straight to grey.
 */
function liftToFloor(rgb: Rgb, floor = LIVERY_MIN_LUMINANCE): Rgb {
  const luminance = relativeLuminance(rgb);
  if (luminance >= floor) {
    return rgb;
  }

  const gain = Math.min(255 / Math.max(...rgb, 1), floor / Math.max(luminance, 0.001));
  let out: Rgb = [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];

  const gained = relativeLuminance(out);
  if (gained < floor) {
    const toWhite = (floor - gained) / (1 - gained);
    out = [
      out[0] + (255 - out[0]) * toWhite,
      out[1] + (255 - out[1]) * toWhite,
      out[2] + (255 - out[2]) * toWhite,
    ];
  }

  return [clamp255(out[0]), clamp255(out[1]), clamp255(out[2])];
}

export const LIVERY_COLORS: Record<string, Rgb> = Object.fromEntries(
  Object.entries(MODE_COLORS).map(([line, rgb]) => [line, liftToFloor(rgb)]),
);

const FALLBACK_LIVERY: Rgb = [150, 152, 158];

// ---------------------------------------------------------------------------
// Bus livery variation
// ---------------------------------------------------------------------------
//
// ~6,500 buses in one identical red paint central London as a single mass, and
// no amount of thinning fixes that — the fleet has no internal structure to
// see. Varying lightness and saturation per route separates neighbouring buses
// without inventing an arbitrary rainbow: the fleet still reads as London bus
// red, but you can tell one route from the next.

// Wide enough that neighbouring routes separate at a glance, narrow enough
// that the fleet still reads as one colour. The hue term is the smallest of the
// three — a few degrees either side of TfL red spans scarlet to vermilion,
// which is plenty; any more and the buses stop looking like buses.
const BUS_LIGHTNESS_SPREAD = 0.17;
const BUS_SATURATION_SPREAD = 0.16;
const BUS_HUE_SPREAD = 11;

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return [0, 0, lightness];
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === rn) {
    hue = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }
  return [((hue * 60) % 360 + 360) % 360, saturation, lightness];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
}

/** Stable 0..1 from a string. A random draw would make a route's colour change
 *  every time its buses re-enter the viewport. */
function hash01(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const BUS_RED_HSL = rgbToHsl(hexToRgb(BUS_RED));
const busLiveryCache = new Map<string, Rgb>();

export function busLivery(route: string): Rgb {
  const cached = busLiveryCache.get(route);
  if (cached) {
    return cached;
  }
  const [hue, saturation, lightness] = BUS_RED_HSL;
  // Independent draws from three seeds, so the axes don't move in lockstep —
  // one shared draw would give a single dark-to-light ramp rather than a
  // scatter, and half the routes would still collide.
  const lightnessJitter = (hash01(route) * 2 - 1) * BUS_LIGHTNESS_SPREAD;
  const saturationJitter = (hash01(`${route}~s`) * 2 - 1) * BUS_SATURATION_SPREAD;
  const hueJitter = (hash01(`${route}~h`) * 2 - 1) * BUS_HUE_SPREAD;
  const livery = liftToFloor(
    hslToRgb([
      (hue + hueJitter + 360) % 360,
      Math.max(0.4, Math.min(1, saturation + saturationJitter)),
      Math.max(0.24, Math.min(0.72, lightness + lightnessJitter)),
    ]),
  );
  busLiveryCache.set(route, livery);
  return livery;
}

/** The colour a vehicle is drawn in — as a model tint and as a dot fill. */
export function vehicleLivery(vehicle: { type: string; line: string }): Rgb {
  if (vehicle.type === 'bus') {
    return busLivery(vehicle.line);
  }
  return LIVERY_COLORS[vehicle.type] ?? FALLBACK_LIVERY;
}

const toHex = (rgb: Rgb) =>
  `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/**
 * The swatch colour for a line in the sidebar and info panel. Rail keeps its
 * brand colour — that is what people recognise — but a bus takes its livery, so
 * the colour beside `Bus 24` in the list is the colour of the 24s on the map,
 * rather than the one red every route used to share.
 */
export function lineSwatchHex(vehicle: { routeGroup: string; line: string }): string {
  return vehicle.routeGroup === 'bus'
    ? toHex(busLivery(vehicle.line))
    : modeColorHex(vehicle.routeGroup);
}

/** Abbreviations for the on-map route blind, where `Hammersmith & City` has no
 *  room. Buses use their route number unchanged. */
export const LINE_SHORT_CODES: Record<string, string> = {
  bakerloo: 'BAK',
  central: 'CEN',
  circle: 'CIR',
  district: 'DIS',
  'hammersmith-city': 'H&C',
  jubilee: 'JUB',
  metropolitan: 'MET',
  northern: 'NTH',
  piccadilly: 'PIC',
  victoria: 'VIC',
  'waterloo-city': 'W&C',
  elizabeth: 'ELZ',
  dlr: 'DLR',
  tram: 'TRM',
  overground: 'LO',
  lioness: 'LIO',
  mildmay: 'MIL',
  windrush: 'WIN',
  weaver: 'WEA',
  suffragette: 'SUF',
  liberty: 'LIB',
};

export function vehicleLabel(vehicle: { type: string; line: string }): string {
  if (vehicle.type === 'bus') {
    return vehicle.line;
  }
  return LINE_SHORT_CODES[vehicle.type] ?? vehicle.line.slice(0, 3).toUpperCase();
}
