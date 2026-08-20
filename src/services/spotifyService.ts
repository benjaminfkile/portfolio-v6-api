/**
 * Spotify service — TECH_SPEC_V1.md §4.6 (`/api/now-playing`) / task #442.
 *
 * The `now_playing` section needs Spotify's *Get Currently Playing Track*
 * endpoint, which requires a USER-authorized token (`user-read-currently-playing`
 * scope). The API proxies it server-side for the same reasons `/api/status`
 * proxies the gateway (§3.5): the refresh token never leaves the server, the
 * exposed shape is a deliberate curated choice, and a short cache means visitor
 * traffic never multiplies upstream calls (Spotify sees ≤ ~12 req/min regardless
 * — far under its rolling-30s-window rate limit).
 *
 * Runtime flow (§4.6):
 *   - The current ACCESS token is held in memory, exchanged from the refresh
 *     token on first use and refreshed on ~1h expiry OR whenever a call 401s.
 *   - `GET /v1/me/player/currently-playing` returns **204 when nothing is
 *     playing** — a NORMAL response mapped to `{ playing: false }`, not an error.
 *   - ANY upstream failure (timeout, 5xx, auth breakage, bad refresh token) maps
 *     to `{ playing: false }` and logs — it is NEVER surfaced as a 5xx (§3.5).
 *   - No Spotify token, in any form, is ever included in a response — only the
 *     curated shape below is returned.
 */

import { invalidateServiceTokenCache } from "./serviceTokenStore";
import { SPOTIFY_SERVICE_KEY } from "./spotifyTokenStore";

/** Spotify OAuth token endpoint (refresh-token exchange, §4.6). */
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
/** Spotify "currently playing" endpoint (§4.6). */
export const SPOTIFY_NOW_PLAYING_URL =
  "https://api.spotify.com/v1/me/player/currently-playing";
/**
 * Spotify "recently played" endpoint — the last-played fallback shown when
 * nothing is playing. Needs the `user-read-recently-played` scope; a token
 * authorized before that scope was added 403s here, which quietly disables
 * the fallback (never the endpoint).
 */
export const SPOTIFY_RECENTLY_PLAYED_URL =
  "https://api.spotify.com/v1/me/player/recently-played?limit=1";

/**
 * In-memory now-playing cache TTL. §4.6 originally said "~30s"; lowered to 5s
 * (2026-08-10) so track changes surface quickly — still ≤ 6 upstream calls per
 * Spotify's rolling 30s rate-limit window, single-flight regardless of traffic.
 */
export const NOW_PLAYING_CACHE_TTL_MS = 5_000;
/**
 * Task #119 - the recently-played endpoint is quota-expensive (each idle
 * fetch used to double the Spotify call rate). Cache the last-played payload
 * in module state and refetch ONLY on a playing-to-idle transition, on an
 * empty cache, or after this floor has elapsed. Ten minutes gives a fresh
 * enough view for the last-played line without spending against the daily
 * budget when the site is quietly idle.
 */
export const RECENTLY_PLAYED_MIN_REFRESH_MS = 10 * 60 * 1000;
/**
 * Safety margin subtracted from the token's advertised lifetime so we refresh
 * slightly BEFORE the real ~1h expiry rather than racing a 401 (§4.6).
 */
export const TOKEN_EXPIRY_SAFETY_MS = 60_000;
/** Upstream fetch timeout — a hung Spotify must not hang the public endpoint. */
export const SPOTIFY_UPSTREAM_TIMEOUT_MS = 4_000;

/**
 * Rate-limit backoff seed used when Spotify 429s without a `Retry-After`
 * header. Doubles each consecutive header-less 429 until it reaches
 * `SPOTIFY_BACKOFF_CAP_MS`; a successful call resets it. Kept exported so
 * tests can reason about the schedule without duplicating the numbers.
 */
export const SPOTIFY_BACKOFF_INITIAL_MS = 60_000;
/** Cap for the exponential backoff schedule — 15 minutes. */
export const SPOTIFY_BACKOFF_CAP_MS = 15 * 60 * 1000;
/**
 * Small jitter added to a `Retry-After` deadline so N leaders — should there
 * ever be more than one — don't all wake at the exact same millisecond.
 * Deliberately short: honouring the header exactly is the important bit.
 */
export const SPOTIFY_BACKOFF_JITTER_MS = 500;

/** Credentials the service needs, sourced from secrets/env (§9.3, §4.6). */
export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /**
   * Optional sink called with a rotated refresh token whenever a Spotify
   * refresh response includes one (task #112). Under Spotify's June 2026
   * rotation/reuse behavior every successful refresh MAY return a new
   * `refresh_token`; discarding it kills the stored grant within days. The
   * callback MUST persist to the shared encrypted store (rotateSpotifyRefreshToken)
   * so the very next refresh — this process or another — uses the fresh
   * value. The callback runs BEFORE the fresh access token is returned; a
   * throw is logged and swallowed so a persistence blip never fails the
   * live now-playing call.
   */
  onRefreshTokenRotated?: (newRefreshToken: string) => Promise<void>;
}

