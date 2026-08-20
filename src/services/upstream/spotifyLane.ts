/**
 * Viewer-aware + auth-aware Spotify lane for the leader poll loop.
 *
 * Task #95 introduced this lane. Task #96 promoted the suspension state from
 * per-process memory to a shared Redis record so ALL instances see the same
 * "Spotify is currently suspended" fact and a newly-elected / restarted leader
 * never re-trips Spotify to rediscover a known suspension. Task #97 inverted
 * authority so the shared record is the SINGLE source of truth: process-local
 * backoff / auth flags are only a mirror of it. Two consequences that fix the
 * bug the operator override could not defeat:
 *   - When the shared record is absent, the lane clears its local mirror
 *     (both auth suspension AND the task #90 429 backoff window). Otherwise
 *     the fetcher wrapper short-circuits on stale in-memory backoff and no
 *     genuine Spotify call ever happens to re-verify the suspension.
 *   - The lane only writes the shared record after a genuine fetch attempt
 *     tripped locally — never on skip-suspended ticks (`reconcileAfterFetch`
 *     is invoked by the poll loop ONLY on `"fetch"` decisions). Deleting the
 *     key stays deleted until a real new trip occurs; a fresh trip records
 *     a NEW deadline.
 *
 * Behaviors, orthogonal to the base tick + 429 backoff (task #90):
 *
 * 1) SHARED SUSPENSION — before any local logic, the lane reads the
 *    `now-playing:suspension` Redis record. Any leader observing an active
 *    record (its `suspended_until` in the future) mirrors it into local state
 *    (so the HTTP request-path fallback also honors it under a Redis outage)
 *    and skips the tick. Deleting the key is the operator override; the lane
 *    then clears local state and attempts the next fetch. All suspension
 *    entries carry their deadline so recovery is automatic even when nobody
 *    intervenes.
 *
 * 2) AUTH SUSPENSION — when the token refresh returns invalid_grant (or the
 *    service has no stored Spotify credentials), `spotifyService` sets its own
 *    in-process suspension flag and the leader's reconciler writes an "auth"
 *    entry into the shared record. Resume detection is unchanged: the lane
 *    reads `service_tokens.updated_at` at most once per
 *    `authResumeCheckMs` (default 60s) — a cheap DB read, never a Spotify
 *    call. On a change the lane clears the shared record, resumes locally,
 *    AND forces an immediate poll so the first viewer after reconnect gets
 *    fresh data within a tick. The `captured_token_updated_at` field lives in
 *    the shared record so a fresh leader compares its DB read against the
 *    value at trip-time, not against its own first observation.
 *
 * 3) VIEWER-AWARE CADENCE + PREDICTIVE POLLING (task #119) - the polling
 *    lane is a quota-safe FALLBACK, not a primary source (the connect-listener
 *    from task series #115-#123 is primary). The fixed every-tick fast cadence
 *    is REMOVED; every fetch is either predictively scheduled based on the
 *    currently-playing track's remaining playback time or throttled by the
 *    idle interval.
 *
 *    The lane considers the site "active" if either:
 *      - the gateway presence owner API reports count > 0 on the
 *        `{service}:now-playing` channel (cached at most 30s; presence-API
 *        failure is treated as ACTIVE, a gateway hiccup must never disable
 *        the feature per the task's "fail open" rule), OR
 *      - a public `GET /api/now-playing` request has landed on any instance
 *        in the last `SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS` (default 5min;
 *        Redis snapshot store, covers the polling-fallback path).
 *
 *    Cadence rules:
 *      - Idle (no viewers): fetch at most once per `spotifyIdleIntervalMs`
 *        (default 5min).
 *      - Active AND playing (per the last observed payload): schedule the
 *        next fetch at (track end + 2s), clamped to
 *        [`SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS`, `spotifyIdleIntervalMs`],
 *        then capped at `SPOTIFY_DRIFT_CHECK_MS` (60s) so long tracks still
 *        get one drift-check per minute. Formula:
 *          next = min(SPOTIFY_DRIFT_CHECK_MS,
 *                     clamp(remaining_ms + 2000,
 *                           SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS,
 *                           idleIntervalMs))
 *        Averaged across a minute of playback this is at most about 2
 *        Spotify Web API calls per minute.
 *      - Active AND not playing: fetch at most once per
 *        `SPOTIFY_DRIFT_CHECK_MS` (60s) so a newly-started track surfaces
 *        within a minute without spamming the Web API when nothing changed.
 *      - On the idle to active transition the lane forces an immediate poll
 *        so a new viewer never waits for the previous deadline to elapse.
 *
 *    The predictive schedule is set post-fetch by `reconcileAfterFetch(now,
 *    payload)` - the poll loop passes the freshly-fetched now-playing
 *    payload so the lane can read `track.progress_ms` and `track.duration_ms`
 *    and pin the next tick. When the fetcher returned no payload (short-
 *    circuit skip / upstream error) the lane keeps the conservative default
 *    set in `planTick`, which caps the retry at `SPOTIFY_DRIFT_CHECK_MS`
 *    while active and `idleIntervalMs` while idle.
 *
 * Everything OTHER than the Spotify lane (status/duolingo/github) is
 * unchanged — the lane returns a single decision (`fetch` / `skip`) for the
 * now-playing fetcher only, and the poll loop routes the other lanes on
 * their own cadence.
 */

