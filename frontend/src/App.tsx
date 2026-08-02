import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { GeoJSONSource } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { io, Socket } from 'socket.io-client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

type VehicleTuple = [string, string, string, number, number, number];

type VehicleDetail = {
  id: string;
  destination: string;
  route_group: string;
  line_name: string;
  type: string;
};

type Payload = {
  schema: string[];
  generated_at: string;
  vehicles: VehicleTuple[];
  details: VehicleDetail[];
};

type RenderVehicle = {
  id: string;
  type: string;
  line: string;
  destination: string;
  routeGroup: string;
  from: [number, number, number];
  to: [number, number, number];
  updatedAt: number;
};

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4010';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || BACKEND_URL;
const INTERPOLATION_MS = Number(import.meta.env.VITE_INTERPOLATION_MS || 12000);
const MAP_STYLE = 'https://demotiles.maplibre.org/style.json';

function parsePayload(payload: Payload) {
  const detailById = new Map(payload.details.map((d) => [d.id, d]));
  return payload.vehicles.map((tuple) => {
    const detail = detailById.get(tuple[0]);
    return {
      id: tuple[0],
      type: tuple[1],
      line: tuple[2],
      lat: tuple[3],
      lon: tuple[4],
      heading: tuple[5],
      destination: detail?.destination || 'Unknown',
      routeGroup: detail?.route_group || tuple[1],
    };
  });
}

function App() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const vehicleStateRef = useRef<Map<string, RenderVehicle>>(new Map());
  const selectedRef = useRef<string | null>(null);
  const historyRef = useRef<Map<string, [number, number][]>>(new Map());

  const [tick, setTick] = useState(0);
  const [filters, setFilters] = useState<Record<string, boolean>>({
    bus: true,
    tube: true,
    overground: true,
    dlr: true,
    tram: true,
    elizabeth: true,
  });
  const [selectedVehicle, setSelectedVehicle] = useState<RenderVehicle | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [-0.1276, 51.5072],
      zoom: 10,
      pitch: 55,
      antialias: true,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('highlight-route', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [],
        },
      });
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

      const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
      map.addControl(overlay);
      overlayRef.current = overlay;
    });

    mapRef.current = map;

    return () => {
      overlayRef.current?.finalize();
      map.remove();
    };
  }, []);

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket'] });

    const applyPayload = (payload: Payload) => {
      const now = Date.now();
      for (const vehicle of parsePayload(payload)) {
        const key = vehicle.id;
        const previous = vehicleStateRef.current.get(key);
        const from = previous ? previous.to : [vehicle.lon, vehicle.lat, previous?.to[2] ?? vehicle.heading] as [number, number, number];
        const next: RenderVehicle = {
          id: key,
          type: vehicle.type,
          line: vehicle.line,
          destination: vehicle.destination,
          routeGroup: vehicle.routeGroup,
          from,
          to: [vehicle.lon, vehicle.lat, vehicle.heading],
          updatedAt: now,
        };
        vehicleStateRef.current.set(key, next);

        const history = historyRef.current.get(key) || [];
        history.push([vehicle.lon, vehicle.lat]);
        historyRef.current.set(key, history.slice(-25));
      }

      if (selectedRef.current) {
        const current = vehicleStateRef.current.get(selectedRef.current);
        setSelectedVehicle(current || null);
      }
    };

    socket.on('vehicles:full', applyPayload);
    socket.on('vehicles:delta', applyPayload);
    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const animate = () => {
      setTick((value) => value + 1);
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const categories = useMemo(
    () => ({
      bus: ['bus'],
      tube: ['bakerloo', 'central', 'circle', 'district', 'hammersmith-city', 'jubilee', 'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city'],
      overground: ['overground', 'london-overground'],
      dlr: ['dlr'],
      tram: ['tram'],
      elizabeth: ['elizabeth'],
    }),
    [],
  );

  const vehicleRows = useMemo(() => {
    const now = Date.now();
    return [...vehicleStateRef.current.values()].filter((vehicle) => {
      return Object.entries(filters).some(([group, enabled]) => enabled && categories[group].includes(vehicle.type));
    }).map((vehicle) => {
      const t = Math.min((now - vehicle.updatedAt) / INTERPOLATION_MS, 1);
      const lon = vehicle.from[0] + (vehicle.to[0] - vehicle.from[0]) * t;
      const lat = vehicle.from[1] + (vehicle.to[1] - vehicle.from[1]) * t;
      const heading = vehicle.from[2] + (vehicle.to[2] - vehicle.from[2]) * t;
      return {
        ...vehicle,
        position: [lon, lat, 0],
        heading,
      };
    });
  }, [categories, filters, tick]);

  useEffect(() => {
    if (!overlayRef.current) {
      return;
    }

    const sceneLayer = new ScenegraphLayer({
      id: 'vehicles-scenegraph',
      data: vehicleRows,
      scenegraph: (d: (typeof vehicleRows)[number]) => (d.type === 'bus' ? '/models/bus.gltf' : '/models/train.gltf'),
      sizeScale: 180,
      getPosition: (d: (typeof vehicleRows)[number]) => d.position,
      getOrientation: (d: (typeof vehicleRows)[number]) => [0, -d.heading, 90],
      pickable: true,
      onClick: ({ object }: { object?: (typeof vehicleRows)[number] }) => {
        if (!object) return;
        selectedRef.current = object.id;
        const selected = vehicleStateRef.current.get(object.id) || null;
        setSelectedVehicle(selected);

        const history = historyRef.current.get(object.id) || [];
        const source = mapRef.current?.getSource('highlight-route') as GeoJSONSource | undefined;
        source?.setData({
          type: 'FeatureCollection',
          features: history.length > 1 ? [{
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: history,
            },
          }] : [],
        });
      },
    });

    overlayRef.current.setProps({ layers: [sceneLayer] });
  }, [vehicleRows]);

  return (
    <div className="app-shell">
      <div className="map" ref={mapContainerRef} />
      <div className="controls">
        {Object.keys(filters).map((filter) => (
          <button
            key={filter}
            className={filters[filter] ? 'active' : ''}
            onClick={() => setFilters((previous) => ({ ...previous, [filter]: !previous[filter] }))}
          >
            {filter}
          </button>
        ))}
      </div>
      <div className="status">
        <p>Vehicles: {vehicleRows.length}</p>
        <p>Backend: {BACKEND_URL}</p>
        {selectedVehicle ? <p>{selectedVehicle.line} to {selectedVehicle.destination}</p> : <p>Select a vehicle to highlight route</p>}
      </div>
    </div>
  );
}

export default App;
