import { BACKEND_URL } from './config';

export type LineStatusLevel = 'good' | 'minor' | 'severe';

export type LineStatusInfo = {
  level: LineStatusLevel;
  description: string;
  reason?: string;
};

type RawLineStatus = {
  statusSeverity: number;
  statusSeverityDescription: string;
  reason?: string;
};

export type RawLine = {
  id: string;
  lineStatuses?: RawLineStatus[];
};

/**
 * TfL's severity codes, mapped one by one (from `/Line/Meta/Severity`). They
 * are not a scale: 10 is Good Service, but 18 (No Issues) and 19 (Information)
 * sit above it and 13 (No Step Free Access) is a station notice, not a delay.
 * Anything not listed is treated as minor — an unfamiliar code is worth a
 * glance, not a red dot.
 */
const SEVERE_CODES = new Set([
  1, // Closed
  2, // Suspended
  3, // Part Suspended
  4, // Planned Closure
  5, // Part Closure
  6, // Severe Delays
  11, // Part Closed
  16, // Not Running
  20, // Service Closed
]);
const GOOD_CODES = new Set([
  10, // Good Service
  18, // No Issues
  19, // Information
]);

export function levelForSeverity(severity: number): LineStatusLevel {
  if (SEVERE_CODES.has(severity)) {
    return 'severe';
  }
  return GOOD_CODES.has(severity) ? 'good' : 'minor';
}

const LEVEL_RANK: Record<LineStatusLevel, number> = { good: 0, minor: 1, severe: 2 };

/**
 * One entry per line, carrying the worst of its statuses. A line reports one
 * status per disruption — part closure on one branch, good service on the rest —
 * in no promised order, so reading only the first can show a closed line green.
 */
export function summariseLineStatuses(lines: RawLine[]): Map<string, LineStatusInfo> {
  const map = new Map<string, LineStatusInfo>();
  for (const line of lines) {
    let worst: LineStatusInfo | null = null;
    for (const status of line.lineStatuses ?? []) {
      const level = levelForSeverity(status.statusSeverity);
      if (!worst || LEVEL_RANK[level] > LEVEL_RANK[worst.level]) {
        worst = { level, description: status.statusSeverityDescription, reason: status.reason };
      }
    }
    if (worst) {
      map.set(line.id.toLowerCase(), worst);
    }
  }
  return map;
}

const STATUS_CACHE_MS = 60_000;
let cachedStatuses: Map<string, LineStatusInfo> | null = null;
let lastFetchTime = 0;
let inflightFetch: Promise<Map<string, LineStatusInfo>> | null = null;

/**
 * Network status, from the backend rather than TfL: the device never contacts
 * TfL directly (PRIVACY.md §5), and the backend holds one cached copy for every
 * client.
 */
export async function fetchLineStatuses(): Promise<Map<string, LineStatusInfo>> {
  const now = Date.now();
  if (cachedStatuses && now - lastFetchTime < STATUS_CACHE_MS) {
    return cachedStatuses;
  }
  if (inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = (async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/line-status`);
      if (!response.ok) {
        return cachedStatuses ?? new Map();
      }
      const data = (await response.json()) as { lines?: RawLine[] };
      const map = summariseLineStatuses(data.lines ?? []);
      cachedStatuses = map;
      lastFetchTime = Date.now();
      return map;
    } catch {
      return cachedStatuses ?? new Map();
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

/** Test seam: the module-level cache would otherwise leak between cases. */
export function resetLineStatusCache() {
  cachedStatuses = null;
  lastFetchTime = 0;
  inflightFetch = null;
}