/** Curated track shape (§4.6) — deliberately NOT Spotify's raw payload. */
export interface NowPlayingTrack {
  title: string;
  artists: string[];
  album: string;
  art_url: string | null;
  url: string | null;
  progress_ms: number | null;
  duration_ms: number | null;
}

/** The last-played track and when it finished (ISO 8601), curated shape. */
export interface LastPlayed {
  track: NowPlayingTrack;
  played_at: string;
}

/**
 * Curated /api/now-playing payload (§4.6). Never contains any token. When idle,
 * `last_played` carries the most recently played track (best-effort: absent
 * when the recently-played call fails or the token lacks the scope).
 */
export type NowPlaying =
  | { playing: false; last_played?: LastPlayed }
  | { playing: true; track: NowPlayingTrack };

interface AccessToken {
  token: string;
  expiresAt: number;
}

interface NowPlayingCacheEntry {
  payload: NowPlaying;
  expiresAt: number;
}

// Module-level state: the in-memory access token, the ~30s now-playing cache, and
// a single-flight guard so a burst of concurrent cache-miss requests collapses to
// one upstream call (§4.6 rate-limit protection).
let accessToken: AccessToken | null = null;
let cache: NowPlayingCacheEntry | null = null;
let inFlight: Promise<NowPlaying> | null = null;
// A 403 from recently-played means the stored token predates the
// recently-played scope — a steady state until the admin reconnects, so it is
// logged once per process rather than on every idle cache miss.
let recentlyPlayedScopeWarned = false;

/**
 * Task #119 - module-level cache of the last-played payload plus the
 * playing/idle transition flag. `cachedLastPlayed` holds the LAST curated
 * `LastPlayed` returned by recently-played (or `null` when the endpoint
 * answered with no history / 403); `fetchedAtMs` throttles refresh to at most
 * once per `RECENTLY_PLAYED_MIN_REFRESH_MS`. `previouslyPlaying` tracks the
 * last observed currently-playing state so we can detect a playing-to-idle
 * transition (that's when the just-ended track becomes the new last-played
 * anchor and warrants a fresh recently-played call). Both are dropped on
 * runtime-state reset (admin reconnect / test harness).
 */
let cachedLastPlayed: { value: LastPlayed | null; fetchedAtMs: number } | null =
  null;
let previouslyPlaying = false;

/**
 * 429 backoff state — SHARED between now-playing and recently-played (one
 * Spotify budget). `backoffUntilMs` is the wall-clock the next Spotify call is
 * allowed at; `backoffStreak` counts consecutive header-less 429s so the
 * exponential schedule doubles; `inBackoff` gates the enter/leave logs so we
 * emit exactly one line per suspension window (task #90).
 *
 * Under task #97 this in-process state is a MIRROR of the shared Redis
 * suspension record, not an authoritative source. The lane clears it via
 * `clearSpotifyBackoff()` whenever the shared record is absent so a deleted
 * key stays deleted, and only re-writes the shared record from local state
 * when a fresh trip happens post-fetch — never from memory on every tick.
 */
let backoffUntilMs = 0;
let backoffStreak = 0;
let inBackoff = false;

/**
 * Auth-suspension state (task #95). When the token endpoint returns
 * invalid_grant (dead refresh token) — OR the service has no stored Spotify
 * credentials at all — Spotify traffic is halted entirely: no API call, and
 * critically no token-endpoint retry either. Failed-auth traffic still costs
 * against Spotify's daily quota under one client id, so a dev deployment with
 * a stale token was hammering `accounts.spotify.com` 77 times per 30 minutes.
 *
 * Resume happens out-of-band: the poll loop checks the stored
 * `service_tokens.updated_at` at most once per minute (cheap local DB read, no
 * Spotify call), and calls `resumeSpotifyAuth()` when it changes. A single log
 * line fires on both entry and exit.
 */
let authSuspended = false;

/**
 * Task #120 - daily Spotify Web API + token-endpoint budget guard.
 *
 * `budgetExhaustedUntilMs` is the wall-clock the current budget window
 * resets at, mirrored in-process so the fetcher wrapper short-circuits at
 * the same gate as the 429 backoff. The gate is a mirror of the shared
 * "budget" suspension record; the lane writes / clears the record and
 * `applySpotifyBudgetExhaustion` / `clearSpotifyBudgetExhaustion` keep the
 * local copy in sync.
 *
 * `budgetHook` is the injected counter; every outbound call to
 * `accounts.spotify.com` or `api.spotify.com` runs through it BEFORE the
 * fetch fires. Returning `capReached: true` skips the fetch (the counter
 * already recorded it, we just do not spend network bandwidth on a call
 * whose response we would ignore) and stamps in-process exhaustion so
 * subsequent Spotify code paths short-circuit until the next reset.
 */
let budgetExhaustedUntilMs = 0;
let budgetHook: SpotifyBudgetHook | null = null;

/**
 * Interface the injected budget guard exposes to this module. Deliberately
 * narrow (one method) so the coupling from spotifyService into the listener/
 * apiBudget module stays a single call site.
 */
