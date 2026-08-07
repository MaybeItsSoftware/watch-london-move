import type { ConnectionStatus } from '../types';

type StatusBarProps = {
  status: ConnectionStatus;
  vehicleCount: number;
  lastPayloadAt: number | null;
  now: number;
  /** Nudged clear of the sidebar when it is open. */
  shifted?: boolean;
};

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

export function StatusBar({ status, vehicleCount, lastPayloadAt, now, shifted }: StatusBarProps) {
  const ageSeconds =
    lastPayloadAt == null ? null : Math.max(0, Math.floor((now - lastPayloadAt) / 1000));

  return (
    <div className={`status-bar panel${shifted ? ' shifted' : ''}`}>
      <span className={`status-dot ${status}`} title={STATUS_LABELS[status]} />
      <span className="status-label">{STATUS_LABELS[status]}</span>
      <span className="status-count">{vehicleCount} vehicles</span>
      <span className="status-age">
        {ageSeconds == null ? 'no data yet' : `data ${ageSeconds}s old`}
      </span>
    </div>
  );
}
