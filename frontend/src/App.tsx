import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportError } from './error-reporting';
import maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { MapboxOverlay } from '@deck.gl/mapbox';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
import {
  BUS_RED,
  DETAIL_REFRESH_MS,
  FILTER_LABELS,
  FILTER_ORDER,
  FOLLOW_ZOOM,
  INITIAL_ZOOM,
  IS_NARROW,
  MAP_STYLES,
  MODE_COLORS,
  VIEWPORT_DEBOUNCE_MS,
  VIEWPORT_PADDING_RATIO,
  filterKeyForType,
  isLightBasemap,
  lineSwatchHex,
  modeColorHex,
  routeLineId,
  styleForMode,
} from './config';
import type { BasemapMode } from './config';
import { DAYLIGHT_POLL_MS, daylightPhase } from './daylight';
import type { DaylightPhase } from './daylight';
import { LOD_MIN_ZOOM, bucketFleet, buildVehicleLayers, vehicleLighting } from './layers';
import type { ModelLayerBuilder } from './layers';
import { useAppActive, useNativeShell } from './lifecycle';
import { setRouteCollection } from './route-paths';
import { loadStops, startRouteGeometry } from './static-data';
import { useVehicles } from './useVehicles';
import { InfoPanel } from './components/InfoPanel';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import type {
  Bounds,
  FilterKey,
  LineSummary,
  VehicleDetail,
  VehicleModels,
  VehicleRow,
} from './types';

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };
const NO_HIGHLIGHT_FILTER: ExpressionSpecification = ['==', ['get', 'line'], '__none__'];
// Rows re-derive every animation frame; the sidebar list only needs to be
// roughly live, so it is rebuilt on a timer instead.
const LINE_INDEX_INTERVAL_MS = 1500;

// ---------------------------------------------------------------------------
// Follow mode
// ---------------------------------------------------------------------------
//
// A followed vehicle's displayed position is re-derived from Date.now() on every
// read, so it is already continuous — following used to sample it every 500ms
// and ease to each stale sample over 450ms, which meant the camera accelerated
// towards a half-second-old point, arrived, waited, and set off again. All of
// the stutter was in the sampling, so the camera is now driven per frame.

/** Exponential smoothing constants, applied as `1 - e^(-dt/tau)` so the filter
 *  behaves the same at 30fps as at 60. The centre is filtered only enough to
 *  absorb a velocity step — a payload re-anchoring a vehicle, or a change of
 *  target stop — rather than to lag behind: steady-state error is v·tau, which
 *  at 150ms is around a metre for a bus and three for a train, one to four
 *  pixels at FOLLOW_ZOOM. The zoom is the opposite problem, a one-off travel of
 *  up to six levels from INITIAL_ZOOM, and 450ms crosses 95% of that in 1.4s. */
const FOLLOW_CENTER_TAU_MS = 150;
const FOLLOW_ZOOM_TAU_MS = 450;
/** A backgrounded tab resumes with a gap of seconds between rAF timestamps,
 *  which would give alpha ≈ 1 and snap the camera through the interval it slept
 *  for. Clamping the step is cheaper than detecting the resume. */
const FOLLOW_MAX_FRAME_MS = 100;
/** ~7cm of longitude at London's latitude, under a tenth of a pixel at
 *  FOLLOW_ZOOM, so the filter settles rather than crawling at the target
 *  forever. */
const FOLLOW_CENTER_EPSILON = 1e-6;
const FOLLOW_ZOOM_EPSILON = 0.01;
/** `jumpTo` fires `moveend` on every frame, so the viewport effect's 250ms
 *  debounce is reset before it can ever expire and the tile subscription would
 *  freeze at whatever was on screen when follow engaged. A fixed cadence is the
 *  right analogue of that debounce for a move that does not end. */
const FOLLOW_VIEWPORT_MS = 1000;

// ---------------------------------------------------------------------------
// Route line styling
// ---------------------------------------------------------------------------
//
// Every paint property is zoom-interpolated. At constant width, 640 bus routes
// drawn at once are a solid mesh from about zoom 11 down; thinning them to
// hairlines lets the same geometry read as texture — where the network is dense
// — instead of as fill.

const ROUTE_WIDTH: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 0.4, 12, 0.8, 14, 1.3, 16, 2,
];
const ROUTE_OPACITY: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 0.09, 12, 0.16, 15, 0.34,
];
/** Everything recedes while one route is in focus. */
const ROUTE_OPACITY_DIMMED: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 0.03, 12, 0.06, 15, 0.11,
];
const HIGHLIGHT_WIDTH: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 2.5, 13, 4, 16, 6,
];
const CASING_WIDTH: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 9, 5.5, 13, 8.5, 16, 12,
];

