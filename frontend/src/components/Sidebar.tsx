import { memo, useMemo } from 'react';
import { FILTER_COLORS, FILTER_LABELS, FILTER_ORDER } from '../config';
import type { BasemapMode } from '../config';
import type { FilterKey, LineSummary } from '../types';

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
  onClearLines: () => void;
  showRoutes: boolean;
  onToggleRoutes: () => void;
  basemapMode: BasemapMode;
  onBasemapModeChange: (mode: BasemapMode) => void;
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
  onClearLines,
  showRoutes,
  onToggleRoutes,
  basemapMode,
  onBasemapModeChange,
}: SidebarProps) {
  const selected = useMemo(() => new Set(selectedLines), [selectedLines]);

  const visibleLines = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return lines.filter(
      (line) => filters[line.group] && (needle === '' || matches(line, needle)),
    );
  }, [lines, filters, search]);

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
        {/* Counts come from what the backend streams, which is now scoped to
            the viewport — so they are what is on screen, not the whole network. */}
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
        placeholder="Search a line or bus route"
        aria-label="Search a line or bus route"
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

      <div className="sidebar-actions">
        <button
          className={`pill-button${showRoutes ? ' active' : ''}`}
          onClick={onToggleRoutes}
          aria-pressed={showRoutes}
        >
          routes
        </button>
        {/* Auto follows the sun over London: bright by day, dark at night. */}
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

      <div className="line-list">
        {visibleLines.length === 0 ? (
          <p className="line-empty">
            {lines.length === 0 ? 'Waiting for vehicle data…' : 'No routes match that search.'}
          </p>
        ) : (
          visibleLines.map((line) => (
            <button
              key={line.id}
              className={`line-row${selected.has(line.id) ? ' selected' : ''}`}
              onClick={() => onToggleLine(line.id)}
              aria-pressed={selected.has(line.id)}
            >
              <span className="line-swatch" style={{ background: line.color }} />
              <span className="line-label">{line.label}</span>
              <span className="line-group">{FILTER_LABELS[line.group]}</span>
              <span className="line-count">{line.count}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
});
