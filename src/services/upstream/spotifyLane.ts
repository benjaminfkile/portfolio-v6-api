/**
 * Viewer-aware + auth-aware Spotify lane for the leader poll loop (task #95).
 *
 * Two behaviors, orthogonal to the base tick + the 429 backoff (task #90):
 *
 * 1) AUTH SUSPENSION — when the token refresh returns invalid_grant, or the
 *    service has no stored Spotify credentials, `spotifyService` sets an
 *    in-process suspension flag and stops making Spotify calls. The lane keeps
 *    the leader from re-invoking the fetcher (and, transitively, the token
 *    endpoint) at all until the stored `service_tokens.updated_at` changes.
 *    Resume is polled locally at most once per `SPOTIFY_AUTH_RESUME_CHECK_MS`
 *    (default 60s) — a cheap DB read, never a Spotify call. On change the
 *    lane clears the suspension AND polls immediately so the first viewer
 *    after reconnect gets fresh data within a tick.
 *
 * 2) VIEWER-AWARE CADENCE — a portfolio has near-zero viewers most of the day,
 *    so polling Spotify every 5s around the clock is almost pure waste. The
 *    lane considers the site "active" if either:
 *      - the gateway presence owner API reports count > 0 on the
 *        `{service}:now-playing` channel (cached ≤ 30s; presence-API failure
 *        is treated as ACTIVE — a gateway hiccup must never disable the
 *        feature, per the task's "fail open" rule), OR
 *      - a public `GET /api/now-playing` request has landed on any instance
 *        in the last `SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS` (default 5min;
 *        Redis snapshot store, covers the polling-fallback path).
 *    While active: the lane polls every tick at the base cadence. While idle:
 *    it polls at most once per `spotifyIdleIntervalMs` (default 5min). On the
 *    idle → active transition the lane forces an immediate poll so a new
 *    viewer never sees stale data waiting for the idle deadline to elapse.
 *
 * Everything OTHER than the Spotify lane (status/duolingo/github) is unchanged
 * — the lane returns a single decision (`fetch` / `skip`) for the now-playing
 * fetcher only, and the poll loop routes the other lanes on their own cadence.
 */

/** How often the lane rechecks `service_tokens.updated_at` while suspended. */
export const SPOTIFY_AUTH_RESUME_CHECK_MS = 60 * 1000;

/** How often the lane polls the gateway presence API (cache TTL). */
export const SPOTIFY_PRESENCE_CACHE_MS = 30 * 1000;

/**
 * How long a public `GET /api/now-playing` request counts as "recent activity"
 * for the viewer-aware cadence — covers the client's polling fallback and any
 * user still watching a stale snapshot after the realtime channel dropped.
 */
export const SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS = 5 * 60 * 1000;

/** Default idle cadence — one poll per 5 minutes when no viewer is around. */
export const DEFAULT_SPOTIFY_IDLE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Dependencies the lane needs from the outside world. Every one is optional
 * (falsy is treated as "signal absent"), so a test can inject only what it
 * cares about and the production wiring never has to build stubs for the rest.
 */
export interface SpotifyLaneDeps {
  /**
   * Is Spotify currently auth-suspended in-process? (spotifyService.isSpotifyAuthSuspended)
   */
  isAuthSuspended(): boolean;
  /**
   * Cheap DB read for the current `service_tokens.updated_at` value for
   * spotify. Called at most once per `SPOTIFY_AUTH_RESUME_CHECK_MS`; return
   * `null` on absence or error (treated as "no change").
   */
  getStoredTokenUpdatedAt(): Promise<Date | null>;
  /**
   * Clear the auth suspension flag (spotifyService.resumeSpotifyAuth). Fires
   * exactly once per resume transition.
   */
  resumeAuth(): void;
  /**
   * Gateway presence owner API — return the current count of active clients on
   * the `{service}:now-playing` channel. On presence-API failure this MUST
   * throw / reject so the lane treats the tick as active (fail open).
   */
  getPresenceCount(): Promise<number>;
  /**
   * Most recent `Date` any instance served `GET /api/now-playing`. `null` when
   * no such request has landed this window or Redis errored (treated as "no
   * recent activity" — the presence check is what keeps the feature alive).
   */
  getLastPublicRequestAt(): Promise<Date | null>;
}

/** Runtime knobs — kept small so tests can override any subset. */
export interface SpotifyLaneConfig {
  /** How long a public request counts as recent activity. */
  publicRequestWindowMs: number;
  /** How long a presence read is cached before the next call. */
  presenceCacheMs: number;
  /** How often the lane rechecks `service_tokens.updated_at` while suspended. */
  authResumeCheckMs: number;
  /**
   * How often the lane polls Spotify while the site is idle (no viewers). The
   * fast cadence is the base poll interval — always every tick when active.
   */
  idleIntervalMs: number;
}

