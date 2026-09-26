import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FILTER_COLORS, FILTER_LABELS, FILTER_ORDER } from '../config';
import type { BasemapMode } from '../config';
import type { FilterKey, LineSummary } from '../types';
import type { LineStatusInfo } from '../line-status';
import type { StopRecord } from '../stop-index';
import { VIRTUALIZE_ABOVE_ROWS, rowWindow } from '../window-rows';
import { StopMarker } from './StopMarker';

const BASEMAP_MODES: { key: BasemapMode; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'day', label: 'Day' },
  { key: 'night', label: 'Night' },
];

type SidebarProps = {
  open: boolean;
  onToggleOpen: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  filters: Record<FilterKey, boolean>;
  modeCounts: Record<FilterKey, number>;
  onToggleMode: (key: FilterKey) => void;
  lines: LineSummary[];
  selectedLines: string[];
  onToggleLine: (id: string) => void;
  /** Narrow the map to exactly one route — what pressing Enter in search does. */
  onFocusLine: (id: string) => void;
  onClearLines: () => void;
  showRoutes: boolean;
  onToggleRoutes: () => void;
  basemapMode: BasemapMode;
  onBasemapModeChange: (mode: BasemapMode) => void;
  favoriteLines: string[];
  onToggleFavoriteLine: (id: string) => void;
  matchingStops: StopRecord[];
  onSelectStop: (stop: StopRecord) => void;
  lineStatuses: Map<string, LineStatusInfo>;
};

/* Drawn rather than set as ☰ / ✕: neither character is in the iOS system font,
   where they render as tofu boxes. */
function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 5h12M3 9h12M3 13h12" />
      </g>
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 3l8 8M11 3l-8 8" />
      </g>
    </svg>
  );
}

/** Fallback until the stylesheet has been read; matches the desktop value. */
const DEFAULT_ROW_STRIDE = 30;

/**
 * The row pitch, read from the stylesheet rather than hardcoded.
 *
 * `--line-row-stride` differs between pointer types (44px targets on touch),
 * and a windowed list that disagrees with CSS about row height drifts further
 * out of place with every row scrolled. Re-read when the pointer type changes,
 * which is a real event on a convertible laptop.
 */
function useRowStride(ref: React.RefObject<HTMLDivElement | null>, active: boolean): number {
  const [stride, setStride] = useState(DEFAULT_ROW_STRIDE);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) {
      return;
    }
    const read = () => {
      const raw = getComputedStyle(element).getPropertyValue('--line-row-stride');
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value) && value > 0) {
        setStride(value);
      }
    };
    read();
    const query = matchMedia('(pointer: coarse)');
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, [ref, active]);

  return stride;
}

function matches(line: LineSummary, needle: string): boolean {
  return (
    line.label.toLowerCase().includes(needle) ||
    line.id.toLowerCase().includes(needle) ||
    FILTER_LABELS[line.group].toLowerCase().includes(needle)
  );
}

/**
 * Memoised. The app re-renders at the animation frame rate — the whole fleet's
 * pose is re-derived every frame — and this component's subtree is the largest
 * in the app: on a wide view the line list is several hundred rows. None of it
 * depends on the frame clock, so the memo turns a per-frame reconciliation of
 * that list into one per change of the props below. Every callback prop is
 * stabilised with `useCallback` in App.tsx for exactly this reason; passing an
 * inline arrow would defeat the comparison.
 */
