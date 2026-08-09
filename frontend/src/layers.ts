import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { routeLineId, vehicleLabel, vehicleLivery } from './config';
import type { Bounds, VehicleModels, VehicleRow } from './types';

// ---------------------------------------------------------------------------
// Level of detail
// ---------------------------------------------------------------------------
//
// Vehicles used to be drawn as glTF models at every zoom, scaled up by 2^(16-z)
// to hold a constant on-screen size. That only holds for an unpitched camera:
// at pitch 55 the ground scale varies several-fold between the horizon and the
// foreground, so a size chosen to read at the horizon becomes a kilometre-long
// slab in front of it, and central London fills with overlapping boxes.
//
// So the map now has three bands. Zoomed out it is a field of dots — the whole
// fleet, legible, showing where London is moving. Zoomed in it is vehicles.
// Between them the two cross-fade. The dot band is also far cheaper: one
// instanced layer instead of three PBR scenegraphs, which is what lets every
// vehicle be drawn rather than density-thinned away.
//
// The band is set by density, not by when a model becomes legible. A pitched
// camera magnifies the foreground several-fold over the centre scale the size
// is computed from, so a bus that measures 11px at the middle of the screen is
// nearer 40px at the bottom of it — fine on a street, a wall of overlapping
// boxes anywhere central London is still full-frame.
export const LOD_MIN_ZOOM = 13.5;
const LOD_MAX_ZOOM = 14.5;
/** Route blinds appear once models are most of the way in — before that the
 *  labels are bigger than the vehicles they name. */
const LABEL_MIN_ZOOM = 14;

const DOT_RADIUS_BUS = 2.6;
const DOT_RADIUS_RAIL = 4.2;
const DOT_RADIUS_SELECTED = 8;
const DOT_CASING: [number, number, number, number] = [11, 15, 26, 150];

/** Alpha applied to vehicles that are not on the focused line. */
const DIMMED_ALPHA = 45;

const MAX_LABELS = 220;
/** Label bin size in degrees at zoom 0, halving each level to hold ~44px —
 *  about one route blind, so at most one label lands per blind-sized cell. */
const LABEL_CELL_DEG_AT_ZOOM_0 = 30.9;

/**
 * deck's default lights are tuned for extruded polygons, and under them the
 * vehicle bodies come out muddy — a TfL red arrives on screen as brown. Lifting
 * the ambient term is what recovers the livery colour; the two directionals,
 * one high and one low from the opposite side, are there to keep the roof, the
 * sides and the window bands distinguishable rather than flattening the model
 * back into a coloured blob.
 *
 * A module-level singleton, not a per-frame value: deck rebuilds its lighting
 * uniforms whenever the effect identity changes.
 */
export const vehicleLighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 2.1 }),
  key: new DirectionalLight({
    color: [255, 251, 240],
    intensity: 1.35,
    direction: [-1.2, -3, -1.6],
  }),
  fill: new DirectionalLight({ color: [206, 220, 255], intensity: 0.55, direction: [1.6, -1, 1] }),
});

/** One bucket per model shape: ScenegraphLayer takes a single scenegraph, not a
 *  per-row accessor, so each shape needs its own layer and so its own data. */
export type FleetBuckets = {
  all: VehicleRow[];
  bus: VehicleRow[];
  tram: VehicleRow[];
  dlr: VehicleRow[];
  elizabeth: VehicleRow[];
  /** Deep-tube and Overground stock — everything without a shape of its own. */
  rail: VehicleRow[];
};

/**
 * Apply the sidebar filters and split the fleet by model shape in one pass.
 * This runs on every animation frame — positions interpolate, so the rows are
 * rebuilt regardless — which is why it is one pass and not the filter plus
 * three `Array.filter` scans it replaces.
 */
export function bucketFleet(
  rows: VehicleRow[],
  include: (row: VehicleRow) => boolean,
): FleetBuckets {
  const buckets: FleetBuckets = {
    all: [],
    bus: [],
    tram: [],
    dlr: [],
    elizabeth: [],
    rail: [],
  };
  for (const row of rows) {
    if (!include(row)) {
      continue;
    }
    buckets.all.push(row);
    const bucket = buckets[row.type as keyof FleetBuckets];
    // `all` is not a vehicle type, so a type colliding with it would be a bug
    // rather than a bucket; every other key is one of the model shapes.
    if (Array.isArray(bucket) && row.type !== 'all') {
      bucket.push(row);
    } else {
      buckets.rail.push(row);
    }
  }
  return buckets;
}

