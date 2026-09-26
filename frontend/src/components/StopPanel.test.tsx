import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKEND_URL } from '../config';
import { StopPanel, type SelectedStop } from './StopPanel';

// Tells React this is a test renderer, so act() flushes effects and warns if
// an update escapes it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OXFORD_CIRCUS: SelectedStop = { id: '940GZZLUOXC', name: 'Oxford Circus', coordinates: [-0.1419, 51.5152] };
const BANK: SelectedStop = { id: '940GZZLUBNK', name: 'Bank', coordinates: [-0.0886, 51.5133] };

const arrival = (id: string, lineId: string, timeToStation: number, destinationName = 'Somewhere') => ({
  id,
  lineId,
  lineName: lineId[0].toUpperCase() + lineId.slice(1),
  destinationName,
  timeToStation,
});

const ok = (arrivals: unknown[]) => new Response(JSON.stringify({ arrivals }));
const never = () => new Promise<Response>(() => {});

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui);
  });
  await flush();
}

/** Lets pending fetch promises settle and React commit what they set. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = () => container.textContent ?? '';
const etas = () => [...container.querySelectorAll('.stop-eta')].map((node) => node.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('StopPanel', () => {
  it('asks the backend for arrivals, never TfL', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} />);
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/stops/940GZZLUOXC/arrivals`);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('tfl.gov.uk');
  });

  it('clears the error once a later refresh succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(ok([arrival('a', 'victoria', 300, 'Brixton')]));

    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} />);
    expect(text()).toContain('temporarily unavailable');

    await flush(15_000);
    expect(text()).toContain('Brixton');
    expect(text()).not.toContain('unavailable');
  });

  it('never shows the previous stop’s arrivals after switching stops', async () => {
    fetchMock.mockResolvedValueOnce(ok([arrival('a', 'victoria', 300, 'Brixton')]));
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} />);
    expect(text()).toContain('Brixton');

    fetchMock.mockImplementation(never);
    await render(<StopPanel stop={BANK} onClose={() => {}} />);
    expect(text()).not.toContain('Brixton');
    expect(text()).toContain('Loading live arrivals');
  });

  it('does not carry an error over to the next stop', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} />);
    expect(text()).toContain('temporarily unavailable');

    fetchMock.mockImplementation(never);
    await render(<StopPanel stop={BANK} onClose={() => {}} />);
    expect(text()).not.toContain('unavailable');
  });

  it('counts ETAs down between polls', async () => {
    fetchMock.mockResolvedValueOnce(ok([arrival('a', 'central', 150)])).mockImplementation(never);
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} />);
    expect(etas()).toEqual(['3 min']);

    await flush(60_000);
    expect(etas()).toEqual(['2 min']);

    await flush(60_000);
    expect(etas()).toEqual(['due']);
  });

  it('drops a vehicle once it is well past its predicted arrival', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([arrival('a', 'central', 20), arrival('b', 'central', 400)]))
      .mockImplementation(never);
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} />);
    expect(etas()).toHaveLength(2);

    await flush(60_000);
    expect(etas()).toEqual(['6 min']);
  });

  it('renders rows as real buttons that select the line', async () => {
    fetchMock.mockResolvedValue(ok([arrival('a', 'Victoria', 300)]));
    const onSelectLine = vi.fn();
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} onSelectLine={onSelectLine} />);

    const row = container.querySelector('button.stop-arrival-row') as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row.type).toBe('button');
    await act(async () => row.click());
    expect(onSelectLine).toHaveBeenCalledWith('victoria');
  });

  it('does not poll while the app is in the background, and refreshes on return', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} active={false} />);
    await flush(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await render(<StopPanel stop={OXFORD_CIRCUS} onClose={() => {}} active />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
