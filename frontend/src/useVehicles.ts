import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  DETAIL_REQUEST_TIMEOUT_MS,
  INTERPOLATION_MS,
  routeLineId,
  SOCKET_URL,
  TARGET_FPS,
} from './config';
import {
  approxDistanceMeters,
  bearingBetween,
  easeInOutSine,
  easeOutSine,
  lerpAngle,
} from './geo';
import { useAppActive } from './lifecycle';
import { clampToPath, pathBetween, poseAlong, projectOntoPath, type Pose } from './route-paths';
import type {
  Bounds,
  ConnectionStatus,
  Leg,
  Payload,
  RenderVehicle,
  VehicleDetail,
  VehicleRow,
} from './types';

const MIN_GLIDE_MS = 2000;
// Predictions are now absolute deadlines rather than countdowns that rot in
// transit, so this ceiling has to be generous enough to hold a real one: a
// vehicle sitting at a terminus can legitimately be twelve minutes out. It stays
// only to stop a corrupt timestamp parking a vehicle for hours.
const MAX_GLIDE_MS = 600000;
// A deadline that has already passed still finishes as a movement rather than a
// snap. Short enough to read as "arriving now".
const MIN_REMAINING_MS = 400;
// Below this distance a hop is treated as jitter and keeps the old heading.
const HEADING_MIN_DISTANCE_M = 15;
// The backend rounds coordinates to 5dp, so two payloads naming the same stop
// are bit-identical here; the epsilon only matters if that precision changes.
// ~1.1m is far below the spacing of any two distinct stops.
const SAME_TARGET_EPSILON_DEG = 1e-5;
// Re-anchoring divides by (1 - t), so a glide this close to done is restarted
// instead. The vehicle is on its stop either way.
const REANCHOR_MAX_T = 0.98;
// How far off a new path a vehicle may be and still resume from where it is
// rather than from the path's start.
const RESUME_SNAP_M = 60;
// Slack for deciding a glide resumed mid-path rather than departing a stop.
const RESUME_EPSILON_M = 5;
// Transit correction is a lag estimate, not a licence to shift a deadline far.
const MAX_TRANSIT_MS = 5000;

// --- adaptive frame pacing -------------------------------------------------
//
// See the rAF effect below. The tick rate is closed-loop on the frame intervals
// the browser actually delivers, rather than fixed at TARGET_FPS and hoped for.

/** Frames per decision window. At 60fps this is a judgement a second. */
const FRAME_WINDOW = 60;
/** A frame taking this much longer than the display's period is one it missed. */
const SLOW_FRAME_RATIO = 1.75;
/** Share of a window that must be slow before the tick rate steps down... */
const DEGRADE_ABOVE = 0.3;
/** ...and the share it must stay under to earn a step back up. */
const RECOVER_BELOW = 0.05;
/** Consecutive clean windows required to step up. Asymmetric on purpose. */
const RECOVER_WINDOWS = 3;
/** Each step is this multiple of the current period, so the loop converges in a
 *  few windows rather than crawling. */
const PACE_STEP = 1.5;
/** Below this the map reads as a slideshow; better to drop detail than frames,
 *  which is what the zoom bands in layers.ts already do. */
const MIN_TICK_FPS = 15;
/** rAF is vsync-locked, so anything under this is a measurement artefact and
 *  must not be allowed to set the learned display period. 240Hz is 4.2ms. */
const MIN_PLAUSIBLE_FRAME_MS = 3;
/** Above this the page was not running: a background tab, a slept device. */
const MAX_PLAUSIBLE_FRAME_MS = 250;

