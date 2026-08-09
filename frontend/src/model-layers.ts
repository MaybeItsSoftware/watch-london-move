import type { Layer } from '@deck.gl/core';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader, postProcessGLTF } from '@loaders.gl/gltf';
import type { FleetBuckets } from './layers';
import type { VehicleModels, VehicleRow } from './types';

/**
 * The 3D half of the map, kept in its own module so it can be imported
 * dynamically.
 *
 * `@deck.gl/mesh-layers` depends on `@loaders.gl/gltf`, so any static reference
 * to ScenegraphLayer drags the whole glTF stack — several hundred kilobytes —
 * into the first chunk the browser must parse before it can draw anything. The
 * models are only ever used above the level-of-detail threshold, so a session
 * that never zooms past a city-wide view should never pay for them, and one
 * that does pays while it is already looking at something.
 */

// A floor on a model's on-screen length, in pixels. deck's sizeMinPixels bounds
// the projected size of *one world unit* — one metre here, not one vehicle — so
// it is derived per layer from the model's real length rather than set
// directly. There is deliberately no matching maximum: any absolute pixel cap
// stops the models growing while the basemap keeps doubling, so past the zoom
// where it engages the fleet visibly shrinks into the streets underneath it.
const MODEL_MIN_PIXELS = 8;

/**
 * Metres per pixel at London's latitude (51.5°) inverts to this many pixels per
 * metre at zoom 16 — deck uses 512px tiles, so 78271.5·cos(φ)/2^16 m/px.
 */
const PIXELS_PER_METER_AT_Z16 = 1.345;

/**
 * Real lengths of the generated models, in metres, and how long each should
 * read on screen while the camera is far enough out that true scale would be
 * illegible. A 102m Elizabeth unit at true relative size would dwarf the road
 * network it shares the map with, so the targets ramp sub-linearly: rail still
 * reads as longer than a bus, without taking over the view.
 */
const MODELS = [
  { key: 'bus', bucket: 'bus', lengthMeters: 11.2, plateauPixels: 24 },
  { key: 'tram', bucket: 'tram', lengthMeters: 24.7, plateauPixels: 30 },
  { key: 'dlr', bucket: 'dlr', lengthMeters: 28.5, plateauPixels: 32 },
  { key: 'train', bucket: 'rail', lengthMeters: 40.4, plateauPixels: 38 },
  { key: 'elizabeth', bucket: 'elizabeth', lengthMeters: 102.4, plateauPixels: 48 },
] as const;

/**
 * Doubling the world size per zoom level out holds a constant on-screen size —
 * the model's `plateauPixels` — while the camera is far away; flooring at 1
 * hands the models over to true real-world scale once it is close enough for
 * that to look right rather than tiny. The two regimes meet continuously, so
 * there is no pop at the crossover (z≈14.5 for the Elizabeth line, z≈16.7 for
 * a bus).
 */
function sizeScale(model: (typeof MODELS)[number], zoom: number): number {
  const base = model.plateauPixels / (model.lengthMeters * PIXELS_PER_METER_AT_Z16);
  return Math.max(1, base * Math.pow(2, 16 - zoom));
}

/** Fetched under these names from public/models. */
export const MODEL_NAMES = MODELS.map((model) => model.key);

export type ModelLayerParams = {
  models: VehicleModels;
  fleet: FleetBuckets;
  zoom: number;
  opacity: number;
  getColor: (row: VehicleRow) => [number, number, number, number];
  onClick: (info: { object?: VehicleRow }) => void;
  onHover: (info: { object?: VehicleRow }) => void;
  colorTrigger: string;
};

export function buildModelLayers({
  models,
  fleet,
  zoom,
  opacity,
  getColor,
  onClick,
  onHover,
  colorTrigger,
}: ModelLayerParams): Layer[] {
  // `scenegraph` is one model per layer, not a per-row accessor — passing a
  // function leaves the layer with no model at all, so each shape gets its
  // own layer.
  return MODELS.filter((model) => fleet[model.bucket].length > 0).map(
    (model) =>
      new ScenegraphLayer<VehicleRow>({
        id: `vehicles-${model.key}`,
        data: fleet[model.bucket],
        scenegraph: models[model.key],
        opacity,
        sizeScale: sizeScale(model, zoom),
        sizeMinPixels: MODEL_MIN_PIXELS / model.lengthMeters,
        _lighting: 'pbr',
        getPosition: (d) => d.position,
        // The geometry is authored +x-forward (scripts/generate-models). deck
        // composes Rz(yaw)·Ry(pitch)·Rx(roll) in common space, where x is east
        // and y north, so roll 90 stands the model upright and yaw 90−heading
        // swings its nose round onto the compass bearing.
        getOrientation: (d) => [0, 90 - d.heading, 90],
        getColor,
        pickable: true,
        onClick,
        onHover,
        updateTriggers: { getColor: colorTrigger },
      }),
  );
}

/**
 * ScenegraphLayer needs a post-processed glTF: parsing alone leaves the
 * accessors unresolved and the layer rejects the geometry.
 */
export async function loadVehicleModels(): Promise<VehicleModels> {
  const loaded = await Promise.all(
    // BASE_URL, not a leading slash: the native build is served from a
    // capacitor://localhost document root rather than a web server root.
    MODEL_NAMES.map((name) =>
      load(`${import.meta.env.BASE_URL}models/${name}.glb`, GLTFLoader).then((gltf) =>
        postProcessGLTF(gltf),
      ),
    ),
  );
  return Object.fromEntries(
    MODEL_NAMES.map((name, index) => [name, loaded[index]]),
  ) as unknown as VehicleModels;
}
