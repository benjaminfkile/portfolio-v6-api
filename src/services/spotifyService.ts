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
 * 429 backoff state — SHARED between now-playing and recently-played (one
 * Spotify budget). `backoffUntilMs` is the wall-clock the next Spotify call is
 * allowed at; `backoffStreak` counts consecutive header-less 429s so the
 * exponential schedule doubles; `inBackoff` gates the enter/leave logs so we
 * emit exactly one line per suspension window (task #90).
 *
 * The state lives in-process on the leader per the task spec: a new leader
 * starting fresh will re-trip once and re-enter, which is acceptable.
 */
let backoffUntilMs = 0;
let backoffStreak = 0;
let inBackoff = false;

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
 * Exchange the refresh token for a fresh access token and store it in memory
 * (§4.6). Throws on failure — the caller degrades to `{ playing: false }`. The
 * thrown error message NEVER includes the token or the client secret.
 */
async function refreshAccessToken(config: SpotifyConfig): Promise<string> {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error("Spotify credentials are not configured");
  }

  const basic = Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
  });

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
    };
    if (!body.access_token) {
      throw new Error("Spotify token refresh returned no access_token");
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
  if (accessToken && accessToken.expiresAt > Date.now()) {
    return accessToken.token;
  }
  return refreshAccessToken(config);
}

async function callCurrentlyPlaying(token: string): Promise<Response> {
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

async function callRecentlyPlayed(token: string): Promise<Response> {
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
  try {
    const res = await callRecentlyPlayed(token);

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

/** The idle payload, with the last-played track attached when available. */
async function idleWithLastPlayed(token: string): Promise<NowPlaying> {
  const last = await fetchLastPlayed(token);
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
  try {
    let token = await getAccessToken(config);
    let res = await callCurrentlyPlaying(token);

    // Expired/invalid access token → force a refresh and retry exactly once.
    if (res.status === 401) {
      token = await refreshAccessToken(config);
      res = await callCurrentlyPlaying(token);
    }

    // 429 → suspend all Spotify fetches (Retry-After or exponential backoff).
    if (res.status === 429) {
      noteSpotifyRateLimited(res);
      return NOT_PLAYING;
    }

    // 204 = nothing playing: a normal response, not an error (§4.6).
    if (res.status === 204) {
      noteSpotifyResponsive();
      return idleWithLastPlayed(token);
    }

    if (res.status === 200) {
      noteSpotifyResponsive();
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const mapped = mapCurrentlyPlaying(body);
      // 200-but-no-item (ad / private session) is idle too — same fallback.
      return mapped.playing ? mapped : idleWithLastPlayed(token);
    }

    // Any other status (still 401 after retry, 5xx, …) → degrade. Do NOT
    // clear the backoff window here: we don't know that Spotify is healthy.
    throw new Error(`Spotify currently-playing returned status ${res.status}`);
  } catch (err) {
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
  // Fresh authorization does NOT lift a rate limit (the 429 is tied to the
  // client, not the refresh token), but resetting the streak is fine: the next
  // call will re-enter backoff if Spotify still returns 429.
  backoffUntilMs = 0;
  backoffStreak = 0;
  inBackoff = false;
}

/** Test-only alias: clear the in-memory token, cache, and any in-flight fetch. */
export function _resetSpotifyStateForTests(): void {
  clearSpotifyRuntimeState();
}