/** Below this there are thousands of stops in view and the map is not about
 *  them; above it, they are what the camera is looking at. */
const STOPS_MIN_ZOOM = 15;
const STOPS_REFRESH_MS = 4000;

/** Layers that follow the highlight filter together. */
const HIGHLIGHT_LAYERS = ['routes-casing', 'routes-highlight', 'routes-arrows'];
const ROUTE_LAYERS = ['routes-base', ...HIGHLIGHT_LAYERS, 'highlight-route'];

/**
 * Rail routes take their brand colour. Bus routes — 640 of them, all the same
 * red — take a desaturated one instead: at full strength they drown the rail
 * network and the vehicles both, and there is no per-route information in them
 * anyway, since they all share the colour.
 */
const BUS_ROUTE_LINE = '#b8746e';

function routeColorExpression(highlighted: boolean): ExpressionSpecification {
  const branches: string[] = [];
  for (const line of Object.keys(MODE_COLORS)) {
    branches.push(line, modeColorHex(line));
  }
  // Anything not in MODE_COLORS is a bus route number. A highlighted route is
  // the subject, so there it keeps the real red.
  const fallback = highlighted ? BUS_RED : BUS_ROUTE_LINE;
  return ['match', ['get', 'line'], ...branches, fallback] as unknown as ExpressionSpecification;
}

/** A halo behind the highlighted route so a line colour stays legible over any
 *  basemap — which now includes both a bright one and a dark one. */
function casingColor(phase: DaylightPhase): string {
  return isLightBasemap(phase) ? '#0b0f1a' : '#e8edfa';
}

/** Direction chevrons for the highlighted route. Drawn to a canvas rather than
 *  shipped as an asset: it is a triangle, and an inline one survives the
 *  Capacitor origin without a fetch. */
