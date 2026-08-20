import request from "supertest";

// Task #112 killed the static `spotify_refresh_token` secret fallback — the
// grant now comes exclusively from the encrypted service_tokens table. This
// suite has no database, so we stub the store's read to inject a working
// refresh token; the HTTP router then behaves exactly as it does in
// production against a real reconnected admin.
jest.mock("../src/services/spotifyTokenStore", () => {
  const actual = jest.requireActual("../src/services/spotifyTokenStore");
  return {
    ...actual,
    getStoredSpotifyToken: jest.fn().mockResolvedValue({
      refreshToken: "refresh-token-123",
      authorizedAt: new Date(0),
    }),
    rotateSpotifyRefreshToken: jest.fn().mockResolvedValue(true),
  };
});

// The now-playing feed is listener-only: the public router serves the durable
// last-known payload the listener persisted (never Spotify). This suite has no
// database, so we stub the store's read to control what the router returns.
jest.mock("../src/services/nowPlayingStateStore", () => ({
  getLastNowPlaying: jest.fn().mockResolvedValue(null),
  saveLastNowPlaying: jest.fn().mockResolvedValue(undefined),
}));

import app from "../src/app";
import {
  getNowPlaying,
  isSpotifyRateLimited,
  mapCurrentlyPlaying,
  mapRecentlyPlayed,
  _resetSpotifyStateForTests,
  NOW_PLAYING_CACHE_TTL_MS,
  SPOTIFY_BACKOFF_CAP_MS,
  SPOTIFY_BACKOFF_INITIAL_MS,
  SPOTIFY_TOKEN_URL,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
  SpotifyConfig,
} from "../src/services/spotifyService";
import { getLastNowPlaying } from "../src/services/nowPlayingStateStore";

const mockGetLastNowPlaying = getLastNowPlaying as jest.Mock;

/**
 * /api/now-playing tests — TECH_SPEC_V1.md §4.6 / task #442.
 *
 * ALL upstream HTTP is mocked (global `fetch`, dispatched by URL); no Spotify, no
 * AWS, no DB is touched. Covered: 204→{playing:false}, the 200→curated shape, the
 * 401→token-refresh→retry path, the ~30s cache (upstream called once within the
 * TTL), token refresh on ~1h expiry, the degrade-rather-than-error contract (any
 * upstream failure → {playing:false}, never a 5xx), and that no token ever leaks
 * into a response.
 */

const CONFIG: SpotifyConfig = {
  clientId: "client-id-abc",
  clientSecret: "client-secret-xyz",
  refreshToken: "refresh-token-123",
};

const ACCESS_TOKEN = "access-token-SECRET-t1";
const ACCESS_TOKEN_2 = "access-token-SECRET-t2";

const mockFetch = jest.fn();

function tokenResponse(token: string, expiresIn = 3600): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
  } as unknown as Response;
}

function nowPlaying200(): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      is_playing: true,
      progress_ms: 83000,
      item: {
        name: "Some Song",
        duration_ms: 214000,
        artists: [{ name: "Artist One" }, { name: "Artist Two" }],
        album: {
          name: "Some Album",
          images: [{ url: "https://i.scdn.co/image/abc" }],
        },
        external_urls: { spotify: "https://open.spotify.com/track/xyz" },
      },
    }),
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({}),
  } as unknown as Response;
}

/** A 429 response with an optional `Retry-After` header. */
function rateLimited429(retryAfterSeconds?: number): Response {
  const headers = new Map<string, string>();
  if (retryAfterSeconds != null) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return {
    status: 429,
    ok: false,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    json: async () => ({}),
  } as unknown as Response;
}

/** A recently-played 200 body — `items[0].track` mirrors currently-playing's item. */
function recentlyPlayed200(): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      items: [
        {
          played_at: "2026-08-10T20:15:00.000Z",
          track: {
            name: "Last Song",
            duration_ms: 199000,
            artists: [{ name: "Last Artist" }],
            album: {
              name: "Last Album",
              images: [{ url: "https://i.scdn.co/image/last" }],
            },
            external_urls: { spotify: "https://open.spotify.com/track/last" },
          },
        },
      ],
    }),
  } as unknown as Response;
}