import type {
  SpotifyHealthRecord,
  SpotifySuspensionRecord,
} from "./snapshotStore";

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
 * Task #119 - predictive cadence tuning. `SPOTIFY_TRACK_END_MARGIN_MS` is the
 * safety margin added to (duration_ms - progress_ms) so the follow-up fetch
 * lands JUST after a track ends rather than racing the transition.
 * `SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS` is the floor - even a track with 3
 * seconds remaining will not trigger a fetch sooner than this, so a burst of
 * short outros cannot push the polling rate above ~4 calls per minute.
 * `SPOTIFY_DRIFT_CHECK_MS` is the ceiling for the interval between fetches
 * while a track is playing - long tracks still get one drift-check per
 * minute, which catches a user skipping / pausing / switching devices
 * without spamming the Web API when nothing has changed.
 */
export const SPOTIFY_TRACK_END_MARGIN_MS = 2_000;
export const SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS = 15 * 1000;
export const SPOTIFY_DRIFT_CHECK_MS = 60 * 1000;

/**
 * Deadline placeholder for auth suspensions. Auth doesn't have a natural
 * time-based deadline — recovery is either the admin-reconnect updated_at
 * check or the operator deleting the key. We still stamp a far-future
 * deadline so the record has a well-defined TTL and the "all suspensions
 * carry a deadline" invariant holds; the leader rewrites the record each
 * tick to keep it fresh.
 */
export const SPOTIFY_AUTH_SUSPENSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Dependencies the lane needs from the outside world. Every one is optional
 * (falsy is treated as "signal absent"), so a test can inject only what it
 * cares about and the production wiring never has to build stubs for the rest.
 */