/**
 * Plausible top speeds, in metres per second, by vehicle type.
 *
 * TfL's predictions reach us around a minute after they were computed, so we
 * often learn that a vehicle is heading somewhere new only once it is nearly
 * there. Honouring that deadline literally means covering the whole gap between
 * two stops in the seconds that remain — measured on the live feed, that put the
 * median moving bus at ~50 m/s, or 180 km/h, in the moments after a poll landed.
 *
 * A glide is therefore never allowed to imply a speed above these. The vehicle
 * arrives a little late instead, which is a far smaller lie than a bus crossing
 * Camden at motorway speed, and it is the same lateness the data already had.
 */
const MAX_SPEED_MPS: Record<string, number> = {
  bus: 22,
  tram: 22,
  dlr: 30,
};
const DEFAULT_MAX_SPEED_MPS = 40;

const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value;

/** Two stop coordinates naming the same stop. See SAME_TARGET_EPSILON_DEG. */
const sameStop = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) <= SAME_TARGET_EPSILON_DEG &&
  Math.abs(a[1] - b[1]) <= SAME_TARGET_EPSILON_DEG;

const maxSpeedFor = (type: string) => MAX_SPEED_MPS[type] ?? DEFAULT_MAX_SPEED_MPS;

/**
 * How long this vehicle may take to cover `metres`, given it must not appear to
 * break the speed limit for its type and must not finish so fast that the glide
 * reads as a jump.
 */
function glideSpanMs(type: string, metres: number, wantedMs: number): number {
  const minMs = (metres / maxSpeedFor(type)) * 1000;
  return clamp(Math.max(wantedMs, minMs), MIN_GLIDE_MS, MAX_GLIDE_MS);
}

/** The glide's progress, 0..1. Absolute instants rather than a duration, so a
 *  refreshed prediction can move the deadline without disturbing progress. */
function glideT(vehicle: RenderVehicle, now: number): number {
  const span = vehicle.arrivesAt - vehicle.startedAt;
  // A deadline revised into the past collapses the span; without this guard the
  // division would put NaN straight into a deck.gl position buffer.
  if (span <= 0) {
    return 1;
  }
  return clamp((now - vehicle.startedAt) / span, 0, 1);
}

type Displayed = Pose & {
  /** Arc length along the path, or null when this is a straight-line fallback. */
  s: number | null;
  segHint: number;
};

// One scratch object for the whole fleet. `rows` re-derives every vehicle's pose
// every frame, so anything allocated here is allocated thousands of times a
// second. Both callers read it immediately and never retain it.
const DISPLAY: Displayed = { lon: 0, lat: 0, heading: 0, s: null, segHint: 0 };

// Shared because most of the fleet has one on any given payload, and it is only
// ever replaced wholesale, never mutated in place.
const NO_LEGS: Leg[] = [];

/**
 * Unpack the `[lat, lon, secs]` triples of a schedule into absolute client-clock
 * deadlines, applying the same transit correction the primary prediction gets.
 *
 * Defensive about the shape because an older backend simply omits the field, and
 * a truncated one must not put a NaN deadline into the queue.
 */
function decodeSchedule(schedule: number[] | undefined, now: number, transitMs: number): Leg[] {
  if (!Array.isArray(schedule) || schedule.length < 3) {
    return NO_LEGS;
  }
  const legs: Leg[] = [];
  for (let i = 0; i + 2 < schedule.length; i += 3) {
    const lat = schedule[i];
    const lon = schedule[i + 1];
    const seconds = schedule[i + 2];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seconds)) {
      break;
    }
    legs.push({ stop: [lon, lat], arrivesAt: now + seconds * 1000 - transitMs });
  }
  return legs;
}

function poseAtT(vehicle: RenderVehicle, t: number): Displayed {
  const eased = vehicle.easing === 'out' ? easeOutSine(t) : easeInOutSine(t);

  if (vehicle.path) {
    // The easing is applied to arc length, so the vehicle slows into its stop
    // along the road rather than across it.
    const s = vehicle.startS + (vehicle.endS - vehicle.startS) * eased;
    DISPLAY.segHint = poseAlong(vehicle.path, s, vehicle.segHint, DISPLAY);
    DISPLAY.s = s;
    return DISPLAY;
  }

  DISPLAY.lon = vehicle.from[0] + (vehicle.to[0] - vehicle.from[0]) * eased;
  DISPLAY.lat = vehicle.from[1] + (vehicle.to[1] - vehicle.from[1]) * eased;
  DISPLAY.heading = lerpAngle(vehicle.fromHeading, vehicle.toHeading, eased);
  DISPLAY.s = null;
  DISPLAY.segHint = vehicle.segHint;
  return DISPLAY;
}

