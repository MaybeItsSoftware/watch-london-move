import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLineStatuses,
  levelForSeverity,
  resetLineStatusCache,
  summariseLineStatuses,
} from './line-status';
import { BACKEND_URL } from './config';

const status = (statusSeverity: number, statusSeverityDescription: string, reason?: string) => ({
  statusSeverity,
  statusSeverityDescription,
  reason,
});

describe('levelForSeverity', () => {
  it.each([
    [10, 'good'], // Good Service
    [18, 'good'], // No Issues
    [19, 'good'], // Information
    [9, 'minor'], // Minor Delays
    [13, 'minor'], // No Step Free Access
    [7, 'minor'], // Reduced Service
    [6, 'severe'], // Severe Delays
    [5, 'severe'], // Part Closure
    [3, 'severe'], // Part Suspended
    [20, 'severe'], // Service Closed
    [99, 'minor'], // unknown: worth a glance, not a red dot
  ])('maps %i to %s', (code, level) => {
    expect(levelForSeverity(code)).toBe(level);
  });
});

describe('summariseLineStatuses', () => {
  it('takes the worst of every status a line reports, whatever the order', () => {
    const map = summariseLineStatuses([
      {
        id: 'District',
        lineStatuses: [status(10, 'Good Service'), status(5, 'Part Closure', 'No service to Richmond')],
      },
    ]);
    expect(map.get('district')).toEqual({
      level: 'severe',
      description: 'Part Closure',
      reason: 'No service to Richmond',
    });
  });

  it('does not show an informational notice as a disruption', () => {
    const map = summariseLineStatuses([
      { id: 'jubilee', lineStatuses: [status(19, 'Information', 'Lift out of order')] },
      { id: 'victoria', lineStatuses: [status(13, 'No Step Free Access')] },
    ]);
    expect(map.get('jubilee')?.level).toBe('good');
    expect(map.get('victoria')?.level).toBe('minor');
  });

  it('skips lines with no statuses and keys the Overground lines by their own ids', () => {
    const map = summariseLineStatuses([
      { id: 'mildmay', lineStatuses: [status(10, 'Good Service')] },
      { id: 'weaver' },
    ]);
    expect([...map.keys()]).toEqual(['mildmay']);
    expect(map.has('overground')).toBe(false);
  });
});

describe('fetchLineStatuses', () => {
  beforeEach(() => {
    resetLineStatusCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the backend, never TfL', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ lines: [{ id: 'victoria', lineStatuses: [status(9, 'Minor Delays')] }] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const map = await fetchLineStatuses();
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/line-status`);
    expect(map.get('victoria')?.level).toBe('minor');
  });

  it('keeps the last good copy when a refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ lines: [{ id: 'dlr', lineStatuses: [status(10, 'Good Service')] }] }))),
    );
    const first = await fetchLineStatuses();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    expect(await fetchLineStatuses()).toBe(first);
    vi.useRealTimers();
  });
});
