/**
 * `type` and `routeGroup` are indices into the payload's `dict`, not strings:
 * they have ~20 distinct values across thousands of vehicles, so the backend
 * sends a table once per message rather than repeating them per vehicle.
 */
export type VehicleTuple = [
  id: string,
  typeIndex: number,
  lineName: string,
  lat: number,
  lon: number,
  heading: number,
  routeGroupIndex: number,
  timeToStation: number | null,
];

export type PayloadDictionary = {
  type: string[];
  route_group: string[];
};

/** Fetched per selection rather than broadcast — only the info panel shows these. */
export type VehicleDetail = {
  id: string;
  destination: string;
  station_name: string;
};

export type Payload = {
  schema: string[];
  dict?: PayloadDictionary;
  generated_at: string;
  kind?: 'full' | 'delta';
  /**
   * The grid cell this payload speaks for. A `full` reconciles only within its
   * own tile; null means the message covers the whole network.
   */
  tile?: string | null;
  vehicles: VehicleTuple[];
  removed_ids?: string[];
};

export type ServerHello = {
  tileSizeDeg: number;
  maxViewportTiles: number;
  emitIntervalMs: number;
  maxDetailIds: number;
};

export type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type RenderVehicle = {
  id: string;
  type: string;
  line: string;
  routeGroup: string;
  timeToStation: number | null;
  /** Which tile last reported this vehicle, so removals can be scoped to it. */
  tile: string | null;
  from: [number, number];
  to: [number, number];
  fromHeading: number;
  toHeading: number;
  receivedAt: number;
  durationMs: number;
};

/** A RenderVehicle with its interpolated pose for the current frame. */
export type VehicleRow = RenderVehicle & {
  position: [number, number, number];
  heading: number;
};

export type FilterKey = 'bus' | 'tube' | 'overground' | 'dlr' | 'tram' | 'elizabeth';

/** One searchable entry in the sidebar: a tube/rail line or a bus route. */
export type LineSummary = {
  /** Matches the `line` property on route geometry features. */
  id: string;
  label: string;
  group: FilterKey;
  color: string;
  count: number;
};

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export type VehicleModels = { bus: unknown; train: unknown; tram: unknown };
