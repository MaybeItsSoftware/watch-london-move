import { memo, useEffect, useState } from 'react';
import { BACKEND_URL, modeColorHex } from '../config';
import { StopMarker } from './StopMarker';

export type SelectedStop = {
  id: string;
  name: string;
  coordinates: [number, number];
};

type StopArrival = {
  id: string;
  lineId: string;
  lineName: string;
  destinationName: string;
  timeToStation: number;
  platformName?: string;
  towards?: string;
};

type StopPanelProps = {
  stop: SelectedStop;
  onClose: () => void;
  onSelectLine?: (lineId: string) => void;
  /** False while the app is backgrounded: polling stops and resumes on return. */
  active?: boolean;
};

const REFRESH_INTERVAL_MS = 15_000;
/** ETAs count down locally between polls; minute resolution needs nothing finer. */
const TICK_MS = 5_000;
/** A vehicle this far past its predicted arrival has left; the next poll will agree. */
const DEPARTED_AFTER_SEC = -30;
const MAX_ROWS = 8;

function formatArrivalMinutes(seconds: number): string {
  if (seconds < 45) {
    return 'due';
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

type Loaded = {
  stopId: string;
  arrivals: StopArrival[];
  /** Local clock at the response, which `timeToStation` is relative to. */
  fetchedAt: number;
};

export const StopPanel = memo(function StopPanel({
  stop,
  onClose,
  onSelectLine,
  active = true,
}: StopPanelProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedStopId, setFailedStopId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Everything is keyed by the stop it describes, so switching stops can never
  // show the previous stop's rows or its error while the new request is out.
  const current = loaded?.stopId === stop.id ? loaded : null;
  const error = failedStopId === stop.id;

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const stopId = stop.id;

    const load = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/stops/${encodeURIComponent(stopId)}/arrivals`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { arrivals?: StopArrival[] };
        if (!cancelled) {
          const arrivals = [...(data.arrivals ?? [])].sort((a, b) => a.timeToStation - b.timeToStation);
          const fetchedAt = Date.now();
          setLoaded({ stopId, arrivals, fetchedAt });
          setNow(fetchedAt);
          setFailedStopId(null);
        }
      } catch {
        if (!cancelled) {
          setFailedStopId(stopId);
        }
      }
    };

    void load();
    const interval = window.setInterval(load, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [stop.id, active]);

  const hasRows = current !== null;
  useEffect(() => {
    if (!active || !hasRows) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, hasRows]);

  const elapsedSec = current ? Math.max(0, (now - current.fetchedAt) / 1000) : 0;
  const rows = (current?.arrivals ?? [])
    .map((arr) => ({ ...arr, remaining: arr.timeToStation - elapsedSec }))
    .filter((arr) => arr.remaining > DEPARTED_AFTER_SEC)
    .slice(0, MAX_ROWS);

  return (
    <div className="stop-panel panel" role="region" aria-label={`Arrivals for ${stop.name}`}>
      <div className="stop-panel-header">
        <div className="stop-panel-title-wrap">
          <StopMarker />
          <h2 className="stop-panel-title">{stop.name}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close stop arrivals">
          ✕
        </button>
      </div>

      <div className="stop-panel-body">
        {current === null ? (
          <p className="stop-panel-status" role="status">
            {error ? 'Live arrivals temporarily unavailable' : 'Loading live arrivals…'}
          </p>
        ) : rows.length === 0 ? (
          <p className="stop-panel-status">No arrivals reported in the next 30 minutes</p>
        ) : (
          <ul className="stop-arrivals-list">
            {rows.map((arr) => {
              const color = modeColorHex(arr.lineId.toLowerCase()) || '#DC241F';
              const content = (
                <>
                  <span className="stop-line-badge" style={{ backgroundColor: color }}>
                    {arr.lineName}
                  </span>
                  <span className="stop-dest-wrap">
                    <span className="stop-destination">{arr.destinationName || arr.towards || 'In Service'}</span>
                    {arr.platformName ? <span className="stop-platform">{arr.platformName}</span> : null}
                  </span>
                  <span className="stop-eta">{formatArrivalMinutes(arr.remaining)}</span>
                </>
              );
              return (
                <li key={arr.id}>
                  {onSelectLine ? (
                    // A real button, so Enter and Space work and it is announced
                    // as one, rather than a list item that only answers a click.
                    <button
                      type="button"
                      className="stop-arrival-row"
                      onClick={() => onSelectLine(arr.lineId.toLowerCase())}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="stop-arrival-row">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {current !== null && error ? (
          <p className="stop-panel-status stop-panel-stale" role="status">
            Couldn't refresh — counting down from the last update
          </p>
        ) : null}
      </div>
    </div>
  );
});