function hash01(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Pick which vehicles get a route blind. Labels over-plot far faster than
 * vehicles do, so at most one lands per blind-sized screen cell, chosen by a
 * hash of the vehicle id — stable, so a label does not hop between neighbours
 * frame to frame — and the survivors are capped. The selection always keeps its
 * label.
 */
function chooseLabels(
  rows: VehicleRow[],
  zoom: number,
  selectedId: string | null,
  bounds: Bounds | null,
): VehicleRow[] {
  const cellDeg = LABEL_CELL_DEG_AT_ZOOM_0 / Math.pow(2, zoom);
  const bestPerCell = new Map<number, { row: VehicleRow; rank: number }>();
  let selected: VehicleRow | null = null;

  for (const row of rows) {
    if (row.id === selectedId) {
      selected = row;
      continue;
    }
    // The socket subscription is padded well beyond the viewport, and at street
    // zoom most of the fleet it carries is off screen. Spending the label budget
    // on vehicles nobody can see is how Trafalgar Square ended up with one
    // labelled bus.
    if (
      bounds &&
      (row.position[0] < bounds.west ||
        row.position[0] > bounds.east ||
        row.position[1] < bounds.south ||
        row.position[1] > bounds.north)
    ) {
      continue;
    }
    // Numeric cell keys: string keys would allocate twice per vehicle per frame.
    const cell =
      (Math.floor(row.position[0] / cellDeg) + 32768) * 65536 +
      Math.floor(row.position[1] / cellDeg) +
      32768;
    // Rail is rarer and more informative than a bus, so it wins a contested
    // cell regardless of hash.
    const rank = hash01(row.id) - (row.type === 'bus' ? 0 : 1);
    const existing = bestPerCell.get(cell);
    if (!existing || rank < existing.rank) {
      bestPerCell.set(cell, { row, rank });
    }
  }

  const labels: VehicleRow[] = [];
  if (selected) {
    labels.push(selected);
  }

  const survivors = [...bestPerCell.values()];
  if (survivors.length <= MAX_LABELS) {
    for (const entry of survivors) {
      labels.push(entry.row);
    }
    return labels;
  }

  // Central London holds several hundred rail vehicles, so ranking the whole
  // set and taking the top slice would spend the entire budget on rail and
  // never label a bus. The budget is split instead, and either side's unclaimed
  // share falls to the other.
  const rail = survivors.filter((entry) => entry.row.type !== 'bus').sort((a, b) => a.rank - b.rank);
  const bus = survivors.filter((entry) => entry.row.type === 'bus').sort((a, b) => a.rank - b.rank);
  const railBudget = Math.min(rail.length, Math.round(MAX_LABELS * 0.55));
  const busBudget = Math.min(bus.length, MAX_LABELS - railBudget);

  for (const entry of rail.slice(0, MAX_LABELS - busBudget)) {
    labels.push(entry.row);
  }
  for (const entry of bus.slice(0, busBudget)) {
    labels.push(entry.row);
  }
  return labels;
}

/** White or near-black, whichever the livery can carry. */
function labelInk(livery: [number, number, number]): [number, number, number] {
  const luminance = (0.2126 * livery[0] + 0.7152 * livery[1] + 0.0722 * livery[2]) / 255;
  return luminance > 0.6 ? [16, 20, 32] : [255, 255, 255];
}

export type VehicleLayerOptions = {
  models: VehicleModels | null;
  fleet: FleetBuckets;
  zoom: number;
  onSelect: (row: VehicleRow) => void;
  onHover: (row: VehicleRow | null) => void;
  selectedId: string | null;
  hoveredId: string | null;
  /** When set, everything not on this route id is dimmed back. */
  focusLine: string | null;
  /** Current viewport, used to keep the label budget on screen. */
  bounds: Bounds | null;
  /** Injected once `./model-layers` has been dynamically imported; until then
   *  the map stays in its dot band regardless of zoom. */
  buildModels: ModelLayerBuilder | null;
};

export type ModelLayerBuilder = (params: {
  models: VehicleModels;
  fleet: FleetBuckets;
  zoom: number;
  opacity: number;
  getColor: (row: VehicleRow) => [number, number, number, number];
  onClick: (info: { object?: VehicleRow }) => void;
  onHover: (info: { object?: VehicleRow }) => void;
  colorTrigger: string;
}) => Layer[];

export function buildVehicleLayers({
  models,
  fleet,
  zoom,
  onSelect,
  onHover,
  selectedId,
  hoveredId,
  focusLine,
  bounds,
  buildModels,
}: VehicleLayerOptions) {
  const modelOpacity = clamp01((zoom - LOD_MIN_ZOOM) / (LOD_MAX_ZOOM - LOD_MIN_ZOOM));
  const dotOpacity = 1 - modelOpacity;
  const showDots = dotOpacity > 0.01;

  // Dots grow towards the hand-off: a 2.6px dot is right over a whole city, but
  // by the time the camera is at street level it has to hold its own against a
  // basemap full of orange roads, and against the models it is fading into.
  const dotScale = 1 + clamp01((zoom - 10) / (LOD_MAX_ZOOM - 10)) * 0.6;

  const isDimmed = (row: VehicleRow) => focusLine !== null && routeLineId(row) !== focusLine;
  const vehicleColor = (row: VehicleRow): [number, number, number, number] => {
    const [r, g, b] = vehicleLivery(row);
    return [r, g, b, isDimmed(row) ? DIMMED_ALPHA : 255];
  };
  const emphasis = (row: VehicleRow) => row.id === selectedId || row.id === hoveredId;

  const handleClick = ({ object }: { object?: VehicleRow }) => {
    if (object) {
      onSelect(object);
    }
  };
  const handleHover = ({ object }: { object?: VehicleRow }) => {
    onHover(object ?? null);
  };
  // Accessors that read selection or focus have to be re-evaluated when those
  // change, but not otherwise — deck.gl only recomputes an attribute when its
  // trigger does, so this is what keeps a 6,500-row upload off every frame.
  const stateTrigger = `${selectedId}|${hoveredId}|${focusLine}`;

  const layers: Layer[] = [];

  if (showDots) {
    layers.push(
      new ScatterplotLayer<VehicleRow>({
        id: 'vehicles-dots',
        data: fleet.all,
        opacity: dotOpacity,
        radiusUnits: 'pixels',
        radiusMinPixels: 1.5,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 0.9,
        getLineColor: DOT_CASING,
        getPosition: (d) => d.position,
        getRadius: (d) =>
          emphasis(d)
            ? DOT_RADIUS_SELECTED
            : dotScale * (d.type === 'bus' ? DOT_RADIUS_BUS : DOT_RADIUS_RAIL),
        getFillColor: vehicleColor,
        pickable: true,
        onClick: handleClick,
        onHover: handleHover,
        updateTriggers: { getRadius: stateTrigger, getFillColor: stateTrigger },
      }),
    );
  }

  if (buildModels && models && modelOpacity > 0.01) {
    layers.push(
      ...buildModels({
        models,
        fleet,
        zoom,
        opacity: modelOpacity,
        getColor: vehicleColor,
        onClick: handleClick,
        onHover: handleHover,
        colorTrigger: stateTrigger,
      }),
    );
  }

  if (zoom >= LABEL_MIN_ZOOM) {
    const labelled = chooseLabels(fleet.all, zoom, selectedId, bounds);
    layers.push(
      new TextLayer<VehicleRow>({
        id: 'vehicle-labels',
        data: labelled,
        // The blind is a fixed-size UI element, not part of the scene.
        billboard: true,
        sizeUnits: 'pixels',
        getSize: 11,
        getPixelOffset: [0, -30],
        fontWeight: 700,
        // A bus route is digits and at most two letters; keeping the atlas to
        // that avoids rasterising a font the map never draws.
        characterSet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&',
        background: true,
        backgroundPadding: [5, 2, 5, 2],
        getBorderWidth: 1,
        getBorderColor: [255, 255, 255, 190],
        getPosition: (d) => d.position,
        getText: (d) => vehicleLabel(d),
        getColor: (d) => labelInk(vehicleLivery(d)),
        getBackgroundColor: (d) => {
          const [r, g, b] = vehicleLivery(d);
          return [r, g, b, isDimmed(d) ? 60 : 235];
        },
        // Labels are decoration for the vehicle beneath them; picking one would
        // shadow the model it names.
        pickable: false,
        updateTriggers: { getBackgroundColor: stateTrigger },
      }),
    );
  }

  return layers;
}