/**
 * Take the next stop off the queue once the current deadline passes.
 *
 * This is what removes the wait at the end of every hop. TfL serves predictions
 * about 70 seconds stale and refreshes them every 15-25s, while the median
 * vehicle is only ~30s from its next stop — so a client that knows one stop at a
 * time reliably finishes its glide before the payload naming the next one
 * arrives, and can do nothing but sit there until it does. Given the stops
 * behind it, the vehicle simply carries on.
 *
 * The new glide starts at the instant the old one ended, not at `now`, so
 * position and speed carry across the seam exactly however late the frame is.
 *
 * Mutates in place: `vehiclesRef` is a plain store rather than React state, and
 * this has to happen wherever a pose is read rather than on payloads, which is
 * the whole point.
 */
function advanceLegs(vehicle: RenderVehicle, now: number): void {
  // Each pass moves `arrivesAt` forward by at least MIN_GLIDE_MS, so a schedule
  // that arrives entirely expired is walked through at a plausible speed rather
  // than teleporting or spinning here.
  while (vehicle.legs.length > 0 && now >= vehicle.arrivesAt) {
    const leg = vehicle.legs[0];
    const departedAt = vehicle.arrivesAt;
    const originStop = vehicle.to;
    const path = pathBetween(routeLineId(vehicle), originStop, leg.stop);
    const travelM = path
      ? Math.abs(path.s1 - path.s0)
      : approxDistanceMeters(originStop, leg.stop);

    vehicle.legs = vehicle.legs.slice(1);
    vehicle.from = originStop;
    vehicle.to = leg.stop;
    vehicle.originStop = originStop;
    vehicle.startedAt = departedAt;
    vehicle.arrivesAt =
      departedAt + glideSpanMs(vehicle.type, travelM, leg.arrivesAt - departedAt);
    // Rotate out of the heading actually being displayed rather than snapping to
    // the new bearing; only read when `path` is null.
    vehicle.fromHeading = vehicle.toHeading;
    vehicle.toHeading =
      travelM > HEADING_MIN_DISTANCE_M
        ? bearingBetween(originStop, leg.stop)
        : vehicle.toHeading;
    // Departing a stop from rest, and always from the near end of the path:
    // both endpoints are raw stop coordinates, so there is nothing to resume.
    vehicle.easing = 'inout';
    vehicle.segHint = path && path.line === vehicle.path?.line ? vehicle.segHint : 0;
    vehicle.path = path;
    vehicle.startS = path ? path.s0 : 0;
    vehicle.endS = path ? path.s1 : 0;
  }
}

function displayedPose(vehicle: RenderVehicle, now: number): Displayed {
  advanceLegs(vehicle, now);
  return poseAtT(vehicle, glideT(vehicle, now));
}

/**
 * Advance one vehicle to the frame at `now`, writing the pose onto the vehicle
 * itself.
 *
 * In place, and deliberately: this used to return `{...vehicle}` with a fresh
 * `position` array, which for a 6,500-vehicle fleet at 60fps is ~800,000 short-
 * lived objects a second whose only job is to carry three numbers that the very
 * next frame overwrites. The row *is* the vehicle now — see the pose fields on
 * `RenderVehicle` — so a frame allocates one array for the list and nothing
 * else.
 *
 * The rule that makes it safe: a row is valid only for the frame that wrote it.
 * Everything on the render path reads it synchronously within that frame, and
 * anything that keeps a pose across frames takes a detached copy from
 * `getDisplayed`.
 */