/** Per-tick decision: fetch now, or skip this tick (idle / suspended). */
export type SpotifyLaneDecision = "fetch" | "skip-idle" | "skip-suspended";

export interface SpotifyLane {
  /**
   * Decide what to do THIS tick. Callers pass `now` (ms since epoch) so the
   * decision is deterministic under fake timers.
   */
  planTick(now: number): Promise<SpotifyLaneDecision>;
  /** True iff the site is currently considered active. Exposed for tests. */
  isActive(now: number): Promise<boolean>;
}

/**
 * Build the lane. Kept as a factory so tests can inject fakes and every piece
 * of module state (last presence check, last poll time, previously-active
 * flag, suspended-at snapshot) is per-instance rather than shared.
 */
export function createSpotifyLane(
  deps: SpotifyLaneDeps,
  config: SpotifyLaneConfig
): SpotifyLane {
  // Presence cache — populated lazily on first check; refreshed after TTL.
  let cachedPresence: { active: boolean; expiresAt: number } | null = null;

  // Resume detection state — the snapshot of `updated_at` at the moment we
  // FIRST observed suspension, plus a throttle on the DB read itself.
  let suspendedSnapshot: Date | null | undefined = undefined; // undefined = "not yet captured"
  let lastResumeCheckAt = 0;

  // Cadence state: when the next Spotify poll is due (0 = fetch this tick),
  // and whether the site was active on the previous tick (for the idle →
  // active transition that forces an immediate fetch).
  let nextDueAt = 0;
  let wasActive = false;

  async function checkActive(now: number): Promise<boolean> {
    // 1) Recent-public-request signal — cheap Redis read; either it landed in
    //    the window or it didn't. A Redis blip returns null → treated as "no
    //    recent request" and we fall through to the presence check.
    const last = await deps.getLastPublicRequestAt();
    if (last && now - last.getTime() <= config.publicRequestWindowMs) {
      return true;
    }

    // 2) Presence signal — cached to at most one gateway call per
    //    `presenceCacheMs`. On presence-API failure we FAIL OPEN so a gateway
    //    hiccup never disables the fast lane.
    if (cachedPresence && cachedPresence.expiresAt > now) {
      return cachedPresence.active;
    }
    let active: boolean;
    try {
      const count = await deps.getPresenceCount();
      active = count > 0;
    } catch {
      // Fail open — task spec: "treat presence-API failure as active".
      active = true;
    }
    cachedPresence = {
      active,
      expiresAt: now + config.presenceCacheMs,
    };
    return active;
  }

  async function planTick(now: number): Promise<SpotifyLaneDecision> {
    if (deps.isAuthSuspended()) {
      // Only recheck the stored token at most once per `authResumeCheckMs`.
      // Failed-auth traffic still costs against Spotify's daily quota under
      // one client id, so we must NOT let the resume-check timer become a
      // spinner that hammers anything.
      if (suspendedSnapshot === undefined) {
        // First tick we observe suspension — take the reference snapshot and
        // arm the throttle so the next real recheck happens after the delay.
        suspendedSnapshot = await deps.getStoredTokenUpdatedAt();
        lastResumeCheckAt = now;
        return "skip-suspended";
      }
      if (now - lastResumeCheckAt < config.authResumeCheckMs) {
        return "skip-suspended";
      }
      lastResumeCheckAt = now;
      const current = await deps.getStoredTokenUpdatedAt();
      const changed =
        (current === null) !== (suspendedSnapshot === null) ||
        (current !== null &&
          suspendedSnapshot !== null &&
          current.getTime() !== suspendedSnapshot.getTime());
      if (!changed) {
        return "skip-suspended";
      }
      // Row updated — the admin reconnected (or replaced the token). Clear the
      // suspension AND poll immediately so the first viewer after reconnect
      // gets fresh data within one tick, not one idle interval.
      deps.resumeAuth();
      suspendedSnapshot = undefined;
      wasActive = false;
      nextDueAt = 0;
      return "fetch";
    }

    // Not suspended — clear the resume snapshot so a fresh suspension later
    // captures a new reference.
    suspendedSnapshot = undefined;

    const active = await checkActive(now);
    const idleToActive = active && !wasActive;
    wasActive = active;

    if (active) {
      // While active the lane polls every tick at the base cadence — nextDueAt
      // is only meaningful across idle windows.
      nextDueAt = 0;
      return "fetch";
    }

    // Idle path.
    if (idleToActive) {
      // Should not happen (active would be true), but keep the invariant.
      nextDueAt = 0;
      return "fetch";
    }
    if (now >= nextDueAt) {
      nextDueAt = now + config.idleIntervalMs;
      return "fetch";
    }
    return "skip-idle";
  }

  return {
    planTick,
    isActive: checkActive,
  };
}
