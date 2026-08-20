/**
 * Daily Spotify Web API call budget guard (task #120 in the listener series).
 *
 * The listener series moves Spotify to an EVENT-DRIVEN primary source: the
 * dealer websocket receives cluster (playback state) pushes for every device
 * on the account, no Web API polling required. Polling stays only as a
 * fallback lane (task #119 demoted it to a quota-safe cadence). This module
 * is the belt-and-braces safety net for the fallback: even if the fallback
 * mis-estimates and polls too much, we MUST NOT let Spotify's daily quota
 * ring bring the app to a 24-hour ban.
 *
 * The counter records EVERY outbound call to `api.spotify.com` (Web API) AND
 * `accounts.spotify.com` (token endpoint), the two sources Spotify charges
 * against the app's daily quota. The listener's dealer websocket traffic does
 * NOT hit either host and is not counted here (dealer + connect-state edges
 * are not the Web API).
 *
 * Window rollover: the counter is keyed by the current window's start moment
 * in UTC. The reset is a configurable UTC time-of-day (secrets key
 * `spotify_budget_reset_utc`, default "21:23" - the observed quota reset for
 * this app). At the boundary a new counter key comes into scope naturally
 * (no explicit reset needed); TTL is set past the next boundary so the old
 * counter drops on its own.
 *
 * Redis degrade: any Redis failure falls back to counting in process memory
 * for the remainder of the process's lifetime for that window - never to
 * BLOCKING the feature or emitting a 5xx. A single warn log is emitted when
 * the fallback trips; subsequent errors are silent within the window.
 */

import type { RedisClient } from "../upstream/redisClient";

/** Default cap - the observed daily Spotify Web API budget for this app. */
export const DEFAULT_SPOTIFY_DAILY_CALL_BUDGET = 4000;
/** Default reset time-of-day in UTC (HH:MM). Observed empirically. */
export const DEFAULT_SPOTIFY_BUDGET_RESET_UTC = "21:23";
/** How long past the next reset the Redis counter is kept, for slack. */
export const BUDGET_KEY_TTL_SLACK_MS = 60 * 60 * 1000;

/**
 * Curated budget snapshot for the status endpoint. `used` and `cap` are
 * plain integers; `resets_at` is the wall-clock ISO 8601 of the NEXT reset
 * (in UTC).
 */
export interface BudgetState {
  used: number;
  cap: number;
  resets_at: string;
}

/**
 * The public interface a caller (spotifyService) uses. `noteCall` MUST be
 * invoked before every outbound Web API / token call; `getState` is a cheap
 * read the status endpoint invokes.
 */
export interface ApiBudget {
  /**
   * Record one outbound Spotify call. Returns the new used count and whether
   * the cap has been reached. The FIRST call in each window that reaches the
   * cap fires `onCapReached(nextResetAtMs)` exactly once.
   */
  noteCall(now?: number): Promise<{ used: number; capReached: boolean }>;
  /**
   * Best-effort snapshot for the status endpoint. Reads Redis when available
   * and falls back to the in-process counter on any error. Never throws.
   */
  getState(now?: number): Promise<BudgetState>;
  /**
   * True iff the local mirror shows the cap has been reached this window.
   * Cheap synchronous check, useful for the fetcher's short-circuit.
   */
  isExhausted(now?: number): boolean;
  /** Test-only: clear process-local state. */
  _resetForTests(): void;
}

export interface ApiBudgetConfig {
  /**
   * Shared Redis client (may be null when Redis is unwired - local dev, CI,
   * tests). When null the counter lives in process memory only, which is
   * exactly the degraded behavior a Redis outage triggers on the shared
   * path.
   */
  redis: RedisClient | null;
  /** Environment prefix - keeps prod and dev counters from colliding. */
  env: string;
  /** Daily cap. Values <= 0 disable enforcement (used=capReached forever). */
  cap: number;
  /** Reset hour (0-23) in UTC. Out-of-range values clamp. */
  resetHour: number;
  /** Reset minute (0-59) in UTC. Out-of-range values clamp. */
  resetMinute: number;
  /**
   * Called exactly once per window when the counter first reaches `cap`.
   * Receives the wall-clock (ms since epoch) of the NEXT reset so the
   * caller can persist a shared "budget" suspension record with a real
   * deadline. Exceptions are logged and swallowed.
   */
  onCapReached?: (nextResetAtMs: number) => void;
}

/** Parsed representation of a "HH:MM" reset-time string. */
export interface ParsedResetTime {
  hour: number;
  minute: number;
}

/**
 * Parse the "HH:MM" secrets value. Returns null on any shape mismatch so the
 * caller can fall back to the compiled-in default (rather than silently
 * mis-configuring the reset time).
 */
