/**
 * Colours for the store artwork.
 *
 * Duplicated from frontend/src/config.ts (MODE_COLORS, FILTER_COLORS) and
 * frontend/src/App.css (the chrome tokens) rather than imported, because those
 * are TypeScript and this runs in bare node. If a line colour changes there,
 * change it here too — nothing enforces it.
 */

/** App chrome, from App.css :root. */
export const APP = {
  bg: '#0b0f1a',
  panel: 'rgba(15,20,34,0.86)',
  panelBorder: 'rgba(148,163,184,0.22)',
  text: '#e6eaf2',
  textDim: '#94a3b8',
  accent: '#38bdf8',
  connected: '#4ade80',
};

/** House style, from the design language: chalk paper and grape ink. */
export const PAPER = {
  chalk: '#faf8f4',
  raised: '#ffffff',
  ink: '#444054',
  muted: '#6e6b7c',
  dim: '#b6b3bf',
  border: '#e6e4ea',
  inputBorder: '#d8d5dd',
  azure: '#007fff',
  amber: '#ffbf00',
};

export const BUS_RED = '#DC241F';

/** TfL line colours, keyed by the `mode` property carried in routes.json. */
export const MODE_COLORS = {
  overground: '#ef7b10',
  lioness: '#faa61a',
  mildmay: '#0077bb',
  windrush: '#ed1b50',
  weaver: '#823a58',
  suffragette: '#5bbd2b',
  liberty: '#5d6771',
  dlr: '#00afad',
  tram: '#00bd19',
  elizabeth: '#9364cc',
  bakerloo: '#b26300',
  central: '#dc241f',
  circle: '#ffd329',
  district: '#007d32',
  'hammersmith-city': '#f4a9be',
  jubilee: '#a1a5a7',
  metropolitan: '#9b0058',
  northern: '#231f20',
  piccadilly: '#0019a8',
  victoria: '#0098d8',
  'waterloo-city': '#93cebA',
};

/** The six sidebar filters and their representative swatch. */
export const FILTERS = [
  ['Bus', '#DC241F'],
  ['Tube', '#000f9f'],
  ['Overground', '#EF7B10'],
  ['DLR', '#00AFAD'],
  ['Tram', '#00BD19'],
  ['Elizabeth line', '#9364cc'],
];

export const colorForMode = (mode) => MODE_COLORS[mode] ?? BUS_RED;
export const isRail = (mode) => mode in MODE_COLORS;

// ---------------------------------------------------------------------------
// Service palettes for the artwork
// ---------------------------------------------------------------------------

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const rgbToHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const relativeLuminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Brighten to a luminance floor — a direct port of `liftToFloor` in
 * frontend/src/config.ts, which exists because a near-black brand colour like
 * Piccadilly's #0019A8 or Northern's #231F20 vanishes against a dark ground.
 * The app hits this when tinting vehicle models; artwork hits it the moment a
 * line colour is drawn on #0b0f1a.
 *
 * Gain first, since multiplying all three channels preserves hue and
 * saturation, and only once a channel clips does the remainder come from white.
 * So the tube navy lifts to a vivid blue rather than a washed-out one.
 *
 * The floor is lower than the app's 0.38 on purpose. That one has to survive a
 * multiply into a near-white model; this only has to sit on #0b0f1a. Keeping it
 * at 0.24 leaves London bus red (0.29) untouched, which matters — it is the
 * single most recognisable colour in the whole set.
 */
export function liftToFloor(hex, floor = 0.24) {
  const rgb = hexToRgb(hex);
  const luminance = relativeLuminance(rgb);
  if (luminance >= floor) return hex;

  const gain = Math.min(255 / Math.max(...rgb, 1), floor / Math.max(luminance, 0.001));
  let out = [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];

  const gained = relativeLuminance(out);
  if (gained < floor) {
    const toWhite = (floor - gained) / (1 - gained);
    out = out.map((c) => c + (255 - c) * toWhite);
  }
  return rgbToHex(out.map(clamp255));
}

/**
 * The app's own six modes, in the order the sidebar lists them. This is the
 * service's identity as the product already expresses it — a bus is London
 * red, the tube is Underground navy — rather than an arbitrary spectrum.
 */
export const MODE_PALETTE = FILTERS.map(([, colour]) => colour);

/**
 * The Underground line palette people can name on sight: Central, Piccadilly,
 * District, Circle, Metropolitan, Bakerloo.
 */
export const TUBE_PALETTE = [
  MODE_COLORS.central,
  MODE_COLORS.piccadilly,
  MODE_COLORS.district,
  MODE_COLORS.circle,
  MODE_COLORS.metropolitan,
  MODE_COLORS.bakerloo,
];

/** A palette lifted for use on the dark ground. */
export const forDark = (palette) => palette.map((hex) => liftToFloor(hex));