function routeArrowImage(): ImageData | null {
  const size = 18;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.beginPath();
  ctx.moveTo(4.5, 3);
  ctx.lineTo(14.5, 9);
  ctx.lineTo(4.5, 15);
  ctx.closePath();
  // Stroked first, then filled over the inner half of the stroke, so the arrow
  // carries its own dark outline and reads over any line colour.
  ctx.strokeStyle = 'rgba(11, 15, 26, 0.8)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Everything this app adds to the map style. Extracted from the `load` handler
 * because `setStyle` tears all of it down: swapping the basemap at dusk has to
 * put the sources, layers, images and the deck overlay back.
 */
function installMapLayers(map: maplibregl.Map, phase: DaylightPhase, routes: FeatureCollection) {
  if (!map.hasImage('route-arrow')) {
    const arrow = routeArrowImage();
    if (arrow) {
      map.addImage('route-arrow', arrow);
    }
  }

  map.addSource('routes', { type: 'geojson', data: routes });
  map.addLayer({
    id: 'routes-base',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': routeColorExpression(false),
      'line-width': ROUTE_WIDTH,
      'line-opacity': ROUTE_OPACITY,
    },
  });
  map.addLayer({
    id: 'routes-casing',
    type: 'line',
    source: 'routes',
    filter: NO_HIGHLIGHT_FILTER,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': casingColor(phase),
      'line-width': CASING_WIDTH,
      'line-opacity': 0.75,
      'line-blur': 0.5,
    },
  });
  map.addLayer({
    id: 'routes-highlight',
    type: 'line',
    source: 'routes',
    filter: NO_HIGHLIGHT_FILTER,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': routeColorExpression(true),
      'line-width': HIGHLIGHT_WIDTH,
      'line-opacity': 0.95,
    },
  });
  map.addLayer({
    id: 'routes-arrows',
    type: 'symbol',
    source: 'routes',
    filter: NO_HIGHLIGHT_FILTER,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 110,
      'icon-image': 'route-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.45, 14, 0.75, 17, 1],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-rotation-alignment': 'map',
    },
    paint: { 'icon-opacity': 0.85 },
  });

  // Stops and stations. Below STOPS_MIN_ZOOM there are far too many to draw and
  // the source stays empty, so the layers cost nothing until the camera is close
  // enough for them to mean something.
  map.addSource('stops', { type: 'geojson', data: EMPTY_COLLECTION });
  map.addLayer({
    id: 'stops-dots',
    type: 'circle',
    source: 'stops',
    minzoom: STOPS_MIN_ZOOM,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 2.5, 18, 5],
      'circle-color': isLightBasemap(phase) ? '#0b0f1a' : '#e8edfa',
      'circle-opacity': 0.55,
      'circle-stroke-width': 1,
      'circle-stroke-color': isLightBasemap(phase) ? '#ffffff' : '#0b0f1a',
      'circle-stroke-opacity': 0.7,
    },
  });

  // Fallback breadcrumb trail when no route geometry exists for a line.
  map.addSource('highlight-route', { type: 'geojson', data: EMPTY_COLLECTION });
  map.addLayer({
    id: 'highlight-route',
    type: 'line',
    source: 'highlight-route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ff3366',
      'line-width': HIGHLIGHT_WIDTH,
      'line-opacity': 0.9,
    },
  });
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
  const zoomRef = useRef(INITIAL_ZOOM);
  const selectedIdRef = useRef<string | null>(null);
  const routeLinesRef = useRef<Set<string> | null>(null);
  // Kept so a basemap swap can put the geometry back without refetching it —
  // the full collection is ~2.6MB and takes the backend minutes to build.
  const routeCollectionRef = useRef<FeatureCollection>(EMPTY_COLLECTION);
  const styleUrlRef = useRef<string | null>(null);
  const boundsRef = useRef<Bounds | null>(null);
  // Owned by the viewport effect, borrowed by the follow loop — see
  // FOLLOW_VIEWPORT_MS for why following cannot go through the debounce.
  const publishViewportRef = useRef<(() => void) | null>(null);
  // True between a press on the map and its release. A ref, not state, because
  // the follow loop reads it on the frame after the press: going through React
  // would cost a render, and the frame in between is the one that matters.
  const pointerHeldRef = useRef(false);

  const [mapReady, setMapReady] = useState(false);
  // The basemap is a free, keyless public tile server with no SLA. If it goes
  // away the vehicle layers still render and still move, so this drives a
  // notice rather than an error state.
  const [basemapFailed, setBasemapFailed] = useState(false);
  // Bumped every time the style is replaced, so the effects that own map state
  // — route data, filters, visibility — re-run against the new style.
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [routesLoaded, setRoutesLoaded] = useState(false);
  const [showRoutes, setShowRoutes] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>('auto');
  const [sunPhase, setSunPhase] = useState<DaylightPhase>(() => daylightPhase());
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
  const [models, setModels] = useState<VehicleModels | null>(null);
  // The builder arrives with the lazily-imported model module; until it does,
  // `buildVehicleLayers` stays in its dot band whatever the zoom is.
  const [buildModels, setBuildModels] = useState<ModelLayerBuilder | null>(null);
  // Latches once the camera first reaches model territory: the loader and the
  // geometry are fetched then, and never unloaded after.
  const [needModels, setNeedModels] = useState(INITIAL_ZOOM >= LOD_MIN_ZOOM);

  const phase = styleForMode(basemapMode, sunPhase);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

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

  // Dismiss the native splash as soon as the basemap is up. It used to wait for
  // the vehicle models too, but the app now opens in its dot band — a map with
  // dots on it is a finished first frame, and the models may never load at all
  // in a session that stays zoomed out.
  useNativeShell(mapReady);

  // The models, the glTF loader and `@deck.gl/mesh-layers` are only meaningful
  // above the level-of-detail threshold, and together they are the largest
  // thing the app downloads. All three wait until the camera first gets there,
  // so opening on a city-wide view costs none of them.
  useEffect(() => {
    if (!needModels) {
      return;
    }
    let cancelled = false;

    import('./model-layers')
      .then(async ({ buildModelLayers, loadVehicleModels }) => {
        const loaded = await loadVehicleModels();
        if (!cancelled) {
          // setState treats a bare function as an updater, so the builder has
          // to be wrapped to be stored rather than called.
          setBuildModels(() => buildModelLayers);
          setModels(loaded);
        }
      })
      .catch((error) => {
        console.error('Could not load vehicle models', error);
      });

    return () => {
      cancelled = true;
    };
  }, [needModels]);

  useEffect(() => {
    if (!mapContainerRef.current) {
      return;
    }

    // A fly-in from a flatter, wider framing reads as arriving over the city
    // rather than cutting to it. Reduced-motion users get the destination.
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    styleUrlRef.current = MAP_STYLES[phaseRef.current];
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLES[phaseRef.current],
      center: [-0.1276, 51.5072],
      zoom: reduceMotion ? INITIAL_ZOOM : INITIAL_ZOOM - 2.2,
      pitch: reduceMotion ? 55 : 20,
      // TfL's open data terms require the vehicle feed to be attributed. It goes
      // in MapLibre's attribution control rather than our own chrome so it sits
      // beside the basemap's OpenStreetMap credit — where anyone looking for
      // provenance already knows to look — and so it survives the setStyle that
      // every dusk, dawn and manual Day/Night toggle performs.
      attributionControl: {
        customAttribution:
          'Vehicle data <a href="https://tfl.gov.uk/info-for/open-data-users/" target="_blank" rel="noopener noreferrer">Powered by TfL</a>',
      },
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    // MapLibre reports transport failures here rather than throwing, so without
    // a listener a dead tile server is completely silent — the map simply stays
    // blank and the user has no idea whether it is loading or broken.
    map.on('error', (event) => {
      const message = event.error?.message ?? String(event.error ?? 'unknown map error');
      // Style and sprite failures mean no basemap at all; a handful of missing
      // tiles at the edge of a pan do not, and must not raise the notice.
      if (/style|sprite|glyphs/i.test(message)) {
        setBasemapFailed(true);
      }
      reportError(event.error ?? message, { source: 'maplibre', detail: { message } });
    });

    // Any successful style load clears it: a transient failure should not leave
    // the notice up for the rest of the session.
    map.on('styledata', () => setBasemapFailed(false));

    if (import.meta.env.DEV) {
      (window as unknown as { __map?: maplibregl.Map }).__map = map;
    }

    // Read from refs on every rAF tick rather than calling getZoom/getBounds
    // there: MapLibre recomputes the transform on each call, and the layer
    // rebuild is already the frame's most expensive step.
    const trackCamera = () => {
      const zoom = map.getZoom();
      zoomRef.current = zoom;
      if (zoom >= LOD_MIN_ZOOM) {
        setNeedModels(true);
      }
      const bounds = map.getBounds();
      boundsRef.current = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
    };
    trackCamera();
    map.on('move', trackCamera);

    // Follow mode disengages on user gestures only: the follow loop's jumpTo
    // fires the same camera events but without originalEvent, which cleanly
    // separates the two.
    const disengageFollow = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) {
        setFollowing(false);
      }
    };
    // `dragstart`, `pitchstart` and `rotatestart` are derived: MapLibre's
    // handlers accumulate the input and only then move the camera. That does
    // not survive the follow loop — `jumpTo` calls `Camera.stop()`, which calls
    // `HandlerManager.stop()`, which calls `reset()` on every handler, so a
    // gesture starting while following is wiped before its second event lands
    // and none of these ever fire. Measured: a mouse drag produced `mousedown`
    // and nothing else, and a two-finger pinch produced no `zoomstart` at all.
    //
    // So the gestures that matter are caught on raw input instead — `mousemove`
    // with a button held, and `touchmove`, which MapLibre re-fires straight from
    // the DOM and which no handler reset can swallow. Follow drops on the first
    // one, the loop stops writing the camera on the next frame, and the handlers
    // have the rest of the gesture to themselves.
    //
    // The derived four stay because they are still the only signal for the
    // gestures that bypass the handlers entirely: `wheel` is a DOM event, and
    // double-tap zoom eases the camera straight from the dblclick with the
    // originalEvent attached, which arrives as a user-originated `zoomstart`.
    map.on('dragstart', disengageFollow);
    map.on('wheel', disengageFollow);
    map.on('zoomstart', disengageFollow);
    map.on('pitchstart', disengageFollow);
    map.on('rotatestart', disengageFollow);
    map.on('touchmove', disengageFollow);
    // A press on its own is not a gesture — selecting a vehicle is a press, and
    // it is what turns following on — so the mouse is only followed once it
    // moves with a button down.
    map.on('mousemove', (event) => {
      if (event.originalEvent.buttons !== 0) {
        setFollowing(false);
      }
    });

    // Disengaging is not enough on its own: by the time the first move arrives,
    // the reset has already thrown away the press the pan and pinch handlers
    // were counting from, so the gesture is dead even though the camera is free
    // again. The loop therefore hands the camera back for as long as a pointer
    // is down, which is the only window in which a handler has state to lose.
    // A press that turns out not to be a gesture — selecting a vehicle — just
    // resumes on release, and the filter glides back onto its target.
    const canvas = map.getCanvasContainer();
    const holdCamera = () => {
      pointerHeldRef.current = true;
    };
    const releaseCamera = () => {
      pointerHeldRef.current = false;
    };
    canvas.addEventListener('pointerdown', holdCamera);
    // On window, not the canvas: a drag that ends off the map still ends.
    window.addEventListener('pointerup', releaseCamera);
    window.addEventListener('pointercancel', releaseCamera);

    // Route polylines are installed before the deck overlay is created so
    // vehicles always draw on top of them.
    const install = () => {
      installMapLayers(map, phaseRef.current, routeCollectionRef.current);

      // A fingertip is nowhere near pixel-accurate, and the target is a small
      // moving vehicle, so picking gets a radius rather than the default 0.
      const overlay = new MapboxOverlay({
        interleaved: true,
        layers: [],
        pickingRadius: 8,
        effects: [vehicleLighting],
        getCursor: ({ isDragging, isHovering }) =>
          isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab',
        getTooltip: ({ object }) => {
          const row = object as VehicleRow | undefined;
          if (!row) {
            return null;
          }
          const group = filterKeyForType(row.type);
          return {
            text: group ? `${row.line}\n${FILTER_LABELS[group]}` : row.line,
            className: 'deck-tooltip',
            style: { borderLeftColor: lineSwatchHex(row) },
          };
        },
      });
      map.addControl(overlay);
      overlayRef.current = overlay;
      setStyleEpoch((value) => value + 1);
    };

    // `setStyle` discards every source, layer and image this app added, and the
    // interleaved overlay's custom layers with them, so installation hangs off
    // `style.load` — which covers the first style too, and fires before `load`.
    // The old overlay is torn down explicitly first: leaving it registered
    // would leak a control holding GL resources from the previous style.
    const reinstall = () => {
      const previous = overlayRef.current;
      if (previous) {
        map.removeControl(previous);
        previous.finalize();
        overlayRef.current = null;
      }
      install();
    };
    map.on('style.load', reinstall);

    map.on('load', () => {
      setMapReady(true);
      if (!reduceMotion) {
        map.easeTo({ zoom: INITIAL_ZOOM, pitch: 55, duration: 2600, essential: true });
      }
    });

    mapRef.current = map;

    return () => {
      map.off('move', trackCamera);
      map.off('style.load', reinstall);
      canvas.removeEventListener('pointerdown', holdCamera);
      window.removeEventListener('pointerup', releaseCamera);
      window.removeEventListener('pointercancel', releaseCamera);
      overlayRef.current?.finalize();
      overlayRef.current = null;
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Swap the basemap when the daylight phase or the user's override changes.
  // Deliberately not part of the setup effect: rebuilding the map would drop
  // the camera, the selection and the socket's viewport subscription.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) {
      return;
    }
    const next = MAP_STYLES[phase];
    // MapLibre normalises the style it holds into a spec object, so comparing
    // against the URL it was given means tracking that ourselves.
    if (styleUrlRef.current === next) {
      return;
    }
    styleUrlRef.current = next;
    map.setStyle(next, { diff: false });
  }, [mapReady, phase]);

  const appActive = useAppActive();

  // Re-check the sun on a timer and on resume: a phone backgrounded at dusk
  // comes back at night, and the timer will not have fired while it slept.
  useEffect(() => {
    if (!appActive) {
      return;
    }
    const check = () => setSunPhase(daylightPhase());
    check();
    const timer = window.setInterval(check, DAYLIGHT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [appActive]);

  // Route geometry, from the build where there is a bundled copy and from the
  // backend otherwise — see static-data.ts for the resolution order and the
  // progressive/backoff behaviour it preserves. This callback runs once per
  // improved collection, which is once for a bundled build and repeatedly while
  // a backend is still assembling geometry.
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    return startRouteGeometry((collection) => {
      const lines = new Set<string>();
      for (const feature of collection.features ?? []) {
        const line = feature.properties?.line;
        if (typeof line === 'string') {
          lines.add(line);
        }
      }
      routeLinesRef.current = lines;
      routeCollectionRef.current = collection;
      // The same geometry the map draws also decides the shape of every
      // vehicle's motion, so hand it to the path index here rather than
      // threading it through to useVehicles.
      setRouteCollection(collection);
      (mapRef.current?.getSource('routes') as GeoJSONSource | undefined)?.setData(collection);
      setRoutesLoaded(true);
    });
  }, [mapReady]);

  // Stop markers for the visible box, re-derived whenever the camera settles
  // above the threshold. Still on a slow timer rather than bound to `moveend`:
  // with a bundled index this no longer costs a request, but it does rebuild a
  // GeoJSON source, and a burst of small pans should cost one of those.
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    let cancelled = false;
    let lastKey = '';

    const refresh = async () => {
      const map = mapRef.current;
      const bounds = boundsRef.current;
      if (!map || !bounds) {
        return;
      }
      const source = map.getSource('stops') as GeoJSONSource | undefined;
      if (!source) {
        return;
      }
      if (map.getZoom() < STOPS_MIN_ZOOM) {
        if (lastKey !== '') {
          lastKey = '';
          source.setData(EMPTY_COLLECTION);
        }
        return;
      }
      // Quantised to ~110m: it is what makes a pan of a few pixels a no-op, and
      // on the `GET /stops` fallback it is also what lets the HTTP cache answer
      // a box the session has already asked for.
      const box = {
        west: Number(bounds.west.toFixed(3)),
        south: Number(bounds.south.toFixed(3)),
        east: Number(bounds.east.toFixed(3)),
        north: Number(bounds.north.toFixed(3)),
      };
      const key = `${box.west},${box.south},${box.east},${box.north}`;
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      const stops = await loadStops(box);
      if (cancelled) {
        return;
      }
      if (!stops) {
        // No bundled index and no backend. A missing backend is already visible
        // in the status bar; stops are the least of what is wrong, so this stays
        // quiet and retries on the timer.
        lastKey = '';
        return;
      }
      source.setData({
        type: 'FeatureCollection',
        features: stops.map((stop) => ({
          type: 'Feature',
          properties: { name: stop.name },
          geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
        })),
      });
    };

    refresh();
    const timer = window.setInterval(refresh, STOPS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mapReady, styleEpoch]);

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
    publishViewportRef.current = publish;
    map.on('moveend', schedule);
    map.on('zoomend', schedule);

    return () => {
      window.clearTimeout(timer);
      publishViewportRef.current = null;
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
    };
  }, [mapReady, setViewport]);

  // Routes toggle drives every line layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) {
      return;
    }
    const visibility = showRoutes ? 'visible' : 'none';
    for (const layerId of ROUTE_LAYERS) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visibility);
      }
    }
  }, [mapReady, showRoutes, styleEpoch]);

  // Clicking a vehicle both selects and follows it; a pan/zoom gesture drops
  // the follow while keeping the selection.
  const handleSelect = useCallback((row: VehicleRow) => {
    selectedIdRef.current = row.id;
    setSelectedId(row.id);
    setFollowing(true);
  }, []);

  // deck fires onHover on every pointer move over the canvas; only a change of
  // target is worth a re-render, which would otherwise rebuild every layer.
  const handleHover = useCallback((row: VehicleRow | null) => {
    const next = row?.id ?? null;
    setHoveredId((current) => (current === next ? current : next));
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

    const setHighlight = (filter: ExpressionSpecification) => {
      for (const layerId of HIGHLIGHT_LAYERS) {
        if (map.getLayer(layerId)) {
          map.setFilter(layerId, filter);
        }
      }
    };

    // All ~640 bus routes at once is a solid mesh, so the base polylines narrow
    // to the sidebar's selection whenever there is one, and recede further
    // while a single vehicle's route is in focus.
    if (map.getLayer('routes-base')) {
      map.setFilter('routes-base', lineFilterExpression);
      map.setPaintProperty(
        'routes-base',
        'line-opacity',
        vehicle ? ROUTE_OPACITY_DIMMED : ROUTE_OPACITY,
      );
    }
    if (map.getLayer('routes-casing')) {
      map.setPaintProperty('routes-casing', 'line-color', casingColor(phase));
    }

    if (vehicle) {
      const lineId = routeLineId(vehicle);
      if (routeLinesRef.current?.has(lineId)) {
        setHighlight(['==', ['get', 'line'], lineId]);
        trail?.setData(EMPTY_COLLECTION);
      } else {
        // No geometry for this line (yet) — fall back to the breadcrumb trail.
        setHighlight(NO_HIGHLIGHT_FILTER);
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
    setHighlight(lineFilterExpression ?? NO_HIGHLIGHT_FILTER);
  }, [mapReady, routesLoaded, selectedId, selectedLines, phase, styleEpoch, api]);

  const lineFilter = useMemo(() => new Set(selectedLines), [selectedLines]);

  // Filter and bucket in a single pass. This runs every animation frame, since
  // interpolation rebuilds the rows regardless, so it replaces what used to be
  // four full scans of the fleet with one.
  const fleet = useMemo(
    () =>
      bucketFleet(rows, (vehicle) => {
        const group = filterKeyForType(vehicle.type);
        if (!group || !filters[group]) {
          return false;
        }
        return lineFilter.size === 0 || lineFilter.has(routeLineId(vehicle));
      }),
    [rows, filters, lineFilter],
  );
  const visibleRows = fleet.all;

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
            color: lineSwatchHex(row),
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

  // Everything the panels display is measured in whole seconds — a countdown, an
  // "updated Ns ago" — so they are clocked at 1Hz rather than at the animation
  // frame rate. Two things fall out of that. The panels stop re-rendering sixty
  // times a second to draw the same string, and with their props now stable
  // between seconds the memoised components below can actually bail out, which
  // is what keeps the sidebar's several-hundred-row list out of every frame.
  const [nowSecond, setNowSecond] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowSecond(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // A Map lookup on the same 1Hz clock, not `rows.find` on every frame: the scan
  // was 6,500 string comparisons a frame to locate one vehicle, and it handed
  // back a live row whose pose the next frame would rewrite underneath the panel
  // holding it. `getDisplayed` detaches a copy.
  const selectedVehicle = useMemo(() => {
    void nowSecond; // clock-driven: re-read the pose once a second.
    return selectedId ? api.getDisplayed(selectedId) : null;
  }, [selectedId, nowSecond, api]);

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

  // While a vehicle is selected, its route is the subject and everything else
  // steps back — the only way one bus route is legible in central London.
  const focusLine = useMemo(() => {
    const vehicle = selectedId ? api.getDisplayed(selectedId) : null;
    return vehicle ? routeLineId(vehicle) : null;
  }, [selectedId, api]);

  const isolatedRoute =
    focusLine !== null && selectedLines.length === 1 && selectedLines[0] === focusLine;

  const toggleIsolateRoute = useCallback(() => {
    if (!focusLine) {
      return;
    }
    setSelectedLines((previous) =>
      previous.length === 1 && previous[0] === focusLine ? [] : [focusLine],
    );
  }, [focusLine]);

  // Stable identities for everything handed to the memoised panels. An inline
  // arrow here is a new function on every one of the app's ~60 renders a second,
  // which would make every `memo` comparison fail and put the sidebar's whole
  // line list back into the frame.
  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const toggleMode = useCallback((key: FilterKey) => {
    setFilters((previous) => ({ ...previous, [key]: !previous[key] }));
  }, []);
  const toggleLine = useCallback((id: string) => {
    setSelectedLines((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
    );
  }, []);
  const clearLines = useCallback(() => setSelectedLines([]), []);
  const toggleRoutes = useCallback(() => setShowRoutes((value) => !value), []);
  const toggleFollow = useCallback(() => setFollowing((value) => !value), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      if (event.key === 'Escape') {
        if (typing) {
          target?.blur();
        } else {
          clearSelection();
        }
        return;
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        setSidebarOpen(true);
        // The sidebar may have been collapsed, so the input does not exist
        // until React has committed the reopened panel.
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.sidebar-search')?.focus();
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection]);

  useEffect(() => {
    if (!overlayRef.current) {
      return;
    }
    // zoomRef (not a one-shot getZoom) so the level of detail tracks the camera:
    // this effect already re-runs on every rAF tick via `fleet`.
    overlayRef.current.setProps({
      layers: buildVehicleLayers({
        models,
        fleet,
        zoom: zoomRef.current,
        onSelect: handleSelect,
        onHover: handleHover,
        selectedId,
        hoveredId,
        focusLine,
        bounds: boundsRef.current,
        buildModels,
      }),
    });
  }, [
    fleet,
    models,
    buildModels,
    handleSelect,
    handleHover,
    selectedId,
    hoveredId,
    focusLine,
    styleEpoch,
  ]);

  // Follow mode: one rAF loop owns the camera for as long as it runs. Centre
  // and zoom go out together in a single jumpTo per frame — an easeTo mixed in
  // would spend its duration writing the same camera these frames do, and the
  // two would take turns.
  useEffect(() => {
    const map = mapRef.current;
    if (!following || !selectedId || !mapReady || !map) {
      return;
    }

    // Inwards only, and captured once: a user already closer than FOLLOW_ZOOM
    // keeps their framing, and re-reading getZoom per frame would make the
    // target chase the smoothed value it is being smoothed towards.
    const targetZoom = Math.max(map.getZoom(), FOLLOW_ZOOM);
    // The models are a dynamic import plus five .glb fetches, latched by the
    // camera crossing LOD_MIN_ZOOM. Left to that, a selection made from the
    // opening zoom would start the download partway through the glide and pop
    // the models in mid-flight; starting it here overlaps it with the travel.
    if (targetZoom >= LOD_MIN_ZOOM) {
      setNeedModels(true);
    }
    // The intro fly-in is still running for the first 2.6s of a session, and it
    // writes the camera on the same frames this does.
    map.stop();

    // Reduced motion: the glide is the animation, not the following, so the
    // camera starts at the destination framing and only the tracking filter is
    // left running.
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const engaged = api.getDisplayed(selectedId);
    const center = map.getCenter();
    let lon = reduceMotion && engaged ? engaged.position[0] : center.lng;
    let lat = reduceMotion && engaged ? engaged.position[1] : center.lat;
    let zoom = reduceMotion ? targetZoom : map.getZoom();
    let previousMs = 0;
    // The first publish is a whole interval away rather than on frame one: the
    // camera has not moved yet, so the bounds would be the ones the viewport
    // effect just sent.
    let publishedMs = performance.now();
    let frame = 0;

    const step = (nowMs: number) => {
      frame = requestAnimationFrame(step);
      // A pointer on the map owns the camera; see the pointerdown listener in
      // the map setup effect. Dropping the timestamp means the frame after the
      // release takes no step, so the filter restarts rather than making up the
      // whole hold in one go.
      if (pointerHeldRef.current) {
        previousMs = 0;
        return;
      }
      const vehicle = api.getDisplayed(selectedId);
      // A vehicle dropping out of the fleet clears the selection, which tears
      // this effect down a render later. Until then there is nothing to aim at,
      // so the camera holds where it is.
      if (!vehicle) {
        return;
      }

      const dtMs = previousMs === 0 ? 0 : Math.min(nowMs - previousMs, FOLLOW_MAX_FRAME_MS);
      previousMs = nowMs;

      const alpha = 1 - Math.exp(-dtMs / FOLLOW_CENTER_TAU_MS);
      lon += (vehicle.position[0] - lon) * alpha;
      lat += (vehicle.position[1] - lat) * alpha;
      if (Math.abs(vehicle.position[0] - lon) < FOLLOW_CENTER_EPSILON) {
        lon = vehicle.position[0];
      }
      if (Math.abs(vehicle.position[1] - lat) < FOLLOW_CENTER_EPSILON) {
        lat = vehicle.position[1];
      }

      if (zoom !== targetZoom) {
        zoom += (targetZoom - zoom) * (1 - Math.exp(-dtMs / FOLLOW_ZOOM_TAU_MS));
        if (Math.abs(targetZoom - zoom) < FOLLOW_ZOOM_EPSILON) {
          zoom = targetZoom;
        }
      }

      map.jumpTo({ center: [lon, lat], zoom });

      if (nowMs - publishedMs >= FOLLOW_VIEWPORT_MS) {
        publishedMs = nowMs;
        publishViewportRef.current?.();
      }
    };

    frame = requestAnimationFrame(step);
    // Nothing to publish on the way out: the last frame's moveend leaves the
    // viewport effect's debounce armed, and with the frames stopped it finally
    // gets to expire.
    return () => cancelAnimationFrame(frame);
  }, [following, selectedId, mapReady, api]);

  return (
    <div className="app-shell" data-basemap={phase}>
      <div className="map" ref={mapContainerRef} />
      {basemapFailed ? (
        <div className="basemap-notice panel" role="status">
          <strong>Basemap unavailable.</strong> Vehicles are still live.
        </div>
      ) : null}
      <Sidebar
        open={sidebarOpen}
        onToggleOpen={toggleSidebar}
        search={search}
        onSearchChange={setSearch}
        filters={filters}
        modeCounts={modeCounts}
        onToggleMode={toggleMode}
        lines={lines}
        selectedLines={selectedLines}
        onToggleLine={toggleLine}
        onClearLines={clearLines}
        showRoutes={showRoutes}
        onToggleRoutes={toggleRoutes}
        basemapMode={basemapMode}
        onBasemapModeChange={setBasemapMode}
      />
      {selectedVehicle ? (
        <InfoPanel
          vehicle={selectedVehicle}
          detail={selectedDetail}
          now={nowSecond}
          following={following}
          onToggleFollow={toggleFollow}
          routeIsolated={isolatedRoute}
          onToggleIsolateRoute={toggleIsolateRoute}
          onClose={clearSelection}
        />
      ) : null}
      <StatusBar
        status={connectionStatus}
        vehicleCount={visibleRows.length}
        lastPayloadAt={lastPayloadAt}
        now={nowSecond}
        shifted={sidebarOpen}
      />
    </div>
  );
}

export default App;