export const Sidebar = memo(function Sidebar({
  open,
  onToggleOpen,
  search,
  onSearchChange,
  filters,
  modeCounts,
  onToggleMode,
  lines,
  selectedLines,
  onToggleLine,
  onFocusLine,
  onClearLines,
  showRoutes,
  onToggleRoutes,
  basemapMode,
  onBasemapModeChange,
  favoriteLines,
  onToggleFavoriteLine,
  matchingStops,
  onSelectStop,
  lineStatuses,
}: SidebarProps) {
  const selected = useMemo(() => new Set(selectedLines), [selectedLines]);
  const favoriteSet = useMemo(() => new Set(favoriteLines), [favoriteLines]);

  const visibleLines = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return lines.filter(
      (line) => filters[line.group] && (needle === '' || matches(line, needle)),
    );
  }, [lines, filters, search]);

  const pinnedLines = useMemo(() => {
    if (favoriteLines.length === 0) return [];
    return lines.filter((line) => favoriteSet.has(line.id));
  }, [lines, favoriteSet, favoriteLines.length]);

  // --- windowing -----------------------------------------------------------
  //
  // The list runs to several hundred rows. Memoisation keeps it off the frame
  // path, but every filter keystroke still built, laid out and painted the lot
  // — and on a phone the sidebar is a sheet showing perhaps a dozen of them.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const windowed = open && visibleLines.length > VIRTUALIZE_ABOVE_ROWS;
  const stride = useRowStride(listRef, windowed);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || !windowed) {
      return;
    }
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [windowed]);

  // A narrowed search leaves the scroll position pointing past the end of the
  // new list, which would window in on nothing at all.
  useEffect(() => {
    const element = listRef.current;
    if (element && element.scrollTop !== 0) {
      element.scrollTop = 0;
    }
    setScrollTop(0);
  }, [search, filters]);

  const onScroll = useCallback(() => {
    const element = listRef.current;
    if (element) {
      setScrollTop(element.scrollTop);
    }
  }, []);

  const total = visibleLines.length;
  const slice = rowWindow(total, scrollTop, windowed ? viewportHeight : 0, stride);
  const rendered = windowed ? visibleLines.slice(slice.first, slice.last) : visibleLines;

  const renderRow = (line: LineSummary) => {
    const isFav = favoriteSet.has(line.id);
    const status = lineStatuses.get(line.id);

    return (
      <div
        key={line.id}
        className={`line-row${selected.has(line.id) ? ' selected' : ''}`}
      >
        <button
          type="button"
          className="line-row-main"
          onClick={() => onToggleLine(line.id)}
          aria-pressed={selected.has(line.id)}
        >
          <span className="line-swatch" style={{ background: line.color }} />
          <span className="line-label">{line.label}</span>
          {status ? (
            <span
              className={`line-status-dot ${status.level}`}
              title={`${line.label}: ${status.description}${status.reason ? ` — ${status.reason}` : ''}`}
            />
          ) : null}
          <span className="line-group">{FILTER_LABELS[line.group]}</span>
          <span className="line-count">{line.count}</span>
        </button>
        <button
          type="button"
          className={`star-button${isFav ? ' active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavoriteLine(line.id);
          }}
          aria-label={isFav ? `Unpin ${line.label}` : `Pin ${line.label}`}
          aria-pressed={isFav}
          title={isFav ? 'Unpin route' : 'Pin route'}
        >
          ★
        </button>
      </div>
    );
  };

  if (!open) {
    return (
      <button
        className="sidebar-reopen panel"
        onClick={onToggleOpen}
        aria-label="Show vehicle filters"
        aria-expanded={false}
      >
        <MenuIcon />
      </button>
    );
  }

  return (
    <aside className="sidebar panel" aria-label="Vehicle filters">
      <div className="sidebar-head">
        <span className="sidebar-title">Vehicles in view</span>
        <button
          className="icon-button"
          onClick={onToggleOpen}
          aria-label="Hide vehicle filters"
          aria-expanded
        >
          <CloseIcon />
        </button>
      </div>

      <input
        className="sidebar-search"
        type="search"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (matchingStops.length > 0) {
              event.preventDefault();
              onSelectStop(matchingStops[0]);
            } else if (visibleLines.length > 0) {
              event.preventDefault();
              onFocusLine(visibleLines[0].id);
            }
          }
        }}
        placeholder="Search lines, routes or stations…"
        aria-label="Search a line, bus route or station. Press Enter to select top match."
      />

      <div className="mode-chips">
        {FILTER_ORDER.map((key) => (
          <button
            key={key}
            className={`legend-pill${filters[key] ? ' active' : ''}`}
            onClick={() => onToggleMode(key)}
            aria-pressed={filters[key]}
          >
            <span className="legend-swatch" style={{ background: FILTER_COLORS[key] }} />
            <span className="legend-name">{FILTER_LABELS[key]}</span>
            <span className="legend-count">{modeCounts[key]}</span>
          </button>
        ))}
      </div>

      {pinnedLines.length > 0 ? (
        <div className="pinned-lines-bar">
          <span className="pinned-label">Pinned:</span>
          <div className="pinned-chips">
            {pinnedLines.map((line) => (
              <button
                key={line.id}
                className={`pinned-chip${selected.has(line.id) ? ' active' : ''}`}
                onClick={() => onToggleLine(line.id)}
                title={`Toggle ${line.label}`}
              >
                <span className="pinned-swatch" style={{ background: line.color }} />
                <span>{line.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sidebar-actions">
        <button
          className={`pill-button${showRoutes ? ' active' : ''}`}
          onClick={onToggleRoutes}
          aria-pressed={showRoutes}
        >
          routes
        </button>
        <div className="segmented" role="group" aria-label="Basemap">
          {BASEMAP_MODES.map((mode) => (
            <button
              key={mode.key}
              className={`segment${basemapMode === mode.key ? ' active' : ''}`}
              onClick={() => onBasemapModeChange(mode.key)}
              aria-pressed={basemapMode === mode.key}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {selectedLines.length > 0 ? (
          <button className="link-button" onClick={onClearLines}>
            clear {selectedLines.length} selected
          </button>
        ) : null}
      </div>

      {matchingStops.length > 0 ? (
        <div className="search-stops-container">
          <span className="search-stops-heading">Stations & Stops ({matchingStops.length})</span>
          <div className="search-stops-list">
            {matchingStops.map((stop) => (
              <button
                key={stop.id}
                className="search-stop-item"
                onClick={() => onSelectStop(stop)}
              >
                <StopMarker className="search-stop-icon" />
                <span className="search-stop-name">{stop.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div
        className="line-list"
        ref={listRef}
        onScroll={windowed ? onScroll : undefined}
      >
        {total === 0 && matchingStops.length === 0 ? (
          <p className="line-empty">
            {lines.length === 0 ? 'Waiting for vehicle data…' : 'No routes or stations match that search.'}
          </p>
        ) : windowed ? (
          <div className="line-list-sizer" style={{ height: slice.height }}>
            <div
              className="line-list-window"
              style={{ transform: `translateY(${slice.offset}px)` }}
            >
              {rendered.map(renderRow)}
            </div>
          </div>
        ) : (
          rendered.map(renderRow)
        )}
      </div>
    </aside>
  );
});