export interface SpotifyLaneDeps {
  /**
   * Is Spotify explicitly disabled by the admin? (task #113 —
   * serviceSettingsStore.isSpotifyDisabled). When true the lane makes ZERO
   * Spotify calls regardless of every other signal (grant present or not,
   * viewer count, backoff state). Checked FIRST on every tick so a disable
   * flip takes effect within one tick and no post-disable Spotify traffic
   * can leak. Read is DB-cheap; a read failure is treated as "not disabled"
   * (fail open — a DB blip must never disable a working integration).
   */
  isDisabled(): Promise<boolean>;
  /**
   * Is Spotify currently auth-suspended in-process? (spotifyService.isSpotifyAuthSuspended)
   */
  isAuthSuspended(): boolean;
  /**
   * The wall-clock (ms since epoch) the current in-process 429 backoff clears
   * at, or 0 if not in backoff. (spotifyService.getSpotifyBackoffUntilMs)
   */
  getBackoffUntilMs(): number;
  /**
   * Mirror an inherited auth suspension into the process (no-op if already
   * suspended). Called on a fresh leader that observes an "auth" record in
   * the shared store. (spotifyService.suspendSpotifyAuth)
   */
  applyAuthSuspension(reason: string): void;
  /**
   * Mirror an inherited 429 backoff into the process without incrementing
   * the exponential streak. Called on a fresh leader that observes a "429"
   * record in the shared store. (spotifyService.applySpotifyBackoffUntil)
   */
  applyBackoffUntil(untilMs: number): void;
  /**
   * Clear the in-process 429 backoff mirror (task #97). Called when the
   * shared record is absent — Redis is authoritative, so a deleted key
   * clears local memory too. (spotifyService.clearSpotifyBackoff)
   */
  clearBackoff(): void;
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
  /**
   * Read the shared Spotify suspension record from Redis. `null` when the key
   * is absent or Redis errored (treated as "no suspension" — the whole point
   * is fail open, and the local backoff still gates the fetcher).
   */
  readSharedSuspension(): Promise<SpotifySuspensionRecord | null>;
  /** Persist / overwrite the shared Spotify suspension record. */
  writeSharedSuspension(record: SpotifySuspensionRecord): Promise<void>;
  /** Delete the shared Spotify suspension record (natural recovery / override). */
  clearSharedSuspension(): Promise<void>;
  /**
   * Snapshot the process-local health mirror (task #112). Used by the
   * reconciler to flush what the fetcher just observed into the shared
   * health record so any instance / the truthful status contract
   * (task 113, 2/2) sees the same truth.
   */
  readLocalHealth(): SpotifyHealthRecord;
  /**
   * Read the shared health record — used by a freshly-elected leader on
   * its first tick so it inherits what the previous leader observed instead
   * of starting blank.
   */
  readSharedHealth(): Promise<SpotifyHealthRecord | null>;
  /** Persist / overwrite the shared health record. */
  writeSharedHealth(record: SpotifyHealthRecord): Promise<void>;
  /**
   * Merge a shared health record into the process-local mirror. Called
   * exactly once, on the fresh leader's first tick.
   */
  applyHealthMirror(record: SpotifyHealthRecord): void;
  /**
   * True iff the connect-listener (task series #115-#123) is currently
   * `connected`, meaning the dealer websocket is holding the primary
   * now-playing source. When true the lane MUST return
   * `skip-listener-active` so the polling lane does not fetch redundantly.
   * Optional so the pre-#118 wiring (no listener) works unchanged; when
   * absent the lane behaves exactly as it did before.
   */
  isListenerConnected?: () => boolean;
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
   * How often the lane polls Spotify while the site is idle (no viewers), and
   * the ceiling clamp on the predictive schedule while active (task #119).
   * The fixed every-tick fast cadence is gone; while active the lane instead
   * schedules the next fetch at (track end + 2s), clamped to
   * [`SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS`, `idleIntervalMs`], then capped at
   * `SPOTIFY_DRIFT_CHECK_MS` so long tracks still get a drift check per
   * minute. See the module header for the full formula.
   */
  idleIntervalMs: number;
}

/**
 * Per-tick decision: fetch now, or skip this tick.
 *
 * `skip-listener-active` (task #118) means the connect-listener owns the
 * primary now-playing source right now: the polling lane MUST NOT fetch,
 * because it would burn Spotify Web API quota redundantly. Every other
 * listener state (idle / connecting / backoff / credential_dead) leaves the
 * polling lane free to operate under the existing suspension / viewer-aware
 * / 429-backoff rules.
 */
export type SpotifyLaneDecision =
  | "fetch"
  | "skip-idle"
  | "skip-suspended"
  | "skip-listener-active";

export interface SpotifyLane {
  /**
   * Decide what to do THIS tick. Callers pass `now` (ms since epoch) so the
   * decision is deterministic under fake timers.
   */
  planTick(now: number): Promise<SpotifyLaneDecision>;
  /** True iff the site is currently considered active. Exposed for tests. */
  isActive(now: number): Promise<boolean>;
  /**
   * Reconcile the local suspension state (spotifyService's in-process flags)
   * with the shared Redis record AFTER a fetch attempt. Called by the poll
   * loop with `now = Date.now()` ONLY when `planTick` returned `"fetch"`
   * (task #97) - that guarantees any local suspension observed here is a
   * genuine fresh trip from THIS tick's fetch, not stale in-memory state
   * carried over from an earlier tick, so the shared record's `suspended_until`
   * carries a real deadline and a deleted key can never resurrect from memory.
   *
   * Task #119 - `payload` is the now-playing payload the fetcher returned
   * this tick (or `null` when the fetcher was short-circuited by a suspension
   * / rate-limit / upstream error). When the payload carries a playing track
   * the lane pins `nextDueAt` to the predicted track end + 2s (clamped),
   * driving the predictive cadence documented in the module header. Passing
   * `null` (or omitting the argument) keeps the conservative default set in
   * `planTick`.
   */
  reconcileAfterFetch(now: number, payload?: unknown): Promise<void>;
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
  // FIRST observed suspension, plus a throttle on the DB read itself. When
  // the shared record carries `captured_token_updated_at`, it becomes the
  // canonical snapshot on first observation — that lets a fresh leader
  // detect an admin reconnect that happened before it took over.
  let suspendedSnapshot: Date | null | undefined = undefined;
  let lastResumeCheckAt = 0;

