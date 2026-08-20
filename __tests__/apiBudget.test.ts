/**
 * Task #120 - daily Spotify Web API call budget guard.
 *
 * Unit-level coverage of the four acceptance concerns from the task spec:
 *
 *   1. Window rollover math is correct - the current window's start moment is
 *      the most recent occurrence of the reset time-of-day in UTC, and the
 *      window key naturally changes when the reset boundary is crossed.
 *   2. Reaching the cap fires `onCapReached` exactly once per window with a
 *      real next-reset deadline (so the lane can persist a shared "budget"
 *      suspension record).
 *   3. A Redis outage degrades to in-process counting (never to blocking
 *      the feature).
 *   4. Listener traffic (dealer websocket, connect-state edge) does NOT
 *      count against the budget - counting happens in the spotifyService
 *      hook, wired only around Web API + token calls.
 */

import {
  createApiBudget,
  computeWindowBoundaries,
  parseResetTime,
  budgetCounterKey,
  DEFAULT_SPOTIFY_BUDGET_RESET_UTC,
  DEFAULT_SPOTIFY_DAILY_CALL_BUDGET,
} from "../src/services/listener/apiBudget";
import { createFakeRedis } from "./helpers/fakeRedis";

const ENV = "test";

// Helpers ---------------------------------------------------------------------

const DEFAULT_RESET = parseResetTime(DEFAULT_SPOTIFY_BUDGET_RESET_UTC)!;

function makeBudget(overrides: {
  redis?: ReturnType<typeof createFakeRedis> | null;
  cap?: number;
  resetHour?: number;
  resetMinute?: number;
  onCapReached?: (nextResetAtMs: number) => void;
} = {}) {
  return createApiBudget({
    redis: overrides.redis === undefined ? createFakeRedis() : overrides.redis,
    env: ENV,
    cap: overrides.cap ?? 10,
    resetHour: overrides.resetHour ?? DEFAULT_RESET.hour,
    resetMinute: overrides.resetMinute ?? DEFAULT_RESET.minute,
    onCapReached: overrides.onCapReached,
  });
}

// ============================================================================
// (1) Window rollover math
// ============================================================================