export interface SpotifyBudgetHook {
  /**
   * Record one about-to-fire outbound call. Returns whether the cap has
   * been reached AFTER counting this call, plus the wall-clock the current
   * window resets at (used to stamp local exhaustion so the fetcher gate
   * knows when to lift). MUST NOT throw - a budget-guard failure must
   * never bring down a Spotify call.
   */
  noteCall(now?: number): Promise<{
    capReached: boolean;
    nextResetAtMs: number;
  }>;
}

/**
 * Categorized error kinds observed on the last Spotify interaction (task #112).
 * The shared health record surfaces these so the truthful status contract
 * (task 113, 2/2) can distinguish "grant died, admin needs to reconnect"
 * from "just rate-limited, will recover" from "something else went wrong".
 */
export type SpotifyErrorKind = "invalid_grant" | "rate_limited" | "other";

/** One entry in the in-memory health mirror. */
export interface SpotifyHealthErrorMirror {
  kind: SpotifyErrorKind;
  /** Wall-clock ms since epoch of the failure. */
  atMs: number;
  /** For rate_limited only — wall-clock ms the 429 window clears at. */
  rateLimitedUntilMs?: number;
}

/**
 * Task #112 — in-memory mirrors of the SHARED health record. Only the
 * polling leader writes shared health; every process (including non-leaders)
 * can still populate its mirror from local observations to serve a snapshot-
 * less request-path fallback. The lane's reconciler is what actually
 * persists the mirror to Redis (§task #97 pattern).
 */
let lastSuccessAtMs: number | null = null;
let lastError: SpotifyHealthErrorMirror | null = null;

const NOT_PLAYING: NowPlaying = { playing: false };

/**
 * True iff Spotify calls are currently paused because of a prior 429. The poll
 * loop's fetcher wrapper checks this to skip the tick without recording a
 * failure (last-good snapshot is preserved). `fetchNowPlaying` /
 * `fetchLastPlayed` also short-circuit on this so the router-side fallback
 * doesn't hammer Spotify during a suspension either.
 */
export function isSpotifyRateLimited(now: number = Date.now()): boolean {
  return now < backoffUntilMs;
}

/**
 * The wall-clock (ms since epoch) the current 429 backoff clears at, or 0 if
 * not in backoff. Exposed for the shared-suspension reconciler (task #96) —
 * the leader mirrors this value into the Redis suspension record so any other
 * instance / freshly-elected leader honors the same deadline.
 */
export function getSpotifyBackoffUntilMs(): number {
  return backoffUntilMs;
}

/**
 * Prime the 429 backoff window from an external source (Redis-persisted
 * suspension, task #96) without incrementing the exponential streak. Called
 * on a fresh leader that inherits an existing 429 suspension so the local
 * fetcher wrapper honors it without needing to trip a fresh 429.
 */
export function applySpotifyBackoffUntil(untilMs: number): void {
  if (untilMs > backoffUntilMs) {
    backoffUntilMs = untilMs;
    inBackoff = true;
  }
}

/**
 * Clear the in-process 429 backoff mirror (task #97). Called by the lane when
 * it observes that the SHARED suspension record is absent — Redis is the
 * source of truth, so a deleted key means the local mirror must also clear or
 * the fetcher wrapper would short-circuit on stale in-memory state and the
 * lane would keep re-persisting the same deadline. Also resets the exponential
 * streak so a subsequent trip starts at the base seed rather than continuing
 * from wherever the last window left off.
 */
export function clearSpotifyBackoff(): void {
  backoffUntilMs = 0;
  backoffStreak = 0;
  inBackoff = false;
}

/**
 * True iff Spotify is currently auth-suspended (task #95): the last token
 * refresh returned invalid_grant, or the service has no stored credentials.
 * Every Spotify code path — API calls AND the token endpoint — short-circuits
 * on this until `resumeSpotifyAuth()` fires (poll loop detects a changed
 * `service_tokens.updated_at`).
 */
export function isSpotifyAuthSuspended(): boolean {
  return authSuspended;
}

/**
 * True iff the current process is under a task #120 budget-exhaustion
 * suspension. Cheap synchronous check the fetcher wrapper uses to skip a
 * tick without touching Spotify.
 */
export function isSpotifyBudgetExhausted(now: number = Date.now()): boolean {
  return now < budgetExhaustedUntilMs;
}

/**
 * Wall-clock (ms since epoch) the budget window resets at, or 0 when not
 * exhausted. Exposed for the lane's reconciler so it can mirror the local
 * exhaustion into the shared "budget" suspension record with a real deadline.
 */
export function getSpotifyBudgetExhaustedUntilMs(): number {
  return budgetExhaustedUntilMs;
}

/**
 * Prime the local budget-exhaustion mirror from an external source (a
 * "budget"-reason suspension record read by a freshly-elected leader).
 * Idempotent, monotonic (only extends the deadline, never shortens it).
 */