  // Cadence state: when the next Spotify poll is due (0 = fetch this tick),
  // and whether the site was active on the previous tick (for the idle →
  // active transition that forces an immediate fetch).
  let nextDueAt = 0;
  let wasActive = false;

  // Task #112 — one-time health inheritance: on the very first tick, a fresh
  // leader loads the shared health record into its in-memory mirror so it
  // does not surface "unknown" to the status endpoint before observing its
  // own first fetch. Subsequent ticks only WRITE the mirror out.
  let inheritedHealth = false;

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

  function suspensionActive(
    record: SpotifySuspensionRecord | null,
    now: number
  ): boolean {
    if (!record) return false;
    const deadline = Date.parse(record.suspended_until);
    return Number.isFinite(deadline) && deadline > now;
  }

  /**
   * Extract playback timing from an opaque now-playing payload. Returns
   * `"playing"` with the remaining track time (never negative), `"idle"` when
   * the payload is a valid non-playing shape, or `"unknown"` when the shape
   * is not recognizable (e.g. the fetcher returned a status payload by
   * mistake). "unknown" is treated the same as null in the caller - we keep
   * whatever nextDueAt planTick set.
   */
  function extractTrackTiming(
    payload: unknown
  ):
    | { kind: "playing"; remainingMs: number }
    | { kind: "idle" }
    | { kind: "unknown" } {
    if (!payload || typeof payload !== "object") return { kind: "unknown" };
    const p = payload as Record<string, unknown>;
    if (p.playing === false) return { kind: "idle" };
    if (p.playing !== true) return { kind: "unknown" };
    const track = p.track;
    if (!track || typeof track !== "object") return { kind: "unknown" };
    const t = track as Record<string, unknown>;
    const progress = typeof t.progress_ms === "number" ? t.progress_ms : 0;
    const duration = typeof t.duration_ms === "number" ? t.duration_ms : 0;
    const remaining = Math.max(0, duration - progress);
    return { kind: "playing", remainingMs: remaining };
  }

