/**
 * Spotify service — TECH_SPEC_V1.md §4.6 (`/api/now-playing`) / task #442.
 *
 * The `now_playing` section needs Spotify's *Get Currently Playing Track*
 * endpoint, which requires a USER-authorized token (`user-read-currently-playing`
 * scope). The API proxies it server-side for the same reasons `/api/status`
 * proxies the gateway (§3.5): the refresh token never leaves the server, the
 * exposed shape is a deliberate curated choice, and a ~30s cache means visitor
 * traffic never multiplies upstream calls (Spotify sees ≤ ~2 req/min regardless).
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

/** In-memory now-playing cache TTL (§4.6 "~30s"). */
export const NOW_PLAYING_CACHE_TTL_MS = 30_000;
/**
 * Safety margin subtracted from the token's advertised lifetime so we refresh
 * slightly BEFORE the real ~1h expiry rather than racing a 401 (§4.6).
 */
export const TOKEN_EXPIRY_SAFETY_MS = 60_000;
/** Upstream fetch timeout — a hung Spotify must not hang the public endpoint. */
export const SPOTIFY_UPSTREAM_TIMEOUT_MS = 4_000;

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

/** Curated /api/now-playing payload (§4.6). Never contains any token. */
export type NowPlaying =
  | { playing: false }
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

const NOT_PLAYING: NowPlaying = { playing: false };

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
      // A revoked refresh token surfaces here as 400 invalid_grant (§4.6). We do
      // not echo the body — it can contain nothing sensitive, but keeping the log
      // to the status code guarantees no credential ever leaks into logs.
      throw new Error(`Spotify token refresh failed with status ${res.status}`);
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
 * Do the actual upstream work for a cache miss: ensure a token, call Spotify, and
 * on a 401 refresh the token once and retry (§4.6). Any failure degrades to
 * `{ playing: false }` and logs — it never throws.
 */
async function fetchNowPlaying(config: SpotifyConfig): Promise<NowPlaying> {
  try {
    let token = await getAccessToken(config);
    let res = await callCurrentlyPlaying(token);

    // Expired/invalid access token → force a refresh and retry exactly once.
    if (res.status === 401) {
      token = await refreshAccessToken(config);
      res = await callCurrentlyPlaying(token);
    }

    // 204 = nothing playing: a normal response, not an error (§4.6).
    if (res.status === 204) return NOT_PLAYING;

    if (res.status === 200) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return mapCurrentlyPlaying(body);
    }

    // Any other status (still 401 after retry, 5xx, 429, …) → degrade.
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
 * Get the curated now-playing payload, served from a ~30s in-memory cache (§4.6).
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

/** Test-only: clear the in-memory token, cache, and any in-flight fetch. */
export function _resetSpotifyStateForTests(): void {
  accessToken = null;
  cache = null;
  inFlight = null;
}
