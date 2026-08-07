import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { DETAIL_REQUEST_TIMEOUT_MS, INTERPOLATION_MS, SOCKET_URL, TARGET_FPS } from './config';
import { approxDistanceMeters, bearingBetween, easeInOutSine, lerpAngle } from './geo';
import { useAppActive } from './lifecycle';
import type {
  Bounds,
  ConnectionStatus,
  Payload,
  RenderVehicle,
  VehicleDetail,
  VehicleRow,
} from './types';

const MIN_GLIDE_MS = 2000;
const MAX_GLIDE_MS = 180000;
// Below this distance a hop is treated as jitter and keeps the old heading.
const HEADING_MIN_DISTANCE_M = 15;

function displayedPose(vehicle: RenderVehicle, now: number) {
  const t = Math.min(Math.max((now - vehicle.receivedAt) / vehicle.durationMs, 0), 1);
  const eased = easeInOutSine(t);
  return {
    lon: vehicle.from[0] + (vehicle.to[0] - vehicle.from[0]) * eased,
    lat: vehicle.from[1] + (vehicle.to[1] - vehicle.from[1]) * eased,
    heading: lerpAngle(vehicle.fromHeading, vehicle.toHeading, eased),
  };
}

function toRow(vehicle: RenderVehicle, now: number): VehicleRow {
  const pose = displayedPose(vehicle, now);
  return {
    ...vehicle,
    position: [pose.lon, pose.lat, 0],
    heading: pose.heading,
  };
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

      for (const tuple of payload.vehicles ?? []) {
        const [id, typeIndex, line, lat, lon, heading, groupIndex, timeToStation] = tuple;
        const type = types[typeIndex] ?? 'bus';
        seen.add(id);

        const previous = vehiclesRef.current.get(id);
        // Re-target from the currently displayed pose (same easing math,
        // evaluated at receipt time) so mid-glide updates don't hitch.
        const displayed = previous ? displayedPose(previous, now) : null;
        const from: [number, number] = displayed ? [displayed.lon, displayed.lat] : [lon, lat];
        const to: [number, number] = [lon, lat];
        const toHeading =
          approxDistanceMeters(from, to) > HEADING_MIN_DISTANCE_M
            ? bearingBetween(from, to)
            : displayed
              ? displayed.heading
              : heading;
        const fromHeading = displayed ? displayed.heading : toHeading;
        const durationMs = Math.min(
          Math.max(timeToStation == null ? INTERPOLATION_MS : timeToStation * 1000, MIN_GLIDE_MS),
          MAX_GLIDE_MS,
        );

        vehiclesRef.current.set(id, {
          id,
          type,
          line,
          routeGroup: groups[groupIndex] ?? type,
          timeToStation,
          tile,
          from,
          to,
          fromHeading,
          toHeading,
          receivedAt: now,
          durationMs,
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

    const minFrameMs = 1000 / TARGET_FPS;
    let frame = 0;
    let lastTickAt = 0;

    const animate = (now: number) => {
      frame = window.requestAnimationFrame(animate);
      if (now - lastTickAt < minFrameMs) {
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
    return [...vehiclesRef.current.values()].map((vehicle) => toRow(vehicle, now));
  }, [tick]);

  const api = useMemo<VehiclesApi>(
    () => ({
      getDisplayed(id: string) {
        const vehicle = vehiclesRef.current.get(id);
        return vehicle ? toRow(vehicle, Date.now()) : null;
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