export function applySpotifyBudgetExhaustion(untilMs: number): void {
  if (untilMs > budgetExhaustedUntilMs) {
    budgetExhaustedUntilMs = untilMs;
  }
}

/**
 * Clear the local budget-exhaustion mirror (task #97-style: shared Redis
 * record is authoritative, so when it is absent local state MUST clear too
 * or the fetcher wrapper short-circuits on stale in-memory state).
 */
export function clearSpotifyBudgetExhaustion(): void {
  budgetExhaustedUntilMs = 0;
}

/**
 * Install the budget hook. Called once at bootstrap; passing null disables
 * the guard (default behavior for tests that don't opt in). The hook is
 * consulted BEFORE every outbound call to `accounts.spotify.com` or
 * `api.spotify.com` - the dealer websocket and other listener traffic do
 * NOT hit those hosts and are not counted.
 */
export function setSpotifyBudgetHook(hook: SpotifyBudgetHook | null): void {
  budgetHook = hook;
}

/**
 * The last observed successful Spotify API fetch, wall-clock ms since epoch,
 * or null when none has been observed in this process yet. Task #112 — the
 * health mirror; the shared record is authoritative, this is the local copy
 * the reconciler flushes each tick.
 */
export function getSpotifyLastSuccessAtMs(): number | null {
  return lastSuccessAtMs;
}

/** The last observed error, or null when the last observation was a success. */
export function getSpotifyLastError(): SpotifyHealthErrorMirror | null {
  return lastError;
}

/**
 * Record a successful Spotify API fetch (a 200 from the currently-playing or
 * recently-played endpoint). Clears `lastError` — the most recent observation
 * is now a success, and the shared health record mirrors that.
 */
export function noteSpotifyApiSuccess(now: number = Date.now()): void {
  lastSuccessAtMs = now;
  lastError = null;
}

/**
 * Record a categorized failure. Rate-limited failures carry the deadline the
 * 429 window clears at (matches the shared suspension record's
 * `suspended_until` for the same 429).
 */
export function noteSpotifyApiError(
  kind: SpotifyErrorKind,
  now: number = Date.now(),
  rateLimitedUntilMs?: number
): void {
  lastError = {
    kind,
    atMs: now,
    ...(kind === "rate_limited" && rateLimitedUntilMs != null
      ? { rateLimitedUntilMs }
      : {}),
  };
}

/**
 * Apply a shared health record into the in-memory mirror. Called by a
 * freshly-elected leader on first tick so it inherits what the previous
 * leader observed instead of starting blank. Only overwrites when the shared
 * value is more recent than what's already in memory (last-write-wins).
 */
export function applySpotifyHealthMirror(record: {
  last_success_at: string | null;
  last_error: {
    kind: SpotifyErrorKind;
    at: string;
    rate_limited_until?: string;
  } | null;
}): void {
  if (record.last_success_at) {
    const parsed = Date.parse(record.last_success_at);
    if (Number.isFinite(parsed) && (lastSuccessAtMs == null || parsed > lastSuccessAtMs)) {
      lastSuccessAtMs = parsed;
    }
  }
  if (record.last_error) {
    const at = Date.parse(record.last_error.at);
    if (Number.isFinite(at) && (lastError == null || at > lastError.atMs)) {
      const rlu = record.last_error.rate_limited_until
        ? Date.parse(record.last_error.rate_limited_until)
        : undefined;
      lastError = {
        kind: record.last_error.kind,
        atMs: at,
        ...(record.last_error.kind === "rate_limited" && Number.isFinite(rlu as number)
          ? { rateLimitedUntilMs: rlu as number }
          : {}),
      };
    }
  }
}

/**
 * Enter auth suspension. Idempotent. Logs a single line with the reconnect
 * hint the first time — subsequent calls are silent.
 */
export function suspendSpotifyAuth(reason: string): void {
  if (authSuspended) return;
  authSuspended = true;
  console.warn(
    `[spotifyService] Spotify auth suspended (${reason}); ` +
      "no Spotify calls (API or token endpoint) will fire until the stored " +
      "service_tokens row updates. Reconnect Spotify from the admin " +
      "Integrations page."
  );
}

/**
 * Leave auth suspension. Idempotent. Logs a single line the first time.
 * Called by the poll loop when it detects a changed `service_tokens.updated_at`.
 */
export function resumeSpotifyAuth(): void {
  if (!authSuspended) return;
  authSuspended = false;
  // Any cached access token was minted against the OLD refresh token — drop it
  // so the very next call re-exchanges against the fresh credentials.
  accessToken = null;
  cache = null;
  inFlight = null;
  // Task #121 - explicit invalidation of the serviceTokenStore cache for
  // spotify. Without this, a resume-then-fetch on the polling leader can
  // still read its own stale decrypted refresh token (memoized before the
  // admin reconnected on another instance), 401 as invalid_grant, and re-
  // suspend with a fresh updated_at snapshot - wedging Spotify permanently
  // until the container restarts. The store's TTL alone converges within a
  // minute; this pushes the fresh row to the very next refresh.
  invalidateServiceTokenCache(SPOTIFY_SERVICE_KEY);
  console.warn(
    "[spotifyService] Spotify auth resumed; token refresh will be retried on the next tick"
  );
}

