import { modeColorHex } from '../config';
import type { VehicleDetail, VehicleRow } from '../types';

type InfoPanelProps = {
  vehicle: VehicleRow;
  /** Fetched separately from the vehicle stream; null until it arrives. */
  detail: VehicleDetail | null;
  now: number;
  following: boolean;
  onToggleFollow: () => void;
  onClose: () => void;
};

function formatCountdown(seconds: number): string {
  if (seconds <= 0) {
    return 'due';
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
  onClose,
}: InfoPanelProps) {
  const ageSeconds = Math.max(0, Math.floor((now - vehicle.receivedAt) / 1000));
  const countdown =
    vehicle.timeToStation == null
      ? null
      : formatCountdown(vehicle.timeToStation - (now - vehicle.receivedAt) / 1000);

  return (
    <div className="info-panel panel">
      <div className="info-header">
        <span
          className="mode-chip"
          style={{ background: modeColorHex(vehicle.routeGroup) }}
          aria-hidden="true"
        />
        <span className="info-line">{vehicle.line}</span>
        {detail ? <span className="info-destination">→ {detail.destination}</span> : null}
        <button className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      {detail?.station_name ? (
        <p className="info-next">
          Next: {detail.station_name}
          {countdown ? <span className="countdown"> {countdown}</span> : null}
        </p>
      ) : null}
      <p className="info-age">updated {ageSeconds}s ago</p>
      <button
        className={`pill-button${following ? ' active' : ''}`}
        onClick={onToggleFollow}
        aria-pressed={following}
      >
        {following ? 'Following' : 'Follow'}
      </button>
    </div>
  );
}
