import type { RoutePath } from './route-paths';

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
  /**
   * The stops *after* the one in fields 3/4/7, flattened into `[lat, lon, secs]`
   * triples — so the length is always a multiple of three, and `[]` means the
   * backend had nothing further to offer.
   *
   * `secs` uses the same convention as `timeToStation`: seconds relative to the
   * payload's `generated_at`, negative once the prediction has expired. Entries
   * are strictly increasing in time.
   *
   * This is what lets a vehicle keep moving between polls. TfL's predictions
   * reach us around 70 seconds stale and refresh every 15-25s, while the median
   * vehicle is only ~30s from its next stop, so a client told about one stop at
   * a time runs out of road before it is told where to go next.
   */
  schedule: number[],
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
  /**
   * Named stops on this vehicle's schedule, soonest first, with the coordinates
   * needed to identify them.
   *
   * `station_name` alone is the stop TfL currently leads with, and a client
   * working through a queued schedule is routinely a stop or two ahead of that —
   * it would otherwise name a stop the vehicle has visibly passed. Matching on
   * coordinates rather than on an index keeps this correct even when a payload
   * and a detail response describe slightly different moments. Absent when
   * talking to a backend that predates the schedule.
   */
  next_stops?: { name: string; lat: number; lon: number }[];
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

/** A stop a vehicle is booked to reach, on the client clock. */
export type Leg = {
  /** Raw stop coordinate as `[lon, lat]`, never an interpolated position — it
   *  becomes half of `pathBetween`'s memo key when this leg is taken up. */
  stop: [number, number];
  arrivesAt: number;
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
  /** Straight-line fallback origin: the displayed pose when this glide began.
   *  Only read when `path` is null. */
  from: [number, number];
  /** This glide's destination — the next stop, exactly as reported. */
  to: [number, number];
  fromHeading: number;
  toHeading: number;
  /**
   * The glide is expressed as two absolute client-clock instants rather than a
   * start plus a duration, because a refreshed prediction moves the *deadline*
   * while the vehicle keeps its progress. Re-anchoring `startedAt` to preserve
   * that progress is what stops it stalling every time a payload lands.
   */
  startedAt: number;
  arrivesAt: number;
  /** Last payload that mentioned this vehicle, for the "updated Ns ago" line. */
  updatedAt: number;
  /**
   * Stops queued behind `to`, soonest first. When the current deadline passes
   * the vehicle takes the head of this queue and carries on, so it keeps moving
   * through the gap between polls instead of parking on a stop and waiting to be
   * told what it is already doing.
   */
  legs: Leg[];

  // --- route following ---
  /**
   * The stop this glide departed from: the previous payload's `to`. Null on first
   * sighting. Must stay a raw stop coordinate — it is half of `pathBetween`'s
   * memo key, and an interpolated value here would never repeat, so the cache
   * would sit at a 0% hit rate.
   */
  originStop: [number, number] | null;
  /** Shared immutable sub-polyline, or null to fall back to the chord lerp. */
  path: RoutePath | null;
  /** Arc length along `path.line` this glide starts at. Equals `path.s0` for a
   *  fresh stop pair, mid-path when a glide was picked up in progress. */
  startS: number;
  /** Arc length this glide ends at — always `path.s1`. */
  endS: number;
  /** Scratch: last segment index used. A hint, not state; a stale value costs
   *  one binary search and never a wrong answer. */
  segHint: number;
  /** `out` resumes at speed mid-path; `inout` departs a stop from rest. */
  easing: 'inout' | 'out';

  // --- current frame's interpolated pose ---
  //
  // These live on the vehicle and are rewritten in place by `updateRow` rather
  // than carried on a per-frame copy of it. The copy was `{...vehicle}` plus a
  // fresh `position` array for every vehicle on every tick: at 6,500 vehicles
  // and 60fps that is ~800,000 objects a second allocated to carry three
  // numbers, and the GC pressure showed up as periodic frame drops on exactly
  // the mid-range phones the app most needs to hold 30fps on.
  //
  // Safe because a row is only ever read synchronously — by the layer builder
  // for the frame that just wrote it, and by deck.gl's accessors during that
  // same `setProps`. Anything that needs to *keep* a pose (the info panel, the
  // follow loop's target) goes through `VehiclesApi.getDisplayed`, which
  // detaches a copy.

  /** `[lon, lat, 0]`. The array identity is stable for the vehicle's lifetime;
   *  only its contents change. */
  position: [number, number, number];
  /** Displayed heading in degrees, eased between `fromHeading`/`toHeading` or
   *  read off the route geometry. */
  heading: number;
  /** How long the arrival deadline has been in the past, 0 while en route. Only
   *  reachable once `legs` is empty — with a stop still queued the vehicle takes
   *  it rather than sitting overdue — so this now means "we have run off the end
   *  of what TfL told us", not merely "between polls". */
  overdueMs: number;
};

/**
 * A vehicle with its pose for the current frame. Now the same object: the pose
 * fields moved onto `RenderVehicle` so a frame costs one array allocation
 * instead of one object per vehicle. Kept as a distinct name because it is what
 * every renderer and layer accessor is typed against, and because it still
 * documents the contract — a row is only valid for the frame it was written in.
 */
export type VehicleRow = RenderVehicle;

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

/** One entry per generated model. `train` is deep-tube stock and the default
 *  for any rail type without a shape of its own. */
export type VehicleModels = {
  bus: unknown;
  train: unknown;
  tram: unknown;
  dlr: unknown;
  elizabeth: unknown;
};