function parseRetryAfterSeconds(res: unknown): number | null {
  const headers = (res as { headers?: { get?: (name: string) => string | null } })
    ?.headers;
  const raw = headers?.get?.("retry-after") ?? null;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Record a 429 from Spotify — extend the suspension window (Retry-After when
 * present, otherwise exponential backoff seeded at `SPOTIFY_BACKOFF_INITIAL_MS`
 * and capped at `SPOTIFY_BACKOFF_CAP_MS`). Logs a single line the FIRST time we
 * enter suspension; subsequent 429s within the same window are silent.
 */
function noteSpotifyRateLimited(res: unknown): void {
  const retryAfterSec = parseRetryAfterSeconds(res);
  let delayMs: number;
  if (retryAfterSec != null) {
    delayMs = retryAfterSec * 1000 + Math.floor(Math.random() * SPOTIFY_BACKOFF_JITTER_MS);
  } else {
    delayMs = Math.min(
      SPOTIFY_BACKOFF_CAP_MS,
      SPOTIFY_BACKOFF_INITIAL_MS * 2 ** backoffStreak
    );
    backoffStreak += 1;
  }
  const until = Date.now() + delayMs;
  if (until > backoffUntilMs) backoffUntilMs = until;
  // Task #112 — health mirror. The `until` deadline matches the shared
  // suspension record's `suspended_until` for the same 429; the reconciler
  // flushes this to the shared health record so the admin status endpoint
  // knows when the current window clears.
  noteSpotifyApiError("rate_limited", Date.now(), until);
  if (!inBackoff) {
    inBackoff = true;
    const source = retryAfterSec != null ? `Retry-After ${retryAfterSec}s` : "no Retry-After";
    console.warn(
      `[spotifyService] Spotify 429 (${source}); suspending Spotify fetches for ` +
        `${Math.round(delayMs / 1000)}s (until ${new Date(backoffUntilMs).toISOString()})`
    );
  }
}

/**
 * Any non-429 response from Spotify means it is answering us — clear the
 * backoff window. Logs a single line the FIRST time we leave a suspension.
 */
function noteSpotifyResponsive(): void {
  if (!inBackoff && backoffUntilMs === 0 && backoffStreak === 0) return;
  const wasInBackoff = inBackoff;
  backoffUntilMs = 0;
  backoffStreak = 0;
  inBackoff = false;
  if (wasInBackoff) {
    console.warn("[spotifyService] Spotify 429 cleared; resuming fetches");
  }
}

function timeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    SPOTIFY_UPSTREAM_TIMEOUT_MS
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Wrap `noteCall` on the injected budget hook (task #120). Returns true when
 * the call is allowed to proceed, false when the cap has been reached and
 * this call MUST be skipped. Stamps in-process exhaustion on cap so
 * subsequent code paths short-circuit at the fetcher gate. Never throws -
 * a hook failure never breaks a Spotify call (the counter is best-effort).
 */
async function passesBudget(): Promise<boolean> {
  if (!budgetHook) return true;
  try {
    const { capReached, nextResetAtMs } = await budgetHook.noteCall();
    if (capReached) {
      if (Number.isFinite(nextResetAtMs) && nextResetAtMs > 0) {
        applySpotifyBudgetExhaustion(nextResetAtMs);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "[spotifyService] budget hook threw; skipping guard for this call:",
      err instanceof Error ? err.message : err
    );
    return true;
  }
}

/**
 * Exchange the refresh token for a fresh access token and store it in memory
 * (§4.6). Throws on failure — the caller degrades to `{ playing: false }`. The
 * thrown error message NEVER includes the token or the client secret.
 */
async function refreshAccessToken(config: SpotifyConfig): Promise<string> {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    // Missing credentials is a stable state until an admin reconnects —
    // suspend so the poll loop stops hammering `refreshAccessToken` every tick.
    suspendSpotifyAuth("no stored Spotify credentials");
    throw new Error("Spotify credentials are not configured");
  }

  const basic = Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
  });

  // Task #120 - count the token endpoint against the daily budget. If the
  // cap trips we skip the exchange (returns null on this path via a thrown
  // signal-string caught by the fetcher, which degrades to idle). We still
  // count the call itself because the counter records every attempt, even
  // one we are about to bail on.
  const allowed = await passesBudget();
  if (!allowed) {
    throw new Error(
      "Spotify token refresh skipped: daily API call budget exhausted"
    );
  }

  const { signal, clear } = timeoutSignal();
  try {
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal,
    });

    if (!res.ok) {
      // A revoked OR expired refresh token surfaces here as 400 invalid_grant —
      // since Spotify's June 2026 policy change, refresh tokens die 180 days
      // after authorization, so this is now a routine state, not just sabotage.
      // We do not echo the body — keeping the log to the status code guarantees
      // no credential ever leaks into logs.
      if (res.status === 400) {
        // Suspend now: subsequent token retries would spend against the same
        // daily quota and would keep failing until the admin reconnects.
        suspendSpotifyAuth("invalid_grant on token refresh");
        // Task #112 — mark the health mirror so the truthful status contract
        // reflects "grant died, admin must reconnect" and not just "something
        // went wrong". Persistence happens via the lane's reconciler.
        noteSpotifyApiError("invalid_grant");
      } else {
        noteSpotifyApiError("other");
      }
      const hint =
        res.status === 400
          ? " (invalid_grant: the refresh token is likely expired or revoked —" +
            " reconnect Spotify from the admin Integrations page)"
          : "";
      throw new Error(
        `Spotify token refresh failed with status ${res.status}${hint}`
      );
    }

    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!body.access_token) {
      throw new Error("Spotify token refresh returned no access_token");
    }

    // Task #112 — Spotify's June 2026 rotation/reuse behavior may return a
    // NEW refresh_token on any successful refresh. If we discard it, the old
    // token becomes unusable on the next refresh and the grant dies within
    // days. Persist BEFORE returning the access token so a crash between
    // refresh and next-tick can't leave us holding an already-invalidated
    // token. Persistence errors are logged and swallowed — the fresh access
    // token still serves this request, and the next refresh will retry the
    // rotation (worst case: one extra refresh, not a broken grant).
    if (
      body.refresh_token &&
      body.refresh_token !== config.refreshToken &&
      config.onRefreshTokenRotated
    ) {
      try {
        await config.onRefreshTokenRotated(body.refresh_token);
      } catch (err) {
        console.error(
          "[spotifyService] rotated refresh_token persistence failed:",
          err instanceof Error ? err.message : err
        );
      }
    }

    const lifetimeMs = (body.expires_in ?? 3600) * 1000;
    accessToken = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_SAFETY_MS),
    };
    return accessToken.token;
  } finally {
    clear();
  }
}

