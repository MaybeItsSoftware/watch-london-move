import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { load } from '@loaders.gl/core';
import { GLTFLoader, postProcessGLTF } from '@loaders.gl/gltf';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
import {
  BACKEND_URL,
  BUS_RED,
  DETAIL_REFRESH_MS,
  FILTER_ORDER,
  INITIAL_ZOOM,
  IS_NARROW,
  MAP_STYLE,
  MODE_COLORS,
  VIEWPORT_DEBOUNCE_MS,
  VIEWPORT_PADDING_RATIO,
  filterKeyForType,
  modeColorHex,
} from './config';
import { buildVehicleLayers } from './layers';
import { useNativeShell } from './lifecycle';
import { useVehicles } from './useVehicles';
import { InfoPanel } from './components/InfoPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import type {
  FilterKey,
  LineSummary,
  VehicleDetail,
  VehicleModels,
  VehicleRow,
} from './types';

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };
const NO_HIGHLIGHT_FILTER: ExpressionSpecification = ['==', ['get', 'line'], '__none__'];
const ROUTES_GIVE_UP_MS = 5 * 60 * 1000;
const ROUTES_REFRESH_MS = 60 * 1000;
// Rows re-derive every animation frame; the sidebar list only needs to be
// roughly live, so it is rebuilt on a timer instead.
const LINE_INDEX_INTERVAL_MS = 1500;

function routeColorExpression(): ExpressionSpecification {
  const branches: string[] = [];
  for (const line of Object.keys(MODE_COLORS)) {
    branches.push(line, modeColorHex(line));
  }
  // Anything not in MODE_COLORS is a bus route number.
  return ['match', ['get', 'line'], ...branches, BUS_RED] as unknown as ExpressionSpecification;
}

/** The `line` property route features use for a vehicle: buses carry their
 * route number, everything else its route group. */
function routeLineId(vehicle: { line: string; routeGroup: string }): string {
  return vehicle.routeGroup === 'bus' ? vehicle.line : vehicle.routeGroup;
}

/** Group order first, then natural order so bus route 9 sorts before 133. */
function compareLines(a: LineSummary, b: LineSummary): number {
  const byGroup = FILTER_ORDER.indexOf(a.group) - FILTER_ORDER.indexOf(b.group);
  if (byGroup !== 0) {
    return byGroup;
  }
  return a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' });
}