/** The curated shape recentlyPlayed200() maps to. */
const LAST_PLAYED = {
  track: {
    title: "Last Song",
    artists: ["Last Artist"],
    album: "Last Album",
    art_url: "https://i.scdn.co/image/last",
    url: "https://open.spotify.com/track/last",
    progress_ms: null,
    duration_ms: 199000,
  },
  played_at: "2026-08-10T20:15:00.000Z",
};

/** Route the mock by URL so each Spotify endpoint is answered separately. */
function routeFetch(handlers: {
  token?: () => Response | Promise<Response>;
  nowPlaying?: () => Response | Promise<Response>;
  recentlyPlayed?: () => Response | Promise<Response>;
}): void {
  mockFetch.mockImplementation((url: string) => {
    if (url === SPOTIFY_TOKEN_URL) {
      return Promise.resolve(
        (handlers.token ?? (() => tokenResponse(ACCESS_TOKEN)))()
      );
    }
    if (url === SPOTIFY_NOW_PLAYING_URL) {
      return Promise.resolve((handlers.nowPlaying ?? nowPlaying200)());
    }
    if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
      return Promise.resolve(
        // Default: empty history — the idle payload simply has no last_played.
        (handlers.recentlyPlayed ?? (() => ({
          status: 200,
          ok: true,
          json: async () => ({ items: [] }),
        }) as unknown as Response))()
      );
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

beforeAll(() => {
  app.set("secrets", {
    node_env: "development",
    spotify_client_id: CONFIG.clientId,
    spotify_client_secret: CONFIG.clientSecret,
  });
});

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetSpotifyStateForTests();
});

afterEach(() => {
  // Undo any console spy a test installed (mockFetch is unaffected — it is a
  // standalone jest.fn, not a jest.spyOn mock).
  jest.restoreAllMocks();
});

describe("mapCurrentlyPlaying (§4.6 curated shape)", () => {
  it("maps a 200 body to the curated track shape", () => {
    const payload = mapCurrentlyPlaying({
      progress_ms: 83000,
      item: {
        name: "Some Song",
        duration_ms: 214000,
        artists: [{ name: "Artist One" }, { name: "Artist Two" }],
        album: { name: "Some Album", images: [{ url: "https://i.scdn.co/image/abc" }] },
        external_urls: { spotify: "https://open.spotify.com/track/xyz" },
      },
    });
    expect(payload).toEqual({
      playing: true,
      track: {
        title: "Some Song",
        artists: ["Artist One", "Artist Two"],
        album: "Some Album",
        art_url: "https://i.scdn.co/image/abc",
        url: "https://open.spotify.com/track/xyz",
        progress_ms: 83000,
        duration_ms: 214000,
      },
    });
  });

  it("degrades to idle when the 200 body carries no item (ad / private session)", () => {
    expect(mapCurrentlyPlaying({ item: null })).toEqual({ playing: false });
  });
});

describe("getNowPlaying (§4.6)", () => {
  it("exchanges the refresh token then returns the curated playing shape", async () => {
    routeFetch({});

    const payload = await getNowPlaying(CONFIG);

    expect(payload).toEqual({
      playing: true,
      track: {
        title: "Some Song",
        artists: ["Artist One", "Artist Two"],
        album: "Some Album",
        art_url: "https://i.scdn.co/image/abc",
        url: "https://open.spotify.com/track/xyz",
        progress_ms: 83000,
        duration_ms: 214000,
      },
    });

    // The token endpoint was called with Basic auth + a refresh_token grant.
    const tokenCall = mockFetch.mock.calls.find(
      (c) => c[0] === SPOTIFY_TOKEN_URL
    );
    expect(tokenCall).toBeDefined();
    const init = tokenCall![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toMatch(
      /^Basic /
    );
    expect(String(init.body)).toContain("grant_type=refresh_token");
  });

  it("maps 204 (nothing playing) to { playing: false } — a normal response", async () => {
    routeFetch({ nowPlaying: () => statusResponse(204) });

    const payload = await getNowPlaying(CONFIG);

    expect(payload).toEqual({ playing: false });
  });

  it("on 401 refreshes the token and retries once (§4.6)", async () => {
    let npCall = 0;
    let tokenCall = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        tokenCall += 1;
        return Promise.resolve(
          tokenResponse(tokenCall === 1 ? ACCESS_TOKEN : ACCESS_TOKEN_2)
        );
      }
      // First currently-playing call 401s, the retry (with a fresh token) 200s.
      npCall += 1;
      return Promise.resolve(npCall === 1 ? statusResponse(401) : nowPlaying200());
    });

    const payload = await getNowPlaying(CONFIG);

    expect(tokenCall).toBe(2); // initial exchange + forced refresh on 401
    expect(npCall).toBe(2); // original + retry
    expect(payload).toMatchObject({ playing: true });

    // The retry used the freshly-minted token, not the stale one.
    const retryCall = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
    )[1];
    const headers = (retryCall![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe(`Bearer ${ACCESS_TOKEN_2}`);
  });

  it("serves from the ~30s cache — upstream currently-playing called once within TTL", async () => {
    routeFetch({});

    await getNowPlaying(CONFIG);
    await getNowPlaying(CONFIG);

    const npCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
    );
    expect(npCalls).toHaveLength(1);
  });

  it("refreshes the access token after the ~1h expiry passes", async () => {
    jest.useFakeTimers();
    try {
      routeFetch({});

      await getNowPlaying(CONFIG);
      let tokenCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_TOKEN_URL
      );
      expect(tokenCalls).toHaveLength(1);

      // Past both the now-playing cache TTL and the token's ~1h lifetime.
      jest.advanceTimersByTime(3600 * 1000 + 1_000);

      await getNowPlaying(CONFIG);
      tokenCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_TOKEN_URL
      );
      expect(tokenCalls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("reuses the in-memory token across cache-expiring calls while still valid", async () => {
    jest.useFakeTimers();
    try {
      routeFetch({});

      await getNowPlaying(CONFIG);
      // Past the now-playing cache TTL but well within the token lifetime.
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      await getNowPlaying(CONFIG);

      const tokenCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_TOKEN_URL
      );
      const npCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
      );
      expect(tokenCalls).toHaveLength(1); // token reused
      expect(npCalls).toHaveLength(2); // cache expired → refetched
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("last-played fallback when idle", () => {
  it("mapRecentlyPlayed maps items[0] to the curated shape", () => {
    expect(
      mapRecentlyPlayed({
        items: [
          {
            played_at: "2026-08-10T20:15:00.000Z",
            track: {
              name: "Last Song",
              duration_ms: 199000,
              artists: [{ name: "Last Artist" }],
              album: {
                name: "Last Album",
                images: [{ url: "https://i.scdn.co/image/last" }],
              },
              external_urls: { spotify: "https://open.spotify.com/track/last" },
            },
          },
        ],
      })
    ).toEqual(LAST_PLAYED);
  });

  it("mapRecentlyPlayed degrades to null on empty/malformed bodies", () => {
    expect(mapRecentlyPlayed(null)).toBeNull();
    expect(mapRecentlyPlayed({})).toBeNull();
    expect(mapRecentlyPlayed({ items: [] })).toBeNull();
    expect(mapRecentlyPlayed({ items: [{ played_at: "x", track: null }] })).toBeNull();
  });

  it("204 idle carries last_played when recently-played answers", async () => {
    routeFetch({
      nowPlaying: () => statusResponse(204),
      recentlyPlayed: recentlyPlayed200,
    });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false, last_played: LAST_PLAYED });
  });

  it("200-with-no-item (ad/private session) idle also carries last_played", async () => {
    routeFetch({
      nowPlaying: () =>
        ({
          status: 200,
          ok: true,
          json: async () => ({ item: null }),
        }) as unknown as Response,
      recentlyPlayed: recentlyPlayed200,
    });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false, last_played: LAST_PLAYED });
  });

  it("a 403 (token lacks the scope) yields plain idle — fallback off, no error", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    routeFetch({
      nowPlaying: () => statusResponse(204),
      recentlyPlayed: () => statusResponse(403),
    });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false });
  });

  it("a recently-played failure yields plain idle, never a rejection", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL)
        return Promise.resolve(tokenResponse(ACCESS_TOKEN));
      if (url === SPOTIFY_NOW_PLAYING_URL)
        return Promise.resolve(statusResponse(204));
      return Promise.reject(new Error("ETIMEDOUT"));
    });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false });
  });

  it("(task #119) recently-played is called ONLY once across two consecutive idle fetches", async () => {
    // Cache is empty on the first idle - one recently-played call. Second
    // idle call reuses the cached last_played instead of hammering Spotify.
    routeFetch({
      nowPlaying: () => statusResponse(204),
      recentlyPlayed: recentlyPlayed200,
    });

    const first = await getNowPlaying(CONFIG);
    // Advance past the outer now-playing cache TTL so the second call
    // re-enters fetchNowPlaying (otherwise the idle path is short-circuited
    // by the 5s cache before it can touch recently-played at all).
    jest.useFakeTimers();
    try {
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      const second = await getNowPlaying(CONFIG);
      expect(first).toEqual({ playing: false, last_played: LAST_PLAYED });
      expect(second).toEqual({ playing: false, last_played: LAST_PLAYED });
      const rpCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
      );
      expect(rpCalls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("(task #119) a playing-to-idle transition refetches recently-played once", async () => {
    let np = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(tokenResponse(ACCESS_TOKEN));
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) {
        np += 1;
        // First call: playing. Second call: idle (204). Third call: still
        // idle.
        return Promise.resolve(np === 1 ? nowPlaying200() : statusResponse(204));
      }
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve(recentlyPlayed200());
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });

    jest.useFakeTimers();
    try {
      // Tick 1: playing. No recently-played call.
      await getNowPlaying(CONFIG);
      let rpCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
      ).length;
      expect(rpCalls).toBe(0);

      // Tick 2 (past outer cache): playing-to-idle transition. One
      // recently-played call.
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      await getNowPlaying(CONFIG);
      rpCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
      ).length;
      expect(rpCalls).toBe(1);

      // Tick 3 (past outer cache): still idle, cache is fresh -> no new call.
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      await getNowPlaying(CONFIG);
      rpCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
      ).length;
      expect(rpCalls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("(task #119) after 10 minutes of continuous idle, recently-played refreshes exactly once", async () => {
    routeFetch({
      nowPlaying: () => statusResponse(204),
      recentlyPlayed: recentlyPlayed200,
    });

    jest.useFakeTimers();
    try {
      // First idle fetch primes the cache with one recently-played call.
      await getNowPlaying(CONFIG);
      let rpCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
      ).length;
      expect(rpCalls).toBe(1);

      // Simulate an hour of one-per-minute idle polls. Each call is past
      // the outer now-playing cache TTL. Recently-played must be called
      // ONLY on the 10-minute boundaries (i.e. at ~600s and ~1200s and so
      // on), never on every idle tick.
      for (let elapsed = 60_000; elapsed <= 60 * 60_000; elapsed += 60_000) {
        jest.advanceTimersByTime(60_000);
        await getNowPlaying(CONFIG);
      }
      rpCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
      ).length;
      // 60-minute run at 10-minute floor = at most 7 refresh calls
      // (the initial + one per subsequent 10-minute boundary crossed).
      // Concretely: 1 (initial) + 6 (10, 20, 30, 40, 50, 60 minute marks) = 7.
      expect(rpCalls).toBeLessThanOrEqual(7);
    } finally {
      jest.useRealTimers();
    }
  });

  it("GET /api/now-playing serves the durable last-known idle payload and NO token", async () => {
    // Listener-only: the router serves whatever the DB last-known store holds
    // and never calls Spotify.
    mockGetLastNowPlaying.mockResolvedValueOnce({
      playing: false,
      last_played: LAST_PLAYED,
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false, last_played: LAST_PLAYED });
    expect(mockFetch).not.toHaveBeenCalled();

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(CONFIG.refreshToken);
    expect(raw).not.toContain(CONFIG.clientSecret);
  });
});