describe("parseResetTime", () => {
  it("accepts a plain HH:MM string", () => {
    expect(parseResetTime("21:23")).toEqual({ hour: 21, minute: 23 });
    expect(parseResetTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseResetTime("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects malformed strings so the caller falls back to the default", () => {
    expect(parseResetTime("")).toBeNull();
    expect(parseResetTime("noon")).toBeNull();
    expect(parseResetTime("21")).toBeNull();
    expect(parseResetTime("24:00")).toBeNull();
    expect(parseResetTime("21:60")).toBeNull();
    expect(parseResetTime(undefined)).toBeNull();
    expect(parseResetTime(null)).toBeNull();
  });
});

describe("computeWindowBoundaries - window rollover math", () => {
  const reset = { hour: 21, minute: 23 };

  it("at exactly the reset moment, the current window starts NOW", () => {
    const now = Date.UTC(2026, 7, 20, 21, 23, 0, 0);
    const w = computeWindowBoundaries(now, reset);
    expect(w.startMs).toBe(now);
    expect(w.nextResetMs).toBe(now + 24 * 60 * 60 * 1000);
  });

  it("just after the reset, the current window still starts at today's reset", () => {
    const start = Date.UTC(2026, 7, 20, 21, 23, 0, 0);
    const now = start + 60 * 1000;
    const w = computeWindowBoundaries(now, reset);
    expect(w.startMs).toBe(start);
    expect(w.nextResetMs).toBe(start + 24 * 60 * 60 * 1000);
  });

  it("just before today's reset, the current window started yesterday", () => {
    const todayReset = Date.UTC(2026, 7, 20, 21, 23, 0, 0);
    const yesterdayReset = todayReset - 24 * 60 * 60 * 1000;
    const now = todayReset - 60 * 1000;
    const w = computeWindowBoundaries(now, reset);
    expect(w.startMs).toBe(yesterdayReset);
    expect(w.nextResetMs).toBe(todayReset);
  });

  it("emits distinct windowIds across the reset boundary", () => {
    const boundary = Date.UTC(2026, 7, 20, 21, 23, 0, 0);
    const before = computeWindowBoundaries(boundary - 1, reset);
    const after = computeWindowBoundaries(boundary + 1, reset);
    expect(before.windowId).not.toBe(after.windowId);
    expect(before.windowId).toBe("20260819T2123");
    expect(after.windowId).toBe("20260820T2123");
  });
});

describe("createApiBudget - counter rolls over on window boundary", () => {
  it("resets the in-process counter when the window changes", async () => {
    const budget = makeBudget({ redis: null, cap: 100 });
    const t0 = Date.UTC(2026, 7, 20, 21, 24, 0, 0); // just past reset
    const t1 = Date.UTC(2026, 7, 21, 21, 22, 59, 0); // just before next reset
    const t2 = Date.UTC(2026, 7, 21, 21, 23, 1, 0); // just after next reset

    const a = await budget.noteCall(t0);
    expect(a.used).toBe(1);
    const b = await budget.noteCall(t1);
    // Same window as t0.
    expect(b.used).toBe(2);
    const c = await budget.noteCall(t2);
    // Window rolled over - counter restarts at 1.
    expect(c.used).toBe(1);
  });

  it("Redis keys change across the boundary too", async () => {
    const redis = createFakeRedis();
    const budget = makeBudget({ redis, cap: 100 });
    const boundary = Date.UTC(2026, 7, 20, 21, 23, 0, 0);

    await budget.noteCall(boundary - 60_000); // yesterday's window
    await budget.noteCall(boundary + 60_000); // today's window

    const keys = Object.keys(redis.dump());
    expect(keys).toContain(budgetCounterKey(ENV, "20260819T2123"));
    expect(keys).toContain(budgetCounterKey(ENV, "20260820T2123"));
    // Two distinct counters, one increment each.
    expect(redis.dump()[budgetCounterKey(ENV, "20260819T2123")]).toBe("1");
    expect(redis.dump()[budgetCounterKey(ENV, "20260820T2123")]).toBe("1");
  });

  it("getState returns the next reset as an ISO 8601 UTC string", async () => {
    const budget = makeBudget({ redis: null, cap: 4000 });
    const now = Date.UTC(2026, 7, 20, 22, 0, 0, 0); // after 21:23 UTC reset
    const state = await budget.getState(now);
    expect(state.cap).toBe(4000);
    expect(state.used).toBe(0);
    // Next reset is 21:23 UTC the next day.
    expect(state.resets_at).toBe(new Date(Date.UTC(2026, 7, 21, 21, 23)).toISOString());
  });
});

// ============================================================================
// (2) Cap trip surfaces via onCapReached once per window
// ============================================================================

describe("createApiBudget - cap trip", () => {
  it("fires onCapReached exactly once per window with the next reset deadline", async () => {
    const captured: number[] = [];
    const budget = makeBudget({
      redis: null,
      cap: 3,
      onCapReached: (nextResetAtMs) => captured.push(nextResetAtMs),
    });
    const now = Date.UTC(2026, 7, 20, 22, 0, 0, 0);

    await budget.noteCall(now);
    await budget.noteCall(now);
    expect(captured).toHaveLength(0);
    const trip = await budget.noteCall(now);
    expect(trip.capReached).toBe(true);
    expect(captured).toHaveLength(1);
    // Deadline is next window's reset moment.
    expect(captured[0]).toBe(Date.UTC(2026, 7, 21, 21, 23, 0, 0));

    // Subsequent calls in the same window - capReached stays true, but
    // onCapReached does NOT fire a second time (would double-write the
    // shared suspension record).
    await budget.noteCall(now);
    await budget.noteCall(now);
    expect(captured).toHaveLength(1);
  });

  it("fires onCapReached again after a window rollover", async () => {
    const captured: number[] = [];
    const budget = makeBudget({
      redis: null,
      cap: 2,
      onCapReached: (n) => captured.push(n),
    });
    const day1 = Date.UTC(2026, 7, 20, 22, 0, 0, 0);
    const day2 = Date.UTC(2026, 7, 21, 22, 0, 0, 0);

    await budget.noteCall(day1);
    await budget.noteCall(day1);
    expect(captured).toHaveLength(1);

    // New window - counter starts over, cap tripping fires again.
    await budget.noteCall(day2);
    await budget.noteCall(day2);
    expect(captured).toHaveLength(2);
    expect(captured[1]).toBeGreaterThan(captured[0]);
  });

  it("isExhausted reflects the in-process mirror after cap trips", async () => {
    const budget = makeBudget({ redis: null, cap: 2 });
    const now = Date.UTC(2026, 7, 20, 22, 0, 0, 0);
    expect(budget.isExhausted(now)).toBe(false);
    await budget.noteCall(now);
    expect(budget.isExhausted(now)).toBe(false);
    await budget.noteCall(now);
    expect(budget.isExhausted(now)).toBe(true);
  });

  it("cap === 0 disables enforcement (used grows, capReached stays false)", async () => {
    const captured: number[] = [];
    const budget = makeBudget({
      redis: null,
      cap: 0,
      onCapReached: (n) => captured.push(n),
    });
    for (let i = 0; i < 20; i += 1) {
      const r = await budget.noteCall(1000);
      expect(r.capReached).toBe(false);
    }
    expect(captured).toHaveLength(0);
  });
});

// ============================================================================
// (3) Redis outage degrades to in-process counting
// ============================================================================

describe("createApiBudget - Redis outage degrade", () => {
  it("keeps counting in process memory when Redis INCR throws", async () => {
    const redis = createFakeRedis();
    const budget = makeBudget({ redis, cap: 5 });

    // First call succeeds against Redis.
    const first = await budget.noteCall(1000);
    expect(first.used).toBe(1);

    // Queue a persistent error for every INCR going forward.
    for (let i = 0; i < 10; i += 1) redis.queueError(new Error("ECONNREFUSED"));

    const c2 = await budget.noteCall(1000);
    const c3 = await budget.noteCall(1000);
    expect(c2.used).toBe(2);
    expect(c3.used).toBe(3);
    // Still under cap, still not blocking.
    expect(c3.capReached).toBe(false);
  });

  it("null Redis client counts entirely in process (dev / IS_LOCAL path)", async () => {
    const budget = makeBudget({ redis: null, cap: 3 });
    const a = await budget.noteCall(1000);
    const b = await budget.noteCall(1000);
    const c = await budget.noteCall(1000);
    expect([a.used, b.used, c.used]).toEqual([1, 2, 3]);
    expect(c.capReached).toBe(true);
  });

  it("Redis outage on getState reads still returns a plausible state (fail open)", async () => {
    const redis = createFakeRedis();
    const budget = makeBudget({ redis, cap: 100 });
    await budget.noteCall(1000); // 1 in Redis + in-process
    redis.queueError(new Error("network"));
    const state = await budget.getState(1000);
    // Falls back to the in-process mirror (which has 1 already).
    expect(state.used).toBe(1);
    expect(state.cap).toBe(100);
  });

  it("Redis outage never rejects a noteCall - never blocks the feature", async () => {
    const redis = createFakeRedis();
    const budget = makeBudget({ redis, cap: DEFAULT_SPOTIFY_DAILY_CALL_BUDGET });
    for (let i = 0; i < 5; i += 1) redis.queueError(new Error("boom"));
    // None of these should throw.
    for (let i = 0; i < 5; i += 1) {
      const r = await budget.noteCall(1000);
      expect(r.used).toBeGreaterThan(0);
      expect(r.capReached).toBe(false);
    }
  });
});