function App() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const zoomRef = useRef(10);
  const selectedIdRef = useRef<string | null>(null);
  const routeLinesRef = useRef<Set<string> | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [routesLoaded, setRoutesLoaded] = useState(false);
  const [showRoutes, setShowRoutes] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  // Open on a desktop, where it sits beside the map; closed on a phone, where
  // it is a sheet covering half of it and the map is the point.
  const [sidebarOpen, setSidebarOpen] = useState(!IS_NARROW);
  const [search, setSearch] = useState('');
  // Empty means "every line"; otherwise only these route ids are shown.
  const [selectedLines, setSelectedLines] = useState<string[]>([]);
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    bus: true,
    tube: true,
    overground: true,
    dlr: true,
    tram: true,
    elizabeth: true,
  });
  // ScenegraphLayer needs a post-processed glTF: parsing alone leaves the
  // accessors unresolved and the layer rejects the geometry.
  const [models, setModels] = useState<VehicleModels | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // The highlight effect below reacts to selectedId, so clearing it is enough.
  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setFollowing(false);
  }, []);

  const handleVehicleRemoved = useCallback(
    (id: string) => {
      if (selectedIdRef.current === id) {
        clearSelection();
      }
    },
    [clearSelection],
  );

  const { rows, connectionStatus, lastPayloadAt, api, setViewport } =
    useVehicles(handleVehicleRemoved);

  // Dismiss the native splash once the basemap is up and the vehicle models
  // have loaded — i.e. once the first frame is worth showing.
  useNativeShell(mapReady && models !== null);

  useEffect(() => {
    let cancelled = false;

    // BASE_URL, not a leading slash: the native build is served from a
    // capacitor://localhost document root rather than a web server root.
    Promise.all(
      ['bus', 'train', 'tram'].map((name) =>
        load(`${import.meta.env.BASE_URL}models/${name}.gltf`, GLTFLoader).then((gltf) =>
          postProcessGLTF(gltf),
        ),
      ),
    )
      .then(([bus, train, tram]) => {
        if (!cancelled) {
          setModels({ bus, train, tram });
        }
      })
      .catch((error) => {
        console.error('Could not load vehicle models', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [-0.1276, 51.5072],
      zoom: INITIAL_ZOOM,
      pitch: 55,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    if (import.meta.env.DEV) {
      (window as unknown as { __map?: maplibregl.Map }).__map = map;
    }

    zoomRef.current = map.getZoom();
    map.on('zoom', () => {
      zoomRef.current = map.getZoom();
    });

    // Follow mode disengages on user gestures only: programmatic easeTo fires
    // the same camera events but without originalEvent, which cleanly
    // separates the two.
    const disengageFollow = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) {
        setFollowing(false);
      }
    };
    map.on('dragstart', disengageFollow);
    map.on('wheel', disengageFollow);
    map.on('pitchstart', disengageFollow);
    map.on('rotatestart', disengageFollow);

    map.on('load', () => {
      // Route polylines are added to the style before the deck overlay is
      // created so vehicles always draw on top of them.
      map.addSource('routes', { type: 'geojson', data: EMPTY_COLLECTION });
      map.addLayer({
        id: 'routes-base',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': routeColorExpression(),
          'line-width': 1.5,
          'line-opacity': 0.3,
        },
      });
      map.addLayer({
        id: 'routes-highlight',
        type: 'line',
        source: 'routes',
        filter: NO_HIGHLIGHT_FILTER,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': routeColorExpression(),
          'line-width': 4,
          'line-opacity': 0.9,
        },
      });

      // Fallback breadcrumb trail when no route geometry exists for a line.
      map.addSource('highlight-route', { type: 'geojson', data: EMPTY_COLLECTION });
      map.addLayer({
        id: 'highlight-route',
        type: 'line',
        source: 'highlight-route',
        paint: {
          'line-color': '#ff3366',
          'line-width': 5,
          'line-opacity': 0.9,
        },
      });

      // A fingertip is nowhere near pixel-accurate, and the target is a small
      // moving 3D model, so picking gets a radius rather than the default 0.
      const overlay = new MapboxOverlay({ interleaved: true, layers: [], pickingRadius: 8 });
      map.addControl(overlay);
      overlayRef.current = overlay;
      setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      overlayRef.current?.finalize();
      overlayRef.current = null;
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Fetch route geometry with backoff: the backend answers 503 while it is
  // still assembling routes, and may be entirely absent in dev.
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    let delay = 5000;

    const attempt = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/routes`);
        if (!response.ok) {
          throw new Error(`routes not ready (HTTP ${response.status})`);
        }
        const complete = response.headers.get('X-Routes-Complete') === 'true';
        const collection = (await response.json()) as FeatureCollection;
        if (cancelled) {
          return;
        }
        const lines = new Set<string>();
        for (const feature of collection.features ?? []) {
          const line = feature.properties?.line;
          if (typeof line === 'string') {
            lines.add(line);
          }
        }
        routeLinesRef.current = lines;
        (mapRef.current?.getSource('routes') as GeoJSONSource | undefined)?.setData(collection);
        setRoutesLoaded(true);
        // Every bus route's geometry takes the backend many minutes to build, so
        // a partial set is drawn now and topped up until it is complete.
        if (!complete) {
          timer = window.setTimeout(attempt, ROUTES_REFRESH_MS);
        }
      } catch {
        if (cancelled) {
          return;
        }
        // A failed top-up keeps to the slow cadence; only the initial load backs
        // off and eventually gives up.
        if (routeLinesRef.current) {
          timer = window.setTimeout(attempt, ROUTES_REFRESH_MS);
          return;
        }
        if (Date.now() - startedAt > ROUTES_GIVE_UP_MS) {
          return;
        }
        timer = window.setTimeout(attempt, delay);
        delay = Math.min(delay * 2, 30000);
      }
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [mapReady]);

  // Tell the backend what is on screen: it streams per grid tile, so this is
  // what keeps a zoomed-in client from being sent the whole network. Padded so
  // vehicles are already tracked before they cross into view, and debounced so
  // a pan costs one subscription change rather than one per frame.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) {
      return;
    }

    let timer: number | undefined;
    const publish = () => {
      const bounds = map.getBounds();
      const padLon = (bounds.getEast() - bounds.getWest()) * VIEWPORT_PADDING_RATIO;
      const padLat = (bounds.getNorth() - bounds.getSouth()) * VIEWPORT_PADDING_RATIO;
      setViewport({
        west: bounds.getWest() - padLon,
        south: bounds.getSouth() - padLat,
        east: bounds.getEast() + padLon,
        north: bounds.getNorth() + padLat,
      });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(publish, VIEWPORT_DEBOUNCE_MS);
    };

    publish();
    map.on('moveend', schedule);
    map.on('zoomend', schedule);

    return () => {
      window.clearTimeout(timer);
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
    };
  }, [mapReady, setViewport]);

  // Routes toggle drives both line layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) {
      return;
    }
    const visibility = showRoutes ? 'visible' : 'none';
    for (const layerId of ['routes-base', 'routes-highlight']) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visibility);
      }
    }
  }, [mapReady, showRoutes]);

  // Clicking a vehicle both selects and follows it; a pan/zoom gesture drops
  // the follow while keeping the selection.
  const handleSelect = useCallback((row: VehicleRow) => {
    selectedIdRef.current = row.id;
    setSelectedId(row.id);
    setFollowing(true);
  }, []);

  // Single owner of the route highlight: a selected vehicle wins, otherwise the
  // sidebar's line selection. Re-runs when route geometry lands so a breadcrumb
  // trail is upgraded to the real polyline.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !map.getLayer('routes-highlight')) {
      return;
    }
    const trail = map.getSource('highlight-route') as GeoJSONSource | undefined;
    const vehicle = selectedId ? api.getDisplayed(selectedId) : null;
    const lineFilterExpression = selectedLines.length
      ? (['in', ['get', 'line'], ['literal', selectedLines]] as ExpressionSpecification)
      : null;

    // All ~640 bus routes at once is a solid mesh of red, so the base polylines
    // narrow to the sidebar's selection whenever there is one.
    if (map.getLayer('routes-base')) {
      map.setFilter('routes-base', lineFilterExpression);
    }

    if (vehicle) {
      const lineId = routeLineId(vehicle);
      if (routeLinesRef.current?.has(lineId)) {
        map.setFilter('routes-highlight', ['==', ['get', 'line'], lineId]);
        trail?.setData(EMPTY_COLLECTION);
      } else {
        // No geometry for this line (yet) — fall back to the breadcrumb trail.
        map.setFilter('routes-highlight', NO_HIGHLIGHT_FILTER);
        const history = api.getHistory(vehicle.id);
        trail?.setData({
          type: 'FeatureCollection',
          features:
            history.length > 1
              ? [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: history },
                  },
                ]
              : [],
        });
      }
      return;
    }

    trail?.setData(EMPTY_COLLECTION);
    map.setFilter('routes-highlight', lineFilterExpression ?? NO_HIGHLIGHT_FILTER);
  }, [mapReady, routesLoaded, selectedId, selectedLines, api]);

  const lineFilter = useMemo(() => new Set(selectedLines), [selectedLines]);

  const visibleRows = useMemo(
    () =>
      rows.filter((vehicle) => {
        const group = filterKeyForType(vehicle.type);
        if (!group || !filters[group]) {
          return false;
        }
        return lineFilter.size === 0 || lineFilter.has(routeLineId(vehicle));
      }),
    [rows, filters, lineFilter],
  );

  // Rebuilt on a timer rather than per frame: this drives the sidebar list and
  // its counts, both of which would otherwise re-render 60 times a second.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [lines, setLines] = useState<LineSummary[]>([]);

  useEffect(() => {
    const rebuild = () => {
      const byLine = new Map<string, LineSummary>();
      for (const row of rowsRef.current) {
        const group = filterKeyForType(row.type);
        if (!group) {
          continue;
        }
        const id = routeLineId(row);
        const existing = byLine.get(id);
        if (existing) {
          existing.count += 1;
        } else {
          byLine.set(id, {
            id,
            label: row.line || id,
            group,
            color: modeColorHex(row.routeGroup),
            count: 1,
          });
        }
      }
      setLines([...byLine.values()].sort(compareLines));
    };

    rebuild();
    const timer = window.setInterval(rebuild, LINE_INDEX_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const modeCounts = useMemo(() => {
    const result: Record<FilterKey, number> = {
      bus: 0,
      tube: 0,
      overground: 0,
      dlr: 0,
      tram: 0,
      elizabeth: 0,
    };
    for (const line of lines) {
      result[line.group] += line.count;
    }
    return result;
  }, [lines]);

  const selectedVehicle = useMemo(
    () => (selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null),
    [rows, selectedId],
  );

  // Destination and next stop ride with the selection, not the fleet. Refreshed
  // on a timer because the next stop changes as the vehicle travels.
  const [selectedDetail, setSelectedDetail] = useState<VehicleDetail | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }

    let cancelled = false;
    const load = () => {
      api.fetchDetails([selectedId]).then((details) => {
        if (!cancelled) {
          setSelectedDetail(details[0] ?? null);
        }
      });
    };

    load();
    const timer = window.setInterval(load, DETAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId, api]);

  // A vehicle the filters just hid shouldn't leave its info panel behind.
  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const vehicle = api.getDisplayed(selectedId);
    if (!vehicle) {
      return;
    }
    const group = filterKeyForType(vehicle.type);
    const hidden =
      !group ||
      !filters[group] ||
      (selectedLines.length > 0 && !selectedLines.includes(routeLineId(vehicle)));
    if (hidden) {
      clearSelection();
    }
  }, [selectedId, filters, selectedLines, api, clearSelection]);

  useEffect(() => {
    if (!overlayRef.current || !models) {
      return;
    }
    // zoomRef (not a one-shot getZoom) so models rescale while zooming: this
    // effect already re-runs on every rAF tick via visibleRows.
    overlayRef.current.setProps({
      layers: buildVehicleLayers(models, visibleRows, zoomRef.current, handleSelect, selectedId),
    });
  }, [visibleRows, models, handleSelect, selectedId]);

  // Follow mode: glide the camera onto the vehicle's displayed position.
  useEffect(() => {
    if (!following || !selectedId) {
      return;
    }
    const track = () => {
      const map = mapRef.current;
      const vehicle = api.getDisplayed(selectedId);
      if (map && vehicle) {
        map.easeTo({ center: [vehicle.position[0], vehicle.position[1]], duration: 450 });
      }
    };
    track();
    const interval = window.setInterval(track, 500);
    return () => window.clearInterval(interval);
  }, [following, selectedId, api]);

  const now = Date.now();

  return (
    <div className="app-shell">
      <div className="map" ref={mapContainerRef} />
      <Sidebar
        open={sidebarOpen}
        onToggleOpen={() => setSidebarOpen((value) => !value)}
        search={search}
        onSearchChange={setSearch}
        filters={filters}
        modeCounts={modeCounts}
        onToggleMode={(key) => setFilters((previous) => ({ ...previous, [key]: !previous[key] }))}
        lines={lines}
        selectedLines={selectedLines}
        onToggleLine={(id) =>
          setSelectedLines((previous) =>
            previous.includes(id)
              ? previous.filter((value) => value !== id)
              : [...previous, id],
          )
        }
        onClearLines={() => setSelectedLines([])}
        showRoutes={showRoutes}
        onToggleRoutes={() => setShowRoutes((value) => !value)}
      />
      {selectedVehicle ? (
        <InfoPanel
          vehicle={selectedVehicle}
          detail={selectedDetail}
          now={now}
          following={following}
          onToggleFollow={() => setFollowing((value) => !value)}
          onClose={clearSelection}
        />
      ) : null}
      <StatusBar
        status={connectionStatus}
        vehicleCount={visibleRows.length}
        lastPayloadAt={lastPayloadAt}
        now={now}
        shifted={sidebarOpen}
      />
    </div>
  );
}

export default App;