function updateRow(vehicle: RenderVehicle, now: number): VehicleRow {
  const pose = displayedPose(vehicle, now);
  // Writing the segment hint back is a cache update, not state: `vehiclesRef` is
  // a plain mutable store rather than React state, and a hint left over from a
  // different frame costs one binary search and never a wrong position.
  vehicle.segHint = pose.segHint;
  vehicle.position[0] = pose.lon;
  vehicle.position[1] = pose.lat;
  vehicle.heading = pose.heading;
  vehicle.overdueMs = Math.max(0, now - vehicle.arrivesAt);
  return vehicle;
}

/**
 * The same pose, detached from the store.
 *
 * For the callers that outlive the frame — the info panel's 1Hz snapshot, the
 * highlight effect — where handing back the live object would mean React
 * comparing a value against itself and never re-rendering, and the vehicle's
 * pose changing under a component that had already read it.
 */
function detachedRow(vehicle: RenderVehicle, now: number): VehicleRow {
  updateRow(vehicle, now);
  return { ...vehicle, position: [...vehicle.position] as [number, number, number] };
}

export type VehiclesApi = {
  /** Current interpolated pose of one vehicle, or null if unknown. */
  getDisplayed: (id: string) => VehicleRow | null;
  /** Breadcrumb trail of the last raw positions received for a vehicle. */
  getHistory: (id: string) => [number, number][];
  /**
   * Destination and next stop for specific vehicles. Not broadcast — only the
   * selected vehicle's panel shows them, and carrying them for the whole fleet
   * was the bulk of every message.
   */
  fetchDetails: (ids: string[]) => Promise<VehicleDetail[]>;
};

/**
 * Owns the socket lifecycle, the vehicle state map, and the rAF tick that
 * drives interpolation. Rows come back with `position`/`heading` already
 * eased for the current frame.
 *
 * The server streams per grid tile, so `setViewport` decides what this client
 * is actually sent: without it the whole network arrives, as it used to.
 */