describe("getNowPlaying degradation (§4.6 never a 5xx)", () => {
  it("returns { playing: false } when the token refresh fails (revoked token)", async () => {
    routeFetch({ token: () => statusResponse(400) });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false });
  });

  it("returns { playing: false } on a Spotify 5xx", async () => {
    routeFetch({ nowPlaying: () => statusResponse(500) });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false });
  });

  it("returns { playing: false } when the network call rejects", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse(ACCESS_TOKEN));
      return Promise.reject(new Error("ETIMEDOUT"));
    });

    const payload = await getNowPlaying(CONFIG);
    expect(payload).toEqual({ playing: false });
  });

  it("returns { playing: false } when credentials are unconfigured", async () => {
    const payload = await getNowPlaying({
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    });
    expect(payload).toEqual({ playing: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/now-playing — public, listener-only, never leaks a token, never 5xx", () => {
  it("serves the durable last-known playing payload and NEVER calls Spotify", async () => {
    const track = {
      title: "Some Song",
      artists: ["Artist One", "Artist Two"],
      album: "Some Album",
      art_url: "https://i.scdn.co/image/abc",
      url: "https://open.spotify.com/track/xyz",
      progress_ms: 83000,
      duration_ms: 214000,
    };
    mockGetLastNowPlaying.mockResolvedValueOnce({ playing: true, track });

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: true, track });
    // The request path must never touch Spotify.
    expect(mockFetch).not.toHaveBeenCalled();

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(CONFIG.refreshToken);
    expect(raw).not.toContain(CONFIG.clientSecret);
  });

  it("returns 200 { playing: false } (not a 5xx) when there is no last-known payload", async () => {
    mockGetLastNowPlaying.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("Spotify 429 rate-limit backoff (task #90)", () => {
  it("a 429 with Retry-After stops all Spotify calls until the deadline", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      routeFetch({ nowPlaying: () => rateLimited429(120) });

      // First call trips the backoff.
      await getNowPlaying(CONFIG);
      expect(isSpotifyRateLimited()).toBe(true);

      const npCallsAfterFirst = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
      ).length;
      expect(npCallsAfterFirst).toBe(1);

      // Advance past the now-playing cache but WELL before the Retry-After
      // deadline — the second call must NOT hit Spotify (skips upstream).
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      await getNowPlaying(CONFIG);
      await getNowPlaying(CONFIG);

      const npCallsMid = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
      ).length;
      expect(npCallsMid).toBe(1);
      expect(isSpotifyRateLimited()).toBe(true);

      // Cross the deadline; the very next call is allowed through.
      jest.advanceTimersByTime(120 * 1000 + 1_000);
      expect(isSpotifyRateLimited()).toBe(false);
      // Swap the fetch to return 200 so backoff resets on success.
      routeFetch({});
      await getNowPlaying(CONFIG);

      const npCallsAfterDeadline = mockFetch.mock.calls.filter(
        (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
      ).length;
      expect(npCallsAfterDeadline).toBeGreaterThan(1);
      expect(isSpotifyRateLimited()).toBe(false);

      // Enter + leave = exactly one warn line each.
      const enterLogs = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("suspending Spotify fetches")
      );
      const leaveLogs = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("cleared; resuming")
      );
      expect(enterLogs.length).toBe(1);
      expect(leaveLogs.length).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a 429 without Retry-After produces exponential backoff, 60s initial, 15m cap", async () => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Each cache miss returns a header-less 429; the schedule doubles.
      routeFetch({ nowPlaying: () => rateLimited429() });

      // 1st 429: 60s.
      await getNowPlaying(CONFIG);
      expect(isSpotifyRateLimited(Date.now() + SPOTIFY_BACKOFF_INITIAL_MS - 1_000)).toBe(true);
      expect(isSpotifyRateLimited(Date.now() + SPOTIFY_BACKOFF_INITIAL_MS + 1_000)).toBe(false);

      // Step past the window and hit again — schedule doubles to 120s.
      jest.advanceTimersByTime(SPOTIFY_BACKOFF_INITIAL_MS + 1_000);
      await getNowPlaying(CONFIG);
      expect(isSpotifyRateLimited(Date.now() + 2 * SPOTIFY_BACKOFF_INITIAL_MS - 1_000)).toBe(true);
      expect(isSpotifyRateLimited(Date.now() + 2 * SPOTIFY_BACKOFF_INITIAL_MS + 1_000)).toBe(false);

      // Advance many rounds — schedule must saturate at the 15m cap.
      for (let i = 0; i < 20; i++) {
        jest.advanceTimersByTime(SPOTIFY_BACKOFF_CAP_MS + 1_000);
        await getNowPlaying(CONFIG);
      }
      // The last window must be exactly SPOTIFY_BACKOFF_CAP_MS (or less).
      expect(isSpotifyRateLimited(Date.now() + SPOTIFY_BACKOFF_CAP_MS + 1_000)).toBe(false);
      expect(isSpotifyRateLimited(Date.now() + SPOTIFY_BACKOFF_CAP_MS - 1_000)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a 200 resets the backoff (streak clears on success)", async () => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let n = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url === SPOTIFY_TOKEN_URL) {
          return Promise.resolve(tokenResponse(ACCESS_TOKEN));
        }
        if (url === SPOTIFY_NOW_PLAYING_URL) {
          n += 1;
          // First call: header-less 429 (60s). Second: 200.
          return Promise.resolve(n === 1 ? rateLimited429() : nowPlaying200());
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      });

      // Trip a header-less 429 (60s).
      await getNowPlaying(CONFIG);
      expect(isSpotifyRateLimited()).toBe(true);

      // Advance past the deadline; the retry is a 200 → clears backoff AND streak.
      jest.advanceTimersByTime(SPOTIFY_BACKOFF_INITIAL_MS + 1_000);
      await getNowPlaying(CONFIG);
      expect(isSpotifyRateLimited()).toBe(false);

      // Cache miss + next 429 must start over at 60s, NOT keep doubling.
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      mockFetch.mockImplementation((url: string) => {
        if (url === SPOTIFY_TOKEN_URL) {
          return Promise.resolve(tokenResponse(ACCESS_TOKEN));
        }
        return Promise.resolve(rateLimited429());
      });
      await getNowPlaying(CONFIG);
      // 60s window (fresh streak), not 120s.
      expect(isSpotifyRateLimited(Date.now() + SPOTIFY_BACKOFF_INITIAL_MS - 1_000)).toBe(true);
      expect(isSpotifyRateLimited(Date.now() + SPOTIFY_BACKOFF_INITIAL_MS + 1_000)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("recently-played shares the same 429 budget as now-playing", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    // Idle response so we reach the recently-played path; recently-played 429s.
    routeFetch({
      nowPlaying: () => statusResponse(204),
      recentlyPlayed: () => rateLimited429(60),
    });

    await getNowPlaying(CONFIG);
    expect(isSpotifyRateLimited()).toBe(true);

    // Now that we're suspended, both endpoints must be skipped on the next call.
    mockFetch.mockClear();
    await getNowPlaying(CONFIG);
    // With the cache still fresh we don't even try — but even after a cache
    // miss the isSpotifyRateLimited() guard in fetchNowPlaying returns early.
    _resetSpotifyStateForTests.name; // silence unused-import lint if any
    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_NOW_PLAYING_URL)
    ).toHaveLength(0);
    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL)
    ).toHaveLength(0);
  });

  it("entering and leaving backoff each log exactly once (not per tick)", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      routeFetch({ nowPlaying: () => rateLimited429(30) });

      // Trip the backoff.
      await getNowPlaying(CONFIG);
      // Multiple further ticks while still suspended must not re-log entry.
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      await getNowPlaying(CONFIG);
      jest.advanceTimersByTime(NOW_PLAYING_CACHE_TTL_MS + 1_000);
      await getNowPlaying(CONFIG);

      // Cross deadline and succeed → one leave log.
      jest.advanceTimersByTime(30 * 1000 + 1_000);
      routeFetch({});
      await getNowPlaying(CONFIG);

      const enters = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("suspending Spotify fetches")
      );
      const leaves = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("cleared; resuming")
      );
      expect(enters.length).toBe(1);
      expect(leaves.length).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
