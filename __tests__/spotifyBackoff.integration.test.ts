import type { Express } from "express";
import type { IAppSecrets } from "../src/interfaces";
import { buildFetchers } from "../src/services/upstream";
import {
  startPollLoop,
  _resetPollLoopStateForTests,
} from "../src/services/upstream/pollLoop";
import { createLeaderLease } from "../src/services/upstream/leaderLease";
import {
  _resetSpotifyStateForTests,
  isSpotifyRateLimited,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
  SPOTIFY_TOKEN_URL,
} from "../src/services/spotifyService";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";
import { REALTIME_SERVICE_NAME } from "../src/services/upstream/realtimePublisher";

// Task #112 killed the static `spotify_refresh_token` secret fallback — the
// grant now comes exclusively from the encrypted service_tokens table. This
// suite has no database (unit-style integration), so we stub the store's
// read to inject a working refresh token; the fetcher then behaves exactly
// as it does in production against a real reconnected admin.
jest.mock("../src/services/spotifyTokenStore", () => {
  const actual = jest.requireActual("../src/services/spotifyTokenStore");
  return {
    ...actual,
    getStoredSpotifyToken: jest.fn().mockResolvedValue({
      refreshToken: "rt",
      authorizedAt: new Date(0),
    }),
    rotateSpotifyRefreshToken: jest.fn().mockResolvedValue(true),
  };
});

/**
 * Integration test for Spotify 429 backoff (task #90).
 *
 * Verifies the end-to-end wrapper behavior: when Spotify returns 429, the
 * poll-loop `nowPlaying` fetcher wrapper starts returning null (so the shared
 * snapshot is preserved), the recently-played enrichment also stops firing,
 * and the OTHER lanes (status/duolingo/github) keep polling on every tick.
 */

const ENV = "development";

function fakeApp(secrets: Partial<IAppSecrets>): Express {
  const store: Record<string, unknown> = {};
  return {
    set(key: string, value: unknown) {
      store[key] = value;
    },
    get(key: string) {
      if (key === "secrets") return secrets;
      return store[key];
    },
  } as unknown as Express;
}

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

function tokenResponse(token: string): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ access_token: token, expires_in: 3600 }),
  } as unknown as Response;
}

const mockFetch = jest.fn();

async function acquireLease(redis: FakeRedis) {
  const lease = createLeaderLease(redis, {
    key: `portfolio-v6-api:${ENV}:upstream-leader`,
    leaseTtlMs: 15_000,
    renewIntervalMs: 5_000,
  });
  expect(await lease.tryAcquire()).toBe(true);
  return lease;
}

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetSpotifyStateForTests();
  _resetPollLoopStateForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("Spotify 429 backoff — poll-loop integration (task #90)", () => {
  it("non-Spotify lanes keep polling during a Spotify suspension", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    const app = fakeApp({
      node_env: ENV,
      spotify_client_id: "cid",
      spotify_client_secret: "csec",
      gateway_health_url: "http://gateway:8080/health",
    });

    // Route Spotify to 429; every other URL (status/duolingo/github) returns
    // a benign 200 so their fetchers succeed and count each call.
    let statusHits = 0;
    let duolingoHits = 0;
    let githubHits = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(rateLimited429(120));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) return Promise.resolve(rateLimited429(120));
      if (url === "http://gateway:8080/health") {
        statusHits += 1;
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ degraded: false }),
        } as unknown as Response);
      }
      if (typeof url === "string" && url.includes("duolingo")) {
        duolingoHits += 1;
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ users: [{ courses: [] }] }),
        } as unknown as Response);
      }
      if (typeof url === "string" && url.includes("api.github.com")) {
        githubHits += 1;
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
        } as unknown as Response);
      }
      // Realtime publish endpoint — always 200.
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response);
    });

    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    // Wrap the real fetchers with spies so we can assert they were called even
    // when they short-circuit internally (e.g. duolingo/github return
    // UNAVAILABLE without hitting the network when no token is configured).
    const real = buildFetchers(app);
    const fetchers = {
      nowPlaying: jest.fn(real.nowPlaying),
      status: jest.fn(real.status),
      duolingo: jest.fn(real.duolingo),
      github: jest.fn(real.github),
    };

    const handle = startPollLoop(redis, lease, fetchers, {
      env: ENV,
      pollIntervalMs: 5_000,
      slowLaneRefreshMs: 60_000,
      heartbeatIntervalMs: 30_000,
      publisher: {
        gatewayInternalUrl: "http://gateway:8080",
        realtimeToken: "SECRET",
        serviceName: REALTIME_SERVICE_NAME,
      },
    });

    // Tick 1: trips the backoff via the now-playing 429; status/duolingo/github
    // fetchers still ran (slow lane fires on tick 1 because deadline starts at 0).
    await handle.runTick();
    expect(isSpotifyRateLimited()).toBe(true);
    expect(fetchers.nowPlaying).toHaveBeenCalledTimes(1);
    expect(fetchers.status).toHaveBeenCalledTimes(1);
    expect(fetchers.duolingo).toHaveBeenCalledTimes(1);
    expect(fetchers.github).toHaveBeenCalledTimes(1);
    expect(statusHits).toBe(1);

    // Subsequent ticks: nowPlaying wrapper short-circuits (returns null), so
    // NO Spotify network calls fire — but status keeps polling every tick.
    const npCallsAfterTrip = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
    ).length;
    const rpCallsAfterTrip = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL
    ).length;

    await handle.runTick();
    await handle.runTick();
    await handle.runTick();

    // The wrapper is invoked each tick but returns null without hitting Spotify.
    expect(fetchers.nowPlaying).toHaveBeenCalledTimes(4);
    // No new Spotify network calls fired.
    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_NOW_PLAYING_URL)
        .length
    ).toBe(npCallsAfterTrip);
    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_RECENTLY_PLAYED_URL)
        .length
    ).toBe(rpCallsAfterTrip);
    // Status kept polling every tick (its own 30s in-memory cache means the
    // upstream hit count is lower, but the fetcher — the poll-loop entry
    // point — ran on every tick, which is the acceptance criterion).
    expect(fetchers.status).toHaveBeenCalledTimes(4);
    expect(statusHits).toBeGreaterThanOrEqual(1);
    // Slow lanes were only supposed to fire once (deadline still ahead).
    expect(fetchers.duolingo).toHaveBeenCalledTimes(1);
    expect(fetchers.github).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});
