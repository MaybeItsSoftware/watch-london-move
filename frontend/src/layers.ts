import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { MODE_COLORS } from './config';
import type { VehicleModels, VehicleRow } from './types';

// Below THIN_MIN_ZOOM the fleet is thinned hardest; by THIN_MAX_ZOOM every
// vehicle is drawn again. The ramp between them avoids a visible pop.
const THIN_MIN_ZOOM = 11;
const THIN_MAX_ZOOM = 13;
// Vehicles kept per cell = n^MIN_EXPONENT. Sublinear, so a cell with 10x the
// traffic still draws visibly more — just not 10x more.
const MIN_EXPONENT = 0.45;
// Bin size in degrees at zoom 0; halves each zoom level to hold ~36px on screen,
// about one vehicle glyph, so a thinned cell reads as roughly one vehicle deep.
const CELL_DEG_AT_ZOOM_0 = 25.3;

/** Stable 0..1 from a vehicle id. A random draw would make buses flicker. */
function hash01(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

/**
 * Zoomed out, London's ~6,500 buses paint the centre as one solid mass. Thinning
 * per grid cell — keeping n^exponent of each cell's n vehicles — drops the most
 * where traffic is densest, so congestion still reads as congestion while
 * individual vehicles stay legible. Counts elsewhere in the UI are unaffected:
 * this only changes what is drawn.
 */
function thinByDensity(rows: VehicleRow[], zoom: number, keepId: string | null): VehicleRow[] {
  const ramp = Math.min(Math.max((zoom - THIN_MIN_ZOOM) / (THIN_MAX_ZOOM - THIN_MIN_ZOOM), 0), 1);
  const exponent = MIN_EXPONENT + (1 - MIN_EXPONENT) * ramp;
  if (exponent >= 1) {
    return rows;
  }

  const cellDeg = CELL_DEG_AT_ZOOM_0 / Math.pow(2, zoom);
  // Numeric cell keys: string keys would allocate twice per vehicle per frame.
  const cellOf = (row: VehicleRow) =>
    (Math.floor(row.position[0] / cellDeg) + 32768) * 65536 +
    Math.floor(row.position[1] / cellDeg) +
    32768;

  const counts = new Map<number, number>();
  for (const row of rows) {
    const cell = cellOf(row);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }

  return rows.filter((row) => {
    if (row.id === keepId) {
      return true;
    }
    const total = counts.get(cellOf(row)) ?? 1;
    return total <= 1 || hash01(row.id) < Math.pow(total, exponent) / total;
  });
}

export function buildVehicleLayers(
  models: VehicleModels,
  rows: VehicleRow[],
  zoom: number,
  onSelect: (row: VehicleRow) => void,
  selectedId: string | null = null,
) {
  // Models are authored at real-world scale in metres. At street zoom they
  // render near-true size; each zoom level out they double in world units,
  // holding a constant on-screen size, so vehicles stay chunky and readable
  // — cutely oversized — at city-wide zooms instead of shrinking to specks.
  const sizeScale = (base: number) => Math.max(1, base * Math.pow(2, 16 - zoom));

  // `scenegraph` is one model per layer, not a per-row accessor — passing a
  // function leaves the layer with no model at all, so each mode gets its
  // own layer.
  const vehicleLayer = (
    id: string,
    model: unknown,
    data: VehicleRow[],
    scale: number,
    getColor: (d: VehicleRow) => [number, number, number],
  ) =>
    new ScenegraphLayer<VehicleRow>({
      id,
      data,
      scenegraph: model,
      sizeScale: scale,
      _lighting: 'pbr',
      getPosition: (d) => d.position,
      getOrientation: (d) => [0, -d.heading, 90],
      getColor,
      pickable: true,
      onClick: ({ object }) => {
        if (object) {
          onSelect(object);
        }
      },
    });

  // Trains are ~40m to the bus's 11m, so they get a smaller base scale to
  // keep the fleet visually balanced.
  return [
    vehicleLayer(
      'vehicles-bus',
      models.bus,
      // Buses outnumber everything else 7:1, so only they need thinning.
      thinByDensity(
        rows.filter((v) => v.type === 'bus'),
        zoom,
        selectedId,
      ),
      sizeScale(1.5),
      () => [255, 255, 255],
    ),
    vehicleLayer(
      'vehicles-tram',
      models.tram,
      rows.filter((v) => v.type === 'tram'),
      sizeScale(1.2),
      () => MODE_COLORS.tram,
    ),
    vehicleLayer(
      'vehicles-train',
      models.train,
      rows.filter((v) => v.type !== 'bus' && v.type !== 'tram'),
      sizeScale(1.0),
      (d) => MODE_COLORS[d.type] ?? [90, 90, 90],
    ),
  ];
}
