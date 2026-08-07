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
// demotiles is a world-scale demo style with no data below country level, so it
// renders as flat blue over London. OpenFreeMap is keyless and serves real
// OpenMapTiles vector data at street zooms.
export const MAP_STYLE =
  import.meta.env.VITE_MAP_STYLE || 'https://tiles.openfreemap.org/styles/positron';

// Rail model bodies are near-white so this tint multiplies them into the
// official TfL line colours; the bus model carries its own baked-in red.
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
