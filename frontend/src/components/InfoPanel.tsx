import { lineSwatchHex } from '../config';
import type { VehicleDetail, VehicleRow } from '../types';

type InfoPanelProps = {
  vehicle: VehicleRow;
  /** Fetched separately from the vehicle stream; null until it arrives. */
  detail: VehicleDetail | null;
  now: number;
  following: boolean;
  onToggleFollow: () => void;
  /** Whether the sidebar is already narrowed to this vehicle's route. */
  routeIsolated: boolean;
  onToggleIsolateRoute: () => void;
  onClose: () => void;
};

// TfL keeps reporting a vehicle against a stop for a while after it is due
// there, so "due" is a state a vehicle sits in rather than an instant it passes
// through. Once it has sat there a while, say so instead of counting up.
const STALE_ARRIVAL_MS = 60000;

// Coordinates are rounded to 5dp on the wire, so a stop named in a detail
// response is bit-identical to the same stop in a vehicle payload. ~1.1m, far
// below the spacing of two distinct stops.
const SAME_STOP_EPSILON_DEG = 1e-5;

/**
 * The stop this vehicle is heading for *now*, which is not necessarily the one
 * TfL currently leads with: predictions arrive around 70 seconds stale, so a
 * vehicle working through its queued schedule is often a stop or two beyond it.
 */
function nextStopName(vehicle: VehicleRow, detail: VehicleDetail | null): string {
  const match = detail?.next_stops?.find(
    (stop) =>
      Math.abs(stop.lon - vehicle.to[0]) <= SAME_STOP_EPSILON_DEG &&
      Math.abs(stop.lat - vehicle.to[1]) <= SAME_STOP_EPSILON_DEG,
  );
  return match?.name ?? detail?.station_name ?? '';
}

function formatCountdown(seconds: number, overdueMs: number): string {
  if (seconds <= 0) {
    return overdueMs > STALE_ARRIVAL_MS ? 'at stop' : 'due';
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return minutes > 0 ? `in ${minutes}m ${rest}s` : `in ${rest}s`;
}

export function InfoPanel({
  vehicle,
  detail,
  now,
  following,
  onToggleFollow,
  routeIsolated,
  onToggleIsolateRoute,
  onClose,
}: InfoPanelProps) {
  // How long since we last heard about this vehicle, which is what "updated"
  // means — not how long its current glide has been running.
  const ageSeconds = Math.max(0, Math.floor((now - vehicle.updatedAt) / 1000));
  const stationName = nextStopName(vehicle, detail);
  const countdown =
    vehicle.timeToStation == null
      ? null
      : formatCountdown((vehicle.arrivesAt - now) / 1000, vehicle.overdueMs);

  return (
    <div className="info-panel panel">
      <div className="info-header">
        <span
          className="mode-chip"
          style={{ background: lineSwatchHex(vehicle) }}
          aria-hidden="true"
        />
        <span className="info-line">{vehicle.line}</span>
        {detail ? <span className="info-destination">→ {detail.destination}</span> : null}
        <button className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      {stationName ? (
        <p className="info-next">
          Next: {stationName}
          {countdown ? <span className="countdown"> {countdown}</span> : null}
        </p>
      ) : null}
      <p className="info-age">updated {ageSeconds}s ago</p>
      <div className="info-actions">
        <button
          className={`pill-button${following ? ' active' : ''}`}
          onClick={onToggleFollow}
          aria-pressed={following}
        >
          {following ? 'Following' : 'Follow'}
        </button>
        {/* The sidebar can already narrow the map to one route; this is the
            same control reached from the vehicle you are looking at. */}
        <button
          className={`pill-button${routeIsolated ? ' active' : ''}`}
          onClick={onToggleIsolateRoute}
          aria-pressed={routeIsolated}
        >
          {routeIsolated ? 'Whole network' : 'This route only'}
        </button>
      </div>
    </div>
  );
}
