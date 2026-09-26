import type { FeatureCollection, Point } from 'geojson';
import type { SelectedStop } from './components/StopPanel';
import type { StopRecord } from './stop-index';

/**
 * The stop markers' GeoJSON, and the way back from a clicked marker to a stop.
 *
 * Kept together because they are two halves of one contract: the click handler
 * can only read what the source was given. The source once carried only `name`,
 * so every tapped stop asked for arrivals at `/stops/undefined`.
 */
export function stopFeatureCollection(stops: StopRecord[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: stops.map((stop) => ({
      type: 'Feature',
      properties: { id: stop.id, name: stop.name },
      geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
    })),
  };
}

/** Null when the feature is missing the id — better no panel than a broken one. */
export function stopFromFeature(
  properties: Record<string, unknown> | null | undefined,
  coordinates: [number, number],
): SelectedStop | null {
  const id = properties?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return { id, name: String(properties?.name ?? ''), coordinates };
}
