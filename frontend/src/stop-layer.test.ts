import { describe, expect, it } from 'vitest';
import { stopFeatureCollection, stopFromFeature } from './stop-layer';

describe('stop layer', () => {
  const stop = { id: '490000077E', lat: 51.5, lon: -0.1, name: 'Oxford Circus' };

  it('carries the stop id on each marker, so a tap can ask for its arrivals', () => {
    const [feature] = stopFeatureCollection([stop]).features;
    expect(feature.properties).toEqual({ id: '490000077E', name: 'Oxford Circus' });
    expect(feature.geometry.coordinates).toEqual([-0.1, 51.5]);
  });

  it('round-trips a marker back to the selected stop', () => {
    const [feature] = stopFeatureCollection([stop]).features;
    expect(stopFromFeature(feature.properties, [-0.1, 51.5])).toEqual({
      id: '490000077E',
      name: 'Oxford Circus',
      coordinates: [-0.1, 51.5],
    });
  });

  it('refuses a marker with no id rather than opening a panel for "undefined"', () => {
    expect(stopFromFeature({ name: 'Oxford Circus' }, [0, 0])).toBeNull();
    expect(stopFromFeature(null, [0, 0])).toBeNull();
  });
});
