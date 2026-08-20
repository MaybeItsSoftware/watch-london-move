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
// Service palette for the artwork
// ---------------------------------------------------------------------------

/**
 * The app's own six modes, in the order the sidebar lists them. This is the
 * service's identity as the product already expresses it — a bus is London
 * red, the tube is Underground navy — rather than an arbitrary spectrum.
 */
export const MODE_PALETTE = FILTERS.map(([, colour]) => colour);
