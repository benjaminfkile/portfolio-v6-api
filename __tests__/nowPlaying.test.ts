import request from "supertest";
import app from "../src/app";
import {
  getNowPlaying,
  mapCurrentlyPlaying,
  mapRecentlyPlayed,
  _resetSpotifyStateForTests,
  NOW_PLAYING_CACHE_TTL_MS,
  SPOTIFY_TOKEN_URL,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
  SpotifyConfig,
} from "../src/services/spotifyService";

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
    spotify_refresh_token: CONFIG.refreshToken,
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

  it("GET /api/now-playing idle response carries last_played and NO token", async () => {
    routeFetch({
      nowPlaying: () => statusResponse(204),
      recentlyPlayed: recentlyPlayed200,
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false, last_played: LAST_PLAYED });

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

describe("GET /api/now-playing (§4.6) — public, never leaks a token, never 5xx", () => {
  it("returns the curated playing shape and NO token anywhere in the response", async () => {
    routeFetch({});

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
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

    // Belt-and-braces: neither access token nor the refresh token appears anywhere.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(CONFIG.refreshToken);
    expect(raw).not.toContain(CONFIG.clientSecret);
  });

  it("returns 200 { playing: false } (not a 5xx) when Spotify is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
  });
});
