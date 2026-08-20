const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { pollDelayMs, shouldRefreshOnConnect } = require('../src/poll-schedule');

const ACTIVE = 15000;
const IDLE = 300000;

describe('pollDelayMs', () => {
  it('uses the active cadence while anyone is connected', () => {
    assert.equal(
      pollDelayMs({ connectedClients: 1, activeIntervalMs: ACTIVE, idleIntervalMs: IDLE }),
      ACTIVE,
    );
    assert.equal(
      pollDelayMs({ connectedClients: 400, activeIntervalMs: ACTIVE, idleIntervalMs: IDLE }),
      ACTIVE,
    );
  });

  it('backs off to the idle cadence when nobody is connected', () => {
    // The whole point: a cycle costs a ~10s fetch and an ~80MB parse, and
    // running it for nobody was most of the compute bill.
    assert.equal(
      pollDelayMs({ connectedClients: 0, activeIntervalMs: ACTIVE, idleIntervalMs: IDLE }),
      IDLE,
    );
  });

  // null means "arm nothing" — the pairing for a platform that sleeps idle
  // containers, where holding a process awake to refresh unread data is exactly
  // the cost being avoided.
  for (const idleIntervalMs of [0, -1, NaN, undefined]) {
    it(`suspends entirely when the idle interval is ${String(idleIntervalMs)}`, () => {
      assert.equal(
        pollDelayMs({ connectedClients: 0, activeIntervalMs: ACTIVE, idleIntervalMs }),
        null,
      );
    });
  }

  it('never suspends while a client is connected, whatever the idle setting', () => {
    assert.equal(
      pollDelayMs({ connectedClients: 1, activeIntervalMs: ACTIVE, idleIntervalMs: 0 }),
      ACTIVE,
    );
  });
});

describe('shouldRefreshOnConnect', () => {
  const now = 1_700_000_000_000;

  it('refreshes when nothing has ever been polled', () => {
    assert.equal(
      shouldRefreshOnConnect({ lastPollAtMs: null, nowMs: now, activeIntervalMs: ACTIVE }),
      true,
    );
    assert.equal(
      shouldRefreshOnConnect({ lastPollAtMs: undefined, nowMs: now, activeIntervalMs: ACTIVE }),
      true,
    );
  });

  it('refreshes when the fleet is older than one active cycle', () => {
    // Otherwise the first visitor after a quiet spell watches motionless
    // vehicles until the idle timer next fires — up to five minutes.
    assert.equal(
      shouldRefreshOnConnect({ lastPollAtMs: now - ACTIVE - 1, nowMs: now, activeIntervalMs: ACTIVE }),
      true,
    );
  });

  it('does not refresh when the fleet is already current', () => {
    // A socket joining a busy service must not cost an extra whole-network fetch.
    assert.equal(
      shouldRefreshOnConnect({ lastPollAtMs: now - 1000, nowMs: now, activeIntervalMs: ACTIVE }),
      false,
    );
  });

  it('treats exactly one interval old as still current', () => {
    assert.equal(
      shouldRefreshOnConnect({ lastPollAtMs: now - ACTIVE, nowMs: now, activeIntervalMs: ACTIVE }),
      false,
    );
  });
});