  async function planTick(now: number): Promise<SpotifyLaneDecision> {
    // Task #113 — the admin disable flag is checked FIRST, before health
    // inheritance, before shared suspension, before anything else. A disabled
    // Spotify integration must make ZERO calls anywhere (no token endpoint,
    // no health inherit which is Redis-only anyway, no presence). A read
    // failure is treated as "not disabled" (fail open — a DB blip must never
    // disable a working integration).
    const disabled = await deps.isDisabled().catch(() => false);
    if (disabled) {
      return "skip-suspended";
    }

    // Task #118 — while the connect-listener holds the dealer socket
    // (`connected`), the polling lane MUST NOT fetch: the listener is the
    // primary now-playing source and every event flows into the shared
    // snapshot directly, so any Spotify Web API call here would be pure
    // redundant quota burn. Every other listener state (idle / connecting /
    // backoff / credential_dead) leaves the polling fallback free to run
    // under the usual suspension / viewer-aware rules below.
    if (deps.isListenerConnected && deps.isListenerConnected()) {
      return "skip-listener-active";
    }

    // Task #112 — one-time inherit of the shared health record into the
    // local mirror so a freshly-elected leader answers "unknown" for exactly
    // one tick, not indefinitely. Failure to read is treated as "nothing to
    // inherit" — the mirror stays at its process defaults.
    if (!inheritedHealth) {
      inheritedHealth = true;
      const priorHealth = await deps.readSharedHealth().catch(() => null);
      if (priorHealth) {
        deps.applyHealthMirror(priorHealth);
      }
    }

    // 1) SHARED SUSPENSION — Redis is the source of truth for whether the
    //    leader should fetch. This subsumes both 429 and auth suspensions and
    //    guarantees that a freshly-elected leader honors a known suspension
    //    without ever calling Spotify.
    const shared = await deps.readSharedSuspension();
    const sharedActive = suspensionActive(shared, now);

    if (sharedActive && shared) {
      // Mirror the record into local state so the HTTP request-path fallback
      // (Redis outage) also honors it. Idempotent — the underlying setters
      // no-op when already suspended / when the deadline is already covered.
      if (shared.reason === "auth" && !deps.isAuthSuspended()) {
        deps.applyAuthSuspension(shared.detail ?? "shared suspension");
      }
      if (shared.reason === "429") {
        const untilMs = Date.parse(shared.suspended_until);
        if (Number.isFinite(untilMs)) {
          deps.applyBackoffUntil(untilMs);
        }
      }

      // Auth suspensions get the resume-check treatment — the admin's
      // reconnect is what shortens the window. `captured_token_updated_at`
      // in the shared record is the canonical trip-time snapshot, so a fresh
      // leader that missed the trip can still detect a reconnect.
      if (shared.reason === "auth") {
        if (suspendedSnapshot === undefined) {
          if (shared.captured_token_updated_at !== undefined) {
            suspendedSnapshot = shared.captured_token_updated_at
              ? new Date(shared.captured_token_updated_at)
              : null;
          } else {
            suspendedSnapshot = await deps.getStoredTokenUpdatedAt();
          }
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
        // Row updated — the admin reconnected. Clear shared + local state
        // AND force an immediate poll so the first viewer after reconnect
        // gets fresh data within one tick, not one idle interval.
        deps.resumeAuth();
        await deps.clearSharedSuspension();
        suspendedSnapshot = undefined;
        wasActive = false;
        nextDueAt = 0;
        return "fetch";
      }

      // Non-auth (429 backoff): just wait for the deadline to elapse.
      return "skip-suspended";
    }

    // 2) Not suspended per Redis. If local state was suspended, reconcile.
    //    This covers BOTH the natural-expiry case (Redis TTL dropped the key)
    //    and the operator-override case (someone ran DEL on the key). Task
    //    #97: the local 429 backoff is ALSO a mirror of the shared record —
    //    clear it too so the fetcher wrapper doesn't short-circuit on stale
    //    in-memory state and prevent a real Spotify call from happening.
    if (deps.isAuthSuspended()) {
      deps.resumeAuth();
      wasActive = false;
      nextDueAt = 0;
    }
    if (deps.getBackoffUntilMs() > 0) {
      deps.clearBackoff();
    }
    // Drop the resume snapshot so a NEW suspension later captures a fresh
    // reference.
    suspendedSnapshot = undefined;

    // 3) Viewer-aware cadence + predictive polling (task #119).
    //    The fixed every-tick fast lane is gone: every fetch is scheduled by
    //    `nextDueAt`, which is either the idle interval floor (no viewers) or
    //    the predicted track-end + 2s (viewers + playing) or the drift-check
    //    ceiling (viewers + not playing / unknown). `reconcileAfterFetch`
    //    tightens nextDueAt post-fetch when it can extract playback timing
    //    from the payload.
    const active = await checkActive(now);
    const idleToActive = active && !wasActive;
    wasActive = active;

    // Idle to active: force an immediate poll so a fresh viewer never waits
    // out the previous deadline. Even a still-valid predictive nextDueAt is
    // dropped here - the viewer's arrival is worth a re-check.
    if (idleToActive) {
      nextDueAt = 0;
    }

    if (now < nextDueAt) {
      return "skip-idle";
    }

    // Time to fetch. Set a conservative default so a fetcher that never
    // triggers a payload-based reconcile (short-circuit skip, upstream
    // error) still gets a sane pause before the next attempt: the drift-
    // check ceiling while active, the idle interval while idle.
    // reconcileAfterFetch may replace this once the payload lands.
    nextDueAt = now + (active
      ? Math.min(SPOTIFY_DRIFT_CHECK_MS, config.idleIntervalMs)
      : config.idleIntervalMs);
    return "fetch";
  }

  async function reconcileAfterFetch(
    now: number,
    payload?: unknown
  ): Promise<void> {
    // Task #119 - predictive cadence. When the fetcher returned a payload we
    // can pin nextDueAt precisely: playing tracks schedule to end + 2s
    // (clamped), non-playing payloads schedule the next drift check. When
    // the payload is null / undefined we keep the conservative default that
    // planTick already set. Applied ONLY while the site is active - idle
    // uses the base idle-interval cadence regardless of playback state.
    if (wasActive && payload != null) {
      const timing = extractTrackTiming(payload);
      if (timing.kind === "playing") {
        const clamped = Math.max(
          SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS,
          Math.min(
            config.idleIntervalMs,
            timing.remainingMs + SPOTIFY_TRACK_END_MARGIN_MS
          )
        );
        nextDueAt = now + Math.min(SPOTIFY_DRIFT_CHECK_MS, clamped);
      } else if (timing.kind === "idle") {
        // Active but nothing playing - drift check keeps a fresh track from
        // waiting longer than a minute to surface.
        nextDueAt =
          now + Math.min(SPOTIFY_DRIFT_CHECK_MS, config.idleIntervalMs);
      }
    }

    // Task #112 — always flush the health mirror after a fetch. Whatever the
    // fetcher observed (success / invalid_grant / rate_limited / other) is
    // now the canonical health for this environment; other instances read
    // it via the shared record. Failure is logged and swallowed by
    // writeSharedHealth so a Redis blip cannot fail the poll loop.
    const health = deps.readLocalHealth();
    await deps.writeSharedHealth(health);

    // After the fetcher runs, mirror the resulting local state to Redis so
    // every instance sees the same suspension fact on the next tick.
    const localAuth = deps.isAuthSuspended();
    const backoffUntil = deps.getBackoffUntilMs();
    const localBackoff = backoffUntil > now;

    if (localAuth) {
      const capturedAt = await deps.getStoredTokenUpdatedAt().catch(() => null);
      await deps.writeSharedSuspension({
        suspended_until: new Date(
          now + SPOTIFY_AUTH_SUSPENSION_TTL_MS
        ).toISOString(),
        reason: "auth",
        detail: "invalid_grant on token refresh",
        captured_token_updated_at: capturedAt
          ? capturedAt.toISOString()
          : null,
      });
      return;
    }

    if (localBackoff) {
      await deps.writeSharedSuspension({
        suspended_until: new Date(backoffUntil).toISOString(),
        reason: "429",
        detail: "Spotify 429 backoff",
      });
      return;
    }

    // Neither local flag is set — the fetcher either succeeded or was
    // short-circuited by an already-cleared state. Ensure Redis matches:
    // if a stale suspension record still lingers, drop it.
    const shared = await deps.readSharedSuspension();
    if (shared) {
      await deps.clearSharedSuspension();
    }
  }

  return {
    planTick,
    isActive: checkActive,
    reconcileAfterFetch,
  };
}
