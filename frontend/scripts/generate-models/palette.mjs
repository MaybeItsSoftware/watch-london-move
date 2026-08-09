// Every body is near-white so ScenegraphLayer's getColor tint multiplies it
// into the vehicle's livery colour — including the bus, whose red used to be
// baked in and so was identical across all ~640 routes. See LIVERY_COLORS and
// busLivery in src/config.ts.
//
// The non-body colours are all dark on purpose: a multiply can only darken, so
// glass, wheels and underframes survive any livery unchanged while the body
// takes the colour.
export const COLORS = {
  glass: [0.09, 0.1, 0.13],
  black: [0.05, 0.05, 0.05],
  darkGrey: [0.22, 0.22, 0.24],
  bodyWhite: [0.93, 0.93, 0.93],
  doorGrey: [0.72, 0.72, 0.75],
  lampWhite: [0.95, 0.9, 0.7],
};