export function parseResetTime(raw: string | undefined | null): ParsedResetTime | null {
  if (raw == null) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Compute the current budget window for `now`. The window "starts" at the
 * most recent occurrence of the reset time-of-day and ends 24h later. The
 * `windowId` encodes the start moment so the counter key is naturally
 * distinct across windows and no explicit reset step is required.
 */
export function computeWindowBoundaries(
  now: number,
  reset: ParsedResetTime
): { startMs: number; nextResetMs: number; windowId: string } {
  const d = new Date(now);
  const todayResetMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    reset.hour,
    reset.minute,
    0,
    0
  );
  const startMs =
    now >= todayResetMs
      ? todayResetMs
      : todayResetMs - 24 * 60 * 60 * 1000;
  const nextResetMs = startMs + 24 * 60 * 60 * 1000;
  const startDate = new Date(startMs);
  const windowId = formatWindowId(startDate);
  return { startMs, nextResetMs, windowId };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatWindowId(d: Date): string {
  return (
    `${d.getUTCFullYear()}` +
    `${pad2(d.getUTCMonth() + 1)}` +
    `${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`
  );
}

/** Redis key for the counter in a given window. */
export function budgetCounterKey(env: string, windowId: string): string {
  return `portfolio-v6-api:${env}:spotify-budget:${windowId}`;
}

/**
 * Build the budget guard. Kept as a factory so each ApiBudget instance keeps
 * its own process-local counter (tests inject fakes; production installs one
 * per boot).
 */
export function createApiBudget(config: ApiBudgetConfig): ApiBudget {
  const reset: ParsedResetTime = {
    hour: clamp(config.resetHour, 0, 23),
    minute: clamp(config.resetMinute, 0, 59),
  };
  const cap = Math.max(0, config.cap | 0);

  // Process-local counter, keyed by windowId so a natural rollover starts a
  // fresh count without an explicit reset call. Serves as the source of truth
  // when Redis is unwired or degraded.
  let processCounter: { windowId: string; used: number } = {
    windowId: "",
    used: 0,
  };
  // A one-shot flag per window so the onCapReached callback fires exactly
  // once per rollover, even if noteCall keeps being invoked afterwards.
  let capFiredFor: string | null = null;
  // Track whether we've already warned about Redis this process - keeps the
  // log tidy under a sustained outage.
  let redisDegradedLogged = false;

  function ensureWindow(windowId: string): void {
    if (processCounter.windowId !== windowId) {
      processCounter = { windowId, used: 0 };
      capFiredFor = null;
    }
  }

  function maybeFireCap(windowId: string, nextResetMs: number): void {
    if (capFiredFor === windowId) return;
    capFiredFor = windowId;
    try {
      config.onCapReached?.(nextResetMs);
    } catch (err) {
      console.error(
        "[apiBudget] onCapReached callback threw:",
        err instanceof Error ? err.message : err
      );
    }
  }

  async function noteCall(
    nowArg?: number
  ): Promise<{ used: number; capReached: boolean }> {
    const now = nowArg ?? Date.now();
    const w = computeWindowBoundaries(now, reset);
    ensureWindow(w.windowId);

    let used = processCounter.used;

    if (config.redis) {
      const key = budgetCounterKey(config.env, w.windowId);
      try {
        used = await config.redis.incr(key);
        // Renew the TTL so the counter dies naturally past the next reset.
        // pExpire on every INCR is cheap and safe; a 429/refresh burst that
        // races the SET does not corrupt anything.
        const ttlMs = Math.max(
          w.nextResetMs - now + BUDGET_KEY_TTL_SLACK_MS,
          60_000
        );
        // pExpire itself may fail; if the INCR succeeded we still count it.
        try {
          await config.redis.pExpire(key, ttlMs);
        } catch (err) {
          logRedisDegrade(err);
        }
        processCounter.used = Math.max(processCounter.used, used);
      } catch (err) {
        logRedisDegrade(err);
        processCounter.used += 1;
        used = processCounter.used;
      }
    } else {
      processCounter.used += 1;
      used = processCounter.used;
    }

    const capReached = cap > 0 && used >= cap;
    if (capReached) {
      maybeFireCap(w.windowId, w.nextResetMs);
    }

    return { used, capReached };
  }

  async function getState(nowArg?: number): Promise<BudgetState> {
    const now = nowArg ?? Date.now();
    const w = computeWindowBoundaries(now, reset);
    ensureWindow(w.windowId);

    let used = processCounter.used;
    if (config.redis) {
      const key = budgetCounterKey(config.env, w.windowId);
      try {
        const raw = await config.redis.get(key);
        if (raw != null) {
          const parsed = Number.parseInt(raw, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            used = Math.max(used, parsed);
            processCounter.used = used;
          }
        }
      } catch (err) {
        // Fail open: the in-process mirror is the fallback. No log here -
        // we may see many status polls, and noteCall already logs.
        void err;
      }
    }

    return {
      used,
      cap,
      resets_at: new Date(w.nextResetMs).toISOString(),
    };
  }

  function isExhausted(nowArg?: number): boolean {
    const now = nowArg ?? Date.now();
    const w = computeWindowBoundaries(now, reset);
    if (processCounter.windowId !== w.windowId) return false;
    return cap > 0 && processCounter.used >= cap;
  }

  function _resetForTests(): void {
    processCounter = { windowId: "", used: 0 };
    capFiredFor = null;
    redisDegradedLogged = false;
  }

  function logRedisDegrade(err: unknown): void {
    if (redisDegradedLogged) return;
    redisDegradedLogged = true;
    console.warn(
      "[apiBudget] Redis error - falling back to in-process counting:",
      err instanceof Error ? err.message : err
    );
  }

  return { noteCall, getState, isExhausted, _resetForTests };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