export function useVehicles(onVehicleRemoved?: (id: string) => void) {
  const vehiclesRef = useRef<Map<string, RenderVehicle>>(new Map());
  const historyRef = useRef<Map<string, [number, number][]>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  // Replayed on reconnect: a new socket starts out subscribed to everything.
  const viewportRef = useRef<Bounds | null>(null);
  const removedCallbackRef = useRef(onVehicleRemoved);
  removedCallbackRef.current = onVehicleRemoved;
  // Outlives the socket effect: a resume needs to know the connection was
  // interrupted even though the disconnect happened in a different render.
  const droppedRef = useRef(false);
  // Running minimum of (client clock - server clock), which is the skew between
  // them once the transit time has been filtered out. See applyPayload.
  const clockOffsetRef = useRef(Number.POSITIVE_INFINITY);

  const [tick, setTick] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastPayloadAt, setLastPayloadAt] = useState<number | null>(null);
  const active = useAppActive();

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket'] });
    socketRef.current = socket;
    let everConnected = false;

    const removeVehicle = (id: string) => {
      if (vehiclesRef.current.delete(id)) {
        historyRef.current.delete(id);
        removedCallbackRef.current?.(id);
      }
    };

    const applyPayload = (payload: Payload, fallbackKind: 'full' | 'delta') => {
      const now = Date.now();
      const kind = payload.kind ?? fallbackKind;
      const tile = payload.tile ?? null;
      const types = payload.dict?.type ?? [];
      const groups = payload.dict?.route_group ?? [];
      const seen = new Set<string>();

      // `now - generated_at` mixes two clocks: it is the client's skew plus the
      // time in flight. Transit is never negative, so the running minimum of that
      // quantity converges on the skew alone and the remainder is the lag —
      // a one-way-delay minimum filter, no round trip and no server support.
      // Sampled once per payload; a client watching several tiles gets several
      // samples a tick, so it settles within seconds of connecting.
      const serverAt = Date.parse(payload.generated_at ?? '');
      let transitMs = 0;
      if (Number.isFinite(serverAt)) {
        const delta = now - serverAt;
        if (delta < clockOffsetRef.current) {
          clockOffsetRef.current = delta;
        }
        transitMs = clamp(delta - clockOffsetRef.current, 0, MAX_TRANSIT_MS);
      }

      for (const tuple of payload.vehicles ?? []) {
        const [id, typeIndex, line, lat, lon, heading, groupIndex, timeToStation, schedule] =
          tuple;
        const type = types[typeIndex] ?? 'bus';
        seen.add(id);

        const previous = vehiclesRef.current.get(id);
        // Settle any hops the vehicle has taken on its own before matching it
        // against this payload, or the comparison below would be made against a
        // target it has already left.
        if (previous) {
          advanceLegs(previous, now);
        }

        const to: [number, number] = [lon, lat];
        // A null prediction has no deadline to honour, so its duration is a
        // display choice and must not be transit-corrected.
        const remainingMs =
          timeToStation == null ? INTERPOLATION_MS : timeToStation * 1000 - transitMs;
        const legs = decodeSchedule(schedule, now, transitMs);

        // Where the vehicle is already going, located within the run of stops
        // this payload describes. 0 is the ordinary case: it is still heading for
        // the stop TfL leads with, and only the ETA has been revised. Further
        // along means the queue has already carried it past what TfL reports —
        // predictions arrive about 70 seconds stale, so this is routine rather
        // than exceptional, and matching only against the leading stop would drag
        // the vehicle back to one it has visibly left.
        let matchIndex = -1;
        if (previous) {
          if (sameStop(previous.to, to)) {
            matchIndex = 0;
          } else {
            const queued = legs.findIndex((leg) => sameStop(leg.stop, previous.to));
            matchIndex = queued < 0 ? -1 : queued + 1;
          }
        }

        if (previous && matchIndex >= 0) {
          // Rebuilding the glide for a target the vehicle is already travelling
          // to is what used to make every vehicle stall and re-accelerate every
          // few seconds, since easeInOutSine restarts from zero velocity.
          const deadlineMs = matchIndex === 0 ? remainingMs : legs[matchIndex - 1].arrivesAt - now;
          // This branch runs for most of the fleet on every payload, so the
          // ordinary case must not allocate.
          const remainingLegs = matchIndex === 0 ? legs : legs.slice(matchIndex);
          const t = glideT(previous, now);

          if (t < REANCHOR_MAX_T) {
            // Solve for the start instant that leaves progress exactly where it
            // is while honouring the new deadline:
            //   t = (now - s') / (d' - s'), d' = now + R  =>  s' = now - tR/(1-t)
            // Extending the deadline while holding `startedAt` would instead grow
            // the denominator against a fixed numerator and drag the vehicle
            // backwards. When the deadline is unchanged this collapses to
            // s' === startedAt, so the ordinary case is a genuine no-op, and a
            // deadline revised earlier needs no separate branch.
            // A revised-earlier deadline gets the same speed bound as a new
            // glide: how far is left to go, and how fast could that plausibly be
            // covered. Derived from the eased progress rather than by projecting
            // the vehicle again, since this branch runs for most of the fleet on
            // every payload.
            const eased = previous.easing === 'out' ? easeOutSine(t) : easeInOutSine(t);
            const totalM = previous.path
              ? Math.abs(previous.endS - previous.startS)
              : approxDistanceMeters(previous.from, previous.to);
            const minLeftMs = ((totalM * (1 - eased)) / maxSpeedFor(type)) * 1000;
            const remaining = clamp(
              Math.max(deadlineMs, minLeftMs),
              MIN_REMAINING_MS,
              MAX_GLIDE_MS,
            );
            vehiclesRef.current.set(id, {
              ...previous,
              timeToStation,
              tile,
              legs: remainingLegs,
              startedAt: now - (t * remaining) / (1 - t),
              arrivesAt: now + remaining,
              updatedAt: now,
            });
          } else {
            // Too close to done for the re-anchor, whose (1 - t) is on its way to
            // a division by zero. Let the glide land instead: the vehicle is on
            // its stop either way, and with a stop queued behind it advanceLegs
            // takes it from there on the very next frame. Restarting it here is
            // what used to set the origin to the stop already being approached,
            // stranding the vehicle on a zero-length journey with no route to
            // follow.
            vehiclesRef.current.set(id, {
              ...previous,
              timeToStation,
              tile,
              legs: remainingLegs,
              updatedAt: now,
            });
          }
          // Deliberately no heading recompute (the endpoints have not moved, and
          // re-deriving a bearing over a shrinking baseline is what spins models
          // near stops), no path rebuild, and no breadcrumb — the position is
          // unchanged, so pushing one would flush the trail with duplicates.
          continue;
        }

        const routeGroup = groups[groupIndex] ?? type;
        // Re-target from the currently displayed pose so mid-glide updates don't
        // hitch.
        const displayed = previous ? displayedPose(previous, now) : null;
        const from: [number, number] = displayed ? [displayed.lon, displayed.lat] : to;
        // The stop just departed. Raw stop coordinates on both ends are what
        // keep pathBetween's cache warm — an interpolated origin would never
        // repeat and every lookup would be a full geometry scan.
        //
        // Unconditional now: this branch is only reached when the vehicle's
        // target is nowhere in the payload's run of stops, which is a genuine
        // change of target. The nearly-finished-glide case that used to arrive
        // here, and set the origin to the stop already being approached, is
        // handled above instead.
        const originStop = previous?.to ?? null;
        const path = originStop
          ? pathBetween(routeLineId({ line, routeGroup }), originStop, to)
          : null;

        let startS = 0;
        let endS = 0;
        let easing: 'inout' | 'out' = 'inout';

        if (path) {
          endS = path.s1;
          const lo = Math.min(path.s0, path.s1);
          const hi = Math.max(path.s0, path.s1);

          if (previous?.path && previous.path.line === path.line && displayed?.s != null) {
            // Same underlying linestring, so the arc length carries over exactly
            // — no projection needed, and progress is preserved perfectly.
            startS = clampToPath(path, displayed.s);
          } else if (displayed) {
            const snap = projectOntoPath(path, [displayed.lon, displayed.lat]);
            // Only resume from where the vehicle appears to be if that is both
            // near the road and actually inside this stretch of it; a vehicle
            // mid-chord under the straight-line fallback can be well off both.
            startS =
              snap && snap.distanceM <= RESUME_SNAP_M && snap.s >= lo - 50 && snap.s <= hi
                ? clampToPath(path, snap.s)
                : path.s0;
          } else {
            startS = path.s0;
          }

          easing = Math.abs(startS - path.s0) > RESUME_EPSILON_M ? 'out' : 'inout';
        }

        // Never let a glide imply an impossible speed. Only ever lengthens.
        const travelM = path ? Math.abs(endS - startS) : approxDistanceMeters(from, to);

        const toHeading =
          approxDistanceMeters(from, to) > HEADING_MIN_DISTANCE_M
            ? bearingBetween(from, to)
            : displayed
              ? displayed.heading
              : heading;
        const fromHeading = displayed ? displayed.heading : toHeading;

        vehiclesRef.current.set(id, {
          id,
          type,
          line,
          routeGroup,
          timeToStation,
          tile,
          from,
          to,
          fromHeading,
          toHeading,
          startedAt: now,
          arrivesAt: now + glideSpanMs(type, travelM, remainingMs),
          updatedAt: now,
          legs,
          originStop,
          path,
          startS,
          endS,
          segHint: 0,
          easing,
          // Seeded from the glide's own origin so the vehicle is never briefly
          // at [0, 0]; `updateRow` overwrites all three on the next frame,
          // which is before anything can draw it.
          position: [from[0], from[1], 0],
          heading: fromHeading,
          overdueMs: 0,
        });

        const history = historyRef.current.get(id) || [];
        history.push([lon, lat]);
        historyRef.current.set(id, history.slice(-25));
      }

      // A full snapshot reconciles: anything we know about that the backend no
      // longer reports is gone. It only speaks for its own tile, so vehicles
      // elsewhere on screen are left alone.
      if (kind === 'full') {
        for (const [id, vehicle] of [...vehiclesRef.current.entries()]) {
          if (seen.has(id)) {
            continue;
          }
          if (tile === null || vehicle.tile === tile) {
            removeVehicle(id);
          }
        }
      }

      for (const id of payload.removed_ids ?? []) {
        const known = vehiclesRef.current.get(id);
        // Removals are scoped to the tile that issued them. A vehicle already
        // re-reported from a different tile is mid-boundary-crossing, and this
        // is the trailing half of that move rather than a genuine departure.
        if (known && tile !== null && known.tile !== tile) {
          continue;
        }
        removeVehicle(id);
      }

      setLastPayloadAt(now);
    };

    socket.on('vehicles:full', (payload: Payload) => applyPayload(payload, 'full'));
    socket.on('vehicles:delta', (payload: Payload) => applyPayload(payload, 'delta'));

    socket.on('connect', () => {
      everConnected = true;
      // A reconnect after an iOS suspend can land either side of an NTP
      // correction, so the old skew estimate must not survive it.
      clockOffsetRef.current = Number.POSITIVE_INFINITY;
      if (viewportRef.current) {
        socket.emit('viewport:set', viewportRef.current);
      }
      if (droppedRef.current) {
        // We may have missed deltas while away — ask for a full resync.
        socket.emit('vehicles:request-full');
        droppedRef.current = false;
      }
      setConnectionStatus('connected');
    });
    socket.on('disconnect', () => {
      droppedRef.current = true;
      setConnectionStatus('disconnected');
    });
    socket.on('connect_error', () => {
      setConnectionStatus(everConnected ? 'reconnecting' : 'disconnected');
    });
    socket.io.on('reconnect_attempt', () => {
      setConnectionStatus('reconnecting');
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  /**
   * Backgrounding closes the socket deliberately. iOS suspends the WebView and
   * kills the connection without telling the page, which would otherwise leave
   * a resumed app showing `connected` while receiving nothing. Closing it here
   * routes the resume through the normal reconnect path, resync included.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (active) {
      if (!socket.connected) {
        socket.connect();
      }
    } else {
      socket.disconnect();
    }
  }, [active]);

  useEffect(() => {
    // No point interpolating poses nobody can see, and on a phone this is the
    // difference between idling and draining the battery in the background.
    if (!active) {
      return;
    }

    // TARGET_FPS is a ceiling, chosen from the pointer type — which says what
    // kind of device this is and nothing about what it can sustain. A 2019
    // Android and a current flagship are both `pointer: coarse`, and re-deriving
    // 6,500 poses and re-uploading deck.gl's attributes is by a distance the
    // frame's dominant cost. When a device cannot hold the ceiling, asking for
    // fewer frames is strictly better than queueing work the compositor then
    // drops: interpolation is time-based, so a lower rate costs smoothness and
    // nothing else, while a saturated main thread costs input latency too.
    const fastestPeriodMs = 1000 / TARGET_FPS;
    const slowestPeriodMs = 1000 / MIN_TICK_FPS;
    let tickPeriodMs = fastestPeriodMs;

    // The display's own frame period, learned rather than assumed, so a 120Hz
    // phone and a 60Hz laptop are read on the same scale. rAF is vsync-locked,
    // so the shortest interval a session ever sees is that period.
    let displayPeriodMs = Infinity;
    let framesInWindow = 0;
    let slowFramesInWindow = 0;
    // Degrade on one bad window, recover only after several good ones: the two
    // are deliberately asymmetric, or the loop would step up the instant its own
    // throttling had relieved the pressure and spend every other second dropping
    // frames again.
    let goodWindows = 0;

    let frame = 0;
    let lastFrameAt = 0;
    let lastTickAt = 0;

    const animate = (now: number) => {
      frame = window.requestAnimationFrame(animate);

      const interval = lastFrameAt === 0 ? 0 : now - lastFrameAt;
      lastFrameAt = now;

      // A backgrounded tab or a slept device resumes with a gap of seconds.
      // That is an absence of frames, not a dropped one, and letting it into the
      // window would clamp a healthy device to the floor on every resume.
      if (interval > MIN_PLAUSIBLE_FRAME_MS && interval < MAX_PLAUSIBLE_FRAME_MS) {
        if (interval < displayPeriodMs) {
          displayPeriodMs = interval;
        }
        framesInWindow += 1;
        if (interval > displayPeriodMs * SLOW_FRAME_RATIO) {
          slowFramesInWindow += 1;
        }

        if (framesInWindow >= FRAME_WINDOW) {
          const slowShare = slowFramesInWindow / framesInWindow;
          if (slowShare > DEGRADE_ABOVE) {
            tickPeriodMs = Math.min(tickPeriodMs * PACE_STEP, slowestPeriodMs);
            goodWindows = 0;
          } else if (slowShare < RECOVER_BELOW) {
            goodWindows += 1;
            if (goodWindows >= RECOVER_WINDOWS) {
              tickPeriodMs = Math.max(tickPeriodMs / PACE_STEP, fastestPeriodMs);
              goodWindows = 0;
            }
          } else {
            goodWindows = 0;
          }
          framesInWindow = 0;
          slowFramesInWindow = 0;
        }
      }

      if (now - lastTickAt < tickPeriodMs) {
        return;
      }
      lastTickAt = now;
      setTick((value) => value + 1);
    };

    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  const setViewport = useCallback((bounds: Bounds) => {
    viewportRef.current = bounds;
    socketRef.current?.emit('viewport:set', bounds);
  }, []);

  const rows = useMemo<VehicleRow[]>(() => {
    void tick; // rAF-driven: recompute the interpolated pose each frame.
    const now = Date.now();
    // A fresh array, but the same vehicle objects: deck.gl decides an attribute
    // needs re-uploading by comparing the `data` reference, so reusing one array
    // across frames would freeze the fleet on screen. The array is one
    // allocation; the 6,500 objects in it are not re-allocated.
    const list: VehicleRow[] = [];
    for (const vehicle of vehiclesRef.current.values()) {
      list.push(updateRow(vehicle, now));
    }
    return list;
  }, [tick]);

  const api = useMemo<VehiclesApi>(
    () => ({
      getDisplayed(id: string) {
        const vehicle = vehiclesRef.current.get(id);
        return vehicle ? detachedRow(vehicle, Date.now()) : null;
      },
      getHistory(id: string) {
        return historyRef.current.get(id) ?? [];
      },
      fetchDetails(ids: string[]) {
        const socket = socketRef.current;
        if (!socket || ids.length === 0) {
          return Promise.resolve([]);
        }
        return new Promise<VehicleDetail[]>((resolve) => {
          socket
            .timeout(DETAIL_REQUEST_TIMEOUT_MS)
            .emit(
              'vehicles:details',
              ids,
              (error: Error | null, response?: { details?: VehicleDetail[] }) => {
                resolve(error ? [] : (response?.details ?? []));
              },
            );
        });
      },
    }),
    [],
  );

  return { rows, connectionStatus, lastPayloadAt, api, setViewport };
}