/** Return a valid in-memory access token, refreshing on absence/expiry (§4.6). */
async function getAccessToken(config: SpotifyConfig): Promise<string> {
  if (authSuspended) {
    // Never hit the token endpoint while suspended (task #95): failed refresh
    // traffic still burns daily quota under one client id.
    throw new Error("Spotify auth suspended; skipping token refresh");
  }
  if (accessToken && accessToken.expiresAt > Date.now()) {
    return accessToken.token;
  }
  return refreshAccessToken(config);
}

async function callCurrentlyPlaying(token: string): Promise<Response | null> {
  // Task #120 - budget count + guard. When exhausted, return null so the
  // caller degrades to idle without hitting the network (a spent quota is
  // as good as a 429).
  if (!(await passesBudget())) return null;
  const { signal, clear } = timeoutSignal();
  try {
    return await fetch(SPOTIFY_NOW_PLAYING_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    });
  } finally {
    clear();
  }
}

async function callRecentlyPlayed(token: string): Promise<Response | null> {
  // Task #120 - budget count + guard. Same as currently-playing above.
  if (!(await passesBudget())) return null;
  const { signal, clear } = timeoutSignal();
  try {
    return await fetch(SPOTIFY_RECENTLY_PLAYED_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    });
  } finally {
    clear();
  }
}

/** Map a Spotify currently-playing 200 body to the curated shape (§4.6). */
export function mapCurrentlyPlaying(body: unknown): NowPlaying {
  if (body == null || typeof body !== "object") return NOT_PLAYING;
  const rec = body as Record<string, unknown>;
  const item = rec.item as Record<string, unknown> | null | undefined;

  // 200 with no `item` happens for ads / private sessions — nothing to show, so
  // this degrades to idle rather than an empty track (§3.5).
  if (!item || typeof item !== "object") return NOT_PLAYING;

  const album = item.album as Record<string, unknown> | undefined;
  const images = (album?.images as Array<{ url?: unknown }> | undefined) ?? [];
  const artistsRaw =
    (item.artists as Array<{ name?: unknown }> | undefined) ?? [];
  const externalUrls = item.external_urls as
    | Record<string, unknown>
    | undefined;

  const track: NowPlayingTrack = {
    title: typeof item.name === "string" ? item.name : "",
    artists: artistsRaw
      .map((a) => (typeof a?.name === "string" ? a.name : ""))
      .filter((n) => n !== ""),
    album: typeof album?.name === "string" ? (album.name as string) : "",
    art_url: typeof images[0]?.url === "string" ? (images[0].url as string) : null,
    url:
      typeof externalUrls?.spotify === "string"
        ? (externalUrls.spotify as string)
        : null,
    progress_ms:
      typeof rec.progress_ms === "number" ? (rec.progress_ms as number) : null,
    duration_ms:
      typeof item.duration_ms === "number" ? (item.duration_ms as number) : null,
  };
  return { playing: true, track };
}

/**
 * Map a Spotify recently-played 200 body to the curated last-played shape.
 * The `items[0].track` object is the same shape as currently-playing's `item`,
 * so the track mapping is shared; `played_at` is Spotify's ISO 8601 timestamp.
 * Anything malformed degrades to `null` (no fallback), never an error.
 */
export function mapRecentlyPlayed(body: unknown): LastPlayed | null {
  if (body == null || typeof body !== "object") return null;
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0] as Record<string, unknown> | null | undefined;
  if (!first || typeof first !== "object") return null;

  const mapped = mapCurrentlyPlaying({ item: first.track });
  if (!mapped.playing) return null;

  return {
    track: mapped.track,
    played_at: typeof first.played_at === "string" ? first.played_at : "",
  };
}

/**
 * Best-effort last-played lookup for the idle payload. Never throws and never
 * blocks the idle answer beyond the upstream timeout: any failure — including
 * the 403 a pre-scope-change token gets — just means no `last_played` field.
 */
async function fetchLastPlayed(token: string): Promise<LastPlayed | null> {
  // Share the same 429 budget as now-playing — skip while suspended so idle
  // enrichment doesn't extend the penalty window.
  if (isSpotifyRateLimited()) return null;
  // Auth-suspended (task #95): never touch Spotify at all.
  if (authSuspended) return null;
  // Budget-exhausted (task #120): same short-circuit as rate-limit.
  if (isSpotifyBudgetExhausted()) return null;
  try {
    const res = await callRecentlyPlayed(token);
    // Budget hook may have tripped inside callRecentlyPlayed and returned null
    // rather than firing the fetch. Degrade to no-last-played silently.
    if (res == null) return null;

    if (res.status === 429) {
      noteSpotifyRateLimited(res);
      return null;
    }

    if (res.status === 403) {
      // Spotify answered — clear any prior 429 window.
      noteSpotifyResponsive();
      if (!recentlyPlayedScopeWarned) {
        recentlyPlayedScopeWarned = true;
        console.warn(
          "[spotifyService] recently-played returned 403 — the stored token" +
            " lacks the user-read-recently-played scope; reconnect Spotify" +
            " from the admin Integrations page to enable the last-played" +
            " fallback (warning logged once)"
        );
      }
      return null;
    }

    if (res.status !== 200) {
      throw new Error(`Spotify recently-played returned status ${res.status}`);
    }

    noteSpotifyResponsive();
    noteSpotifyApiSuccess();
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return mapRecentlyPlayed(body);
  } catch (err) {
    console.error(
      "[spotifyService] recently-played failed; serving idle without last_played:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * The idle payload, with the last-played track attached when available.
 *
 * Task #119 - single-call idle. `recently-played` is fetched ONLY when:
 *   - the cache is empty (first idle after boot / after a resource reset), OR
 *   - the previous observation was `playing` (playing-to-idle transition,
 *     the just-ended track is the new last-played anchor), OR
 *   - at least `RECENTLY_PLAYED_MIN_REFRESH_MS` have elapsed since the last
 *     recently-played call (safety net so a very long idle period still
 *     refreshes eventually).
 * Otherwise the cached last-played is reused - the idle payload still
 * carries a `last_played` line but no Spotify Web API call fires. This
 * exactly halves the quota burn compared to the pre-#119 behavior of
 * calling recently-played on EVERY idle fetch.
 */
async function idleWithLastPlayed(
  token: string,
  now: number = Date.now()
): Promise<NowPlaying> {
  const wasPlaying = previouslyPlaying;
  previouslyPlaying = false;

  const cacheAgeMs = cachedLastPlayed
    ? now - cachedLastPlayed.fetchedAtMs
    : Infinity;
  const shouldRefetch =
    cachedLastPlayed == null ||
    wasPlaying ||
    cacheAgeMs >= RECENTLY_PLAYED_MIN_REFRESH_MS;

  if (shouldRefetch) {
    const fresh = await fetchLastPlayed(token);
    cachedLastPlayed = { value: fresh, fetchedAtMs: now };
  }

  const last = cachedLastPlayed?.value ?? null;
  return last ? { playing: false, last_played: last } : NOT_PLAYING;
}

/**
 * Do the actual upstream work for a cache miss: ensure a token, call Spotify, and
 * on a 401 refresh the token once and retry (§4.6). Any failure degrades to
 * `{ playing: false }` and logs — it never throws. When idle, the recently-played
 * endpoint is consulted (same token) so the payload can carry `last_played`.
 */
async function fetchNowPlaying(config: SpotifyConfig): Promise<NowPlaying> {
  // Short-circuit while under Spotify's 429 backoff — never hit the upstream at
  // all so we don't extend the penalty window. The poll-loop fetcher wrapper
  // also short-circuits at the same gate so the shared snapshot is preserved.
  if (isSpotifyRateLimited()) return NOT_PLAYING;
  // Auth-suspended (task #95): the token refresh is dead; degrade to idle
  // without ever touching accounts.spotify.com or api.spotify.com.
  if (authSuspended) return NOT_PLAYING;
  // Budget-exhausted (task #120): identical short-circuit; the shared record
  // has reason "budget" and the deadline is the next window reset.
  if (isSpotifyBudgetExhausted()) return NOT_PLAYING;
  try {
    let token = await getAccessToken(config);
    let res = await callCurrentlyPlaying(token);
    if (res == null) {
      // Budget hook tripped this exact call. Degrade to idle so the
      // fetcher wrapper writes a degraded snapshot on the leader path.
      return NOT_PLAYING;
    }

    // Expired/invalid access token → force a refresh and retry exactly once.
    if (res.status === 401) {
      token = await refreshAccessToken(config);
      res = await callCurrentlyPlaying(token);
      if (res == null) return NOT_PLAYING;
    }

    // 429 → suspend all Spotify fetches (Retry-After or exponential backoff).
    if (res.status === 429) {
      noteSpotifyRateLimited(res);
      return NOT_PLAYING;
    }

    // 204 = nothing playing: a normal response, not an error (§4.6). Counts
    // as a successful Spotify API fetch for the health record (task #112).
    if (res.status === 204) {
      noteSpotifyResponsive();
      noteSpotifyApiSuccess();
      return idleWithLastPlayed(token);
    }

    if (res.status === 200) {
      noteSpotifyResponsive();
      noteSpotifyApiSuccess();
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const mapped = mapCurrentlyPlaying(body);
      // 200-but-no-item (ad / private session) is idle too — same fallback.
      if (mapped.playing) {
        // Task #119 - remember we saw a playing track so the NEXT idle fetch
        // treats itself as a playing-to-idle transition and refreshes the
        // last-played cache from the newly-ended track.
        previouslyPlaying = true;
        return mapped;
      }
      return idleWithLastPlayed(token);
    }

    // Any other status (still 401 after retry, 5xx, …) → degrade. Do NOT
    // clear the backoff window here: we don't know that Spotify is healthy.
    noteSpotifyApiError("other");
    throw new Error(`Spotify currently-playing returned status ${res.status}`);
  } catch (err) {
    // The specific error-kind setters above (invalid_grant, rate_limited,
    // other-status) already marked the health mirror. Network errors /
    // timeouts fall through as "other" so the status contract can still
    // distinguish them from the auth-dead case.
    if (lastError == null && !authSuspended && !isSpotifyRateLimited()) {
      noteSpotifyApiError("other");
    }
    console.error(
      "[spotifyService] now-playing failed; serving { playing: false }:",
      err instanceof Error ? err.message : err
    );
    return NOT_PLAYING;
  }
}

/**
 * Get the curated now-playing payload, served from a short in-memory cache
 * (`NOW_PLAYING_CACHE_TTL_MS`, §4.6).
 * Concurrent cache-miss callers share a single upstream call (single-flight).
 * Always resolves — never rejects — so `GET /api/now-playing` never returns a 5xx.
 */
export async function getNowPlaying(config: SpotifyConfig): Promise<NowPlaying> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.payload;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const payload = await fetchNowPlaying(config);
    cache = { payload, expiresAt: Date.now() + NOW_PLAYING_CACHE_TTL_MS };
    return payload;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Clear the in-memory access token and the now-playing cache. Called by the admin
 * reconnect flow after storing a new refresh token so the very next
 * /api/now-playing request runs on the new authorization instead of riding out
 * the old token/cache.
 */
export function clearSpotifyRuntimeState(): void {
  accessToken = null;
  cache = null;
  inFlight = null;
  // A fresh authorization may carry the recently-played scope — warn anew if not.
  recentlyPlayedScopeWarned = false;
  // Task #119 - the last-played cache is tied to the previous grant's
  // playback history; a fresh grant starts with a clean slate so the very
  // next idle fetch pulls a fresh recently-played (which will succeed under
  // the new scope, or 403 and populate the scope-warn again).
  cachedLastPlayed = null;
  previouslyPlaying = false;
  // Fresh authorization does NOT lift a rate limit (the 429 is tied to the
  // client, not the refresh token), but resetting the streak is fine: the next
  // call will re-enter backoff if Spotify still returns 429.
  backoffUntilMs = 0;
  backoffStreak = 0;
  inBackoff = false;
  // Fresh authorization does NOT lift a budget exhaustion either (the budget
  // is per app / client id, unrelated to the refresh token). Reset it here
  // anyway so a test-only reset via `_resetSpotifyStateForTests` starts
  // clean; production `clearSpotifyRuntimeState` is only called on admin
  // reconnect, and the very next tick will re-mirror any live shared record.
  budgetExhaustedUntilMs = 0;
  // A fresh authorization always lifts auth suspension: the whole point of the
  // admin reconnect flow is to install a working refresh token.
  authSuspended = false;
  // The health mirror is process-scoped observation, not credential state —
  // dropping it on reconnect gives the truthful status endpoint a clean
  // starting point for the new grant.
  lastSuccessAtMs = null;
  lastError = null;
}

/** Test-only alias: clear the in-memory token, cache, and any in-flight fetch. */
export function _resetSpotifyStateForTests(): void {
  clearSpotifyRuntimeState();
  // Detach any injected budget hook so tests do not leak state across
  // suites (bootstrap installs a hook that survives a runtime-state
  // clear in production, but tests need a clean slate).
  budgetHook = null;
}
