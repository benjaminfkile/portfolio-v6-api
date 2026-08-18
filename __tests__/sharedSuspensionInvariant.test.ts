/**
 * Task #96 — shared-Spotify-suspension invariant tests.
 *
 * Every acceptance criterion from the task description:
 *   - suspended leader still writes degraded snapshots every tick, so all
 *     instances serve byte-identical payloads during a Spotify outage;
 *   - missing snapshot key + Redis healthy → HTTP serves degraded WITHOUT any
 *     upstream fetch;
 *   - Redis-error path still lazy-fetches (never-5xx guarantee preserved);
 *   - a freshly-elected leader honors a persisted suspension without one
 *     Spotify call;
 *   - the suspension deadline elapsing resumes polling naturally;
 *   - deleting the suspension key forces an immediate retry on the next tick.
 */

import request from "supertest";
import app from "../src/app";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";
import {
  createSpotifyLane,
  DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
  SPOTIFY_AUTH_RESUME_CHECK_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
} from "../src/services/upstream/spotifyLane";
import {
  startPollLoop,
  _resetPollLoopStateForTests,
  type PollFetchers,
} from "../src/services/upstream/pollLoop";
import { createLeaderLease } from "../src/services/upstream/leaderLease";
import {
  readSpotifySuspension,
  writeSpotifySuspension,
  deleteSpotifySuspension,
  readSnapshot,
  spotifySuspensionKey,
  writeSnapshot,
  type SpotifySuspensionRecord,
} from "../src/services/upstream/snapshotStore";
import {
  _resetSpotifyStateForTests,
  isSpotifyAuthSuspended,
  suspendSpotifyAuth,
  resumeSpotifyAuth,
  getSpotifyBackoffUntilMs,
  applySpotifyBackoffUntil,
  SPOTIFY_TOKEN_URL,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
} from "../src/services/spotifyService";
import { _resetStatusCacheForTests } from "../src/services/statusService";
import { REALTIME_SERVICE_NAME } from "../src/services/upstream/realtimePublisher";

const ENV = "test";

const mockFetch = jest.fn();

function installUpstream(redis: FakeRedis | null): void {
  app.set("upstream", {
    enabled: redis != null,
    lease: null,
    loop: { stop: () => undefined, runTick: async () => undefined },
    redis,
    stop: async () => undefined,
  });
}

function tokenResponse(token: string): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ access_token: token, expires_in: 3600 }),
  } as unknown as Response;
}

function nowPlaying204(): Response {
  return {
    status: 204,
    ok: false,
    json: async () => ({}),
  } as unknown as Response;
}

function invalidGrant400(): Response {
  return {
    status: 400,
    ok: false,
    json: async () => ({ error: "invalid_grant" }),
  } as unknown as Response;
}

function healthResponse(degraded = false): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ degraded }),
  } as unknown as Response;
}

async function acquireLease(redis: FakeRedis) {
  const lease = createLeaderLease(redis, {
    key: `portfolio-v6-api:${ENV}:upstream-leader`,
    leaseTtlMs: 15_000,
    renewIntervalMs: 5_000,
  });
  expect(await lease.tryAcquire()).toBe(true);
  return lease;
}

function baseConfig() {
  return {
    env: ENV,
    pollIntervalMs: 10 * 60 * 60 * 1000, // driven manually via runTick
    slowLaneRefreshMs: 60_000,
    heartbeatIntervalMs: 30_000,
    publisher: {
      gatewayInternalUrl: "http://gateway:8080",
      realtimeToken: "SECRET",
      serviceName: REALTIME_SERVICE_NAME,
    },
  };
}

function buildFetchersWithLane(
  redis: FakeRedis,
  spotifyCalls: { calls: number }
): PollFetchers {
  const lane = createSpotifyLane(
    {
      isAuthSuspended: () => isSpotifyAuthSuspended(),
      getBackoffUntilMs: () => getSpotifyBackoffUntilMs(),
      applyAuthSuspension: (reason: string) => suspendSpotifyAuth(reason),
      applyBackoffUntil: (untilMs: number) =>
        applySpotifyBackoffUntil(untilMs),
      resumeAuth: () => resumeSpotifyAuth(),
      getStoredTokenUpdatedAt: async () => new Date(0),
      getPresenceCount: async () => 5, // active
      getLastPublicRequestAt: async () => null,
      readSharedSuspension: async () => readSpotifySuspension(redis, ENV),
      writeSharedSuspension: async (record) =>
        writeSpotifySuspension(redis, ENV, record),
      clearSharedSuspension: async () => deleteSpotifySuspension(redis, ENV),
    },
    {
      publicRequestWindowMs: SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
      presenceCacheMs: SPOTIFY_PRESENCE_CACHE_MS,
      authResumeCheckMs: SPOTIFY_AUTH_RESUME_CHECK_MS,
      idleIntervalMs: DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
    }
  );

  return {
    async nowPlaying() {
      spotifyCalls.calls += 1;
      const {
        getNowPlaying,
        isSpotifyRateLimited: rl,
        isSpotifyAuthSuspended: as,
      } =
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../src/services/spotifyService");
      if (rl() || as()) return null;
      try {
        return await getNowPlaying({
          clientId: "cid",
          clientSecret: "csec",
          refreshToken: "rt",
        });
      } catch {
        return null;
      }
    },
    async status() {
      const res = await fetch("http://gateway:8080/health");
      return res.json();
    },
    async duolingo() {
      return null;
    },
    async github() {
      return null;
    },
    spotifyLane: lane,
  };
}

beforeAll(() => {
  app.set("secrets", {
    node_env: ENV,
    spotify_client_id: "cid",
    spotify_client_secret: "sec",
    spotify_refresh_token: "rt",
    gateway_health_url: "http://gateway:8080/health",
  });
});

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetPollLoopStateForTests();
  _resetSpotifyStateForTests();
  _resetStatusCacheForTests();
  installUpstream(null);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  installUpstream(null);
});

// ----------------------------------------------------------------------------
// (368) — request path NEVER fetches Spotify when Redis is healthy
// ----------------------------------------------------------------------------
describe("acceptance #368 — request path never fetches Spotify (Redis healthy)", () => {
  it("serves degraded idle when the snapshot key is missing (zero upstream calls)", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    // Every fetch is a hard failure so we can prove none was made.
    mockFetch.mockImplementation(() => {
      throw new Error("no upstream should be called");
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });

    // Not one Spotify call escaped the request path.
    const spotifyCalls = mockFetch.mock.calls.filter(([url]) => {
      return (
        typeof url === "string" &&
        (url.includes("accounts.spotify.com") ||
          url.includes("api.spotify.com"))
      );
    });
    expect(spotifyCalls).toHaveLength(0);
  });

  it("serves the leader's degraded snapshot (byte-identical across instances)", async () => {
    // Prime what the leader wrote: a degraded payload during a Spotify outage.
    const redis = createFakeRedis();
    installUpstream(redis);
    await writeSnapshot(redis, ENV, "now-playing", {
      playing: false,
      last_played: null,
    });

    mockFetch.mockImplementation(() => {
      throw new Error("no upstream should be called");
    });

    const first = await request(app).get("/api/now-playing");
    const second = await request(app).get("/api/now-playing");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.text).toBe(second.text); // byte-identical
    expect(first.body).toEqual({ playing: false, last_played: null });
  });
});

// ----------------------------------------------------------------------------
// (369) — suspended leader writes degraded snapshot every tick
// ----------------------------------------------------------------------------
describe("acceptance #369 — suspended leader still writes snapshots every tick", () => {
  it("writes a degraded now-playing snapshot on every tick during a 429 suspension", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);
      // Pre-seed the suspension so the very first tick already skips (an
      // already-tripped 429 that hasn't cleared yet).
      await writeSpotifySuspension(redis, ENV, {
        suspended_until: new Date(60 * 60 * 1000).toISOString(),
        reason: "429",
        detail: "Retry-After 3600s",
      });

      // Also prime local backoff so the fetcher wrapper short-circuits if
      // for any reason the lane called it. Spotify calls must be 0.
      applySpotifyBackoffUntil(60 * 60 * 1000);

      // Any upstream fetch fails loudly.
      mockFetch.mockImplementation((url: string) => {
        if (url === "http://gateway:8080/health") {
          return Promise.resolve(healthResponse());
        }
        // Realtime publish endpoint — 200 stub.
        if (typeof url === "string" && url.includes("internal/publish")) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: async () => ({}),
            text: async () => "",
          } as unknown as Response);
        }
        throw new Error(`no upstream expected: ${url}`);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      const fetchers = buildFetchersWithLane(redis, spotifyCalls);
      const handle = startPollLoop(redis, lease, fetchers, baseConfig());

      // Fire 5 ticks; each one must write a degraded snapshot with a fresh
      // fetched_at, and Spotify must NEVER be called.
      const fetchedAtValues: string[] = [];
      for (let t = 0; t < 5; t += 1) {
        jest.setSystemTime(t * 5_000);
        await handle.runTick();
        const snap = await readSnapshot<{ playing: boolean }>(
          redis,
          ENV,
          "now-playing"
        );
        expect(snap).not.toBeNull();
        expect(snap!.payload).toEqual({ playing: false });
        fetchedAtValues.push(snap!.fetched_at);
      }

      // fetched_at advanced each tick — the snapshot really was rewritten.
      const unique = new Set(fetchedAtValues);
      expect(unique.size).toBe(5);
      // Zero Spotify calls.
      expect(spotifyCalls.calls).toBe(0);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("all instances read byte-identical payloads (no divergence)", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);
      await writeSpotifySuspension(redis, ENV, {
        suspended_until: new Date(60 * 60 * 1000).toISOString(),
        reason: "429",
        detail: "Retry-After 3600s",
      });
      applySpotifyBackoffUntil(60 * 60 * 1000);

      mockFetch.mockImplementation((url: string) => {
        if (url === "http://gateway:8080/health") {
          return Promise.resolve(healthResponse());
        }
        if (typeof url === "string" && url.includes("internal/publish")) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: async () => ({}),
            text: async () => "",
          } as unknown as Response);
        }
        throw new Error(`no upstream expected: ${url}`);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      const handle = startPollLoop(
        redis,
        lease,
        buildFetchersWithLane(redis, spotifyCalls),
        baseConfig()
      );

      jest.setSystemTime(1_000);
      await handle.runTick();

      // Two HTTP reads — both must see the SAME payload the leader wrote,
      // never diverge and never call Spotify.
      const [a, b] = await Promise.all([
        request(app).get("/api/now-playing"),
        request(app).get("/api/now-playing"),
      ]);
      expect(a.text).toBe(b.text);
      expect(a.body).toEqual({ playing: false });
      expect(spotifyCalls.calls).toBe(0);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ----------------------------------------------------------------------------
// (370) — suspension state lives in Redis (fresh leader honors it, delete = retry)
// ----------------------------------------------------------------------------
describe("acceptance #370 — suspension state persisted in Redis", () => {
  it("a fresh leader process honors a persisted suspension without one Spotify call", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);
      // Persist an auth suspension record BEFORE the leader boots — a
      // freshly-elected leader inherits a known suspension.
      await writeSpotifySuspension(redis, ENV, {
        suspended_until: new Date(24 * 60 * 60 * 1000).toISOString(),
        reason: "auth",
        detail: "invalid_grant on token refresh",
        captured_token_updated_at: new Date(1_000).toISOString(),
      });

      // The fresh process has NO local suspension flag set yet.
      expect(isSpotifyAuthSuspended()).toBe(false);
      expect(getSpotifyBackoffUntilMs()).toBe(0);

      mockFetch.mockImplementation((url: string) => {
        // If the leader called anything on Spotify (token or API), fail hard.
        if (
          typeof url === "string" &&
          (url.includes("accounts.spotify.com") ||
            url.includes("api.spotify.com"))
        ) {
          throw new Error(
            "fresh leader must NOT call Spotify to rediscover a known suspension"
          );
        }
        if (url === "http://gateway:8080/health") {
          return Promise.resolve(healthResponse());
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      const handle = startPollLoop(
        redis,
        lease,
        buildFetchersWithLane(redis, spotifyCalls),
        baseConfig()
      );

      // Run several ticks — Spotify must NEVER be called.
      for (let t = 0; t < 5; t += 1) {
        jest.setSystemTime(t * 5_000);
        await handle.runTick();
      }
      expect(spotifyCalls.calls).toBe(0);
      // The fresh leader mirrored the auth suspension into its local flag so
      // any HTTP fallback (Redis outage) also honors it.
      expect(isSpotifyAuthSuspended()).toBe(true);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("the suspension deadline elapsing lets the next tick fetch again (natural recovery)", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);
      // Suspension deadline is 5 seconds from now.
      await writeSpotifySuspension(redis, ENV, {
        suspended_until: new Date(5_000).toISOString(),
        reason: "429",
        detail: "Retry-After 5s",
      });
      applySpotifyBackoffUntil(5_000);

      let spotifyOk = false;
      mockFetch.mockImplementation((url: string) => {
        if (url === SPOTIFY_TOKEN_URL) {
          spotifyOk = true;
          return Promise.resolve(tokenResponse("tok"));
        }
        if (url === SPOTIFY_NOW_PLAYING_URL) {
          return Promise.resolve(nowPlaying204());
        }
        if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
          return Promise.resolve(nowPlaying204());
        }
        if (url === "http://gateway:8080/health") {
          return Promise.resolve(healthResponse());
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      const handle = startPollLoop(
        redis,
        lease,
        buildFetchersWithLane(redis, spotifyCalls),
        baseConfig()
      );

      // Tick 1 before the deadline — still suspended, no Spotify.
      jest.setSystemTime(1_000);
      await handle.runTick();
      expect(spotifyCalls.calls).toBe(0);

      // Tick 2 past the deadline — the lane fetches, Spotify answers.
      jest.setSystemTime(10_000);
      await handle.runTick();
      expect(spotifyCalls.calls).toBe(1);
      expect(spotifyOk).toBe(true);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("deleting the suspension key forces an immediate retry on the next tick (operator override)", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);
      // Long-deadline auth suspension — natural recovery is 24h away.
      await writeSpotifySuspension(redis, ENV, {
        suspended_until: new Date(24 * 60 * 60 * 1000).toISOString(),
        reason: "auth",
        detail: "invalid_grant on token refresh",
        captured_token_updated_at: new Date(1_000).toISOString(),
      });

      mockFetch.mockImplementation((url: string) => {
        if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
        if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(nowPlaying204());
        if (url === SPOTIFY_RECENTLY_PLAYED_URL) return Promise.resolve(nowPlaying204());
        if (url === "http://gateway:8080/health") return Promise.resolve(healthResponse());
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      const handle = startPollLoop(
        redis,
        lease,
        buildFetchersWithLane(redis, spotifyCalls),
        baseConfig()
      );

      // Tick 1 — suspension is active → no fetch.
      jest.setSystemTime(1_000);
      await handle.runTick();
      expect(spotifyCalls.calls).toBe(0);

      // Operator override: DEL the suspension key.
      await redis.del(spotifySuspensionKey(ENV));

      // Tick 2 — lane observes the key is gone → clears local state → fetches.
      jest.setSystemTime(2_000);
      await handle.runTick();
      expect(spotifyCalls.calls).toBe(1);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("reconcileAfterFetch writes the suspension after a fresh 429 (so other instances see it)", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);

      mockFetch.mockImplementation((url: string) => {
        if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
        if (url === SPOTIFY_NOW_PLAYING_URL) {
          return Promise.resolve({
            status: 429,
            ok: false,
            headers: {
              get: (n: string) =>
                n.toLowerCase() === "retry-after" ? "60" : null,
            },
            json: async () => ({}),
          } as unknown as Response);
        }
        if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
          return Promise.resolve({
            status: 429,
            ok: false,
            headers: {
              get: (n: string) =>
                n.toLowerCase() === "retry-after" ? "60" : null,
            },
            json: async () => ({}),
          } as unknown as Response);
        }
        if (url === "http://gateway:8080/health") return Promise.resolve(healthResponse());
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      const handle = startPollLoop(
        redis,
        lease,
        buildFetchersWithLane(redis, spotifyCalls),
        baseConfig()
      );

      // Tick 1 — fetcher runs, gets 429, reconcile writes shared record.
      jest.setSystemTime(1_000);
      await handle.runTick();

      const record = await readSpotifySuspension(redis, ENV);
      expect(record).not.toBeNull();
      expect(record!.reason).toBe("429");

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ----------------------------------------------------------------------------
// (371) — Redis-unconfigured and Redis-error paths keep never-5xx guarantee
// ----------------------------------------------------------------------------
describe("acceptance #371 — Redis-unconfigured and Redis-error paths preserve never-5xx", () => {
  it("with Redis UNCONFIGURED, request path still lazy-fetches Spotify", async () => {
    // upstream handle installed as null (Redis unconfigured).
    installUpstream(null);
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(nowPlaying204());
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ items: [] }),
        } as unknown as Response);
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
    // Spotify WAS called (legacy per-instance path).
    expect(
      mockFetch.mock.calls.some(([u]) => u === SPOTIFY_NOW_PLAYING_URL)
    ).toBe(true);
  });

  it("with Redis ERROR on read, request path falls back to lazy-fetch (not a 5xx)", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    // Prime a snapshot so a plain read would succeed, then queue an error
    // for the actual read call to simulate a transient Redis outage.
    await writeSnapshot(redis, ENV, "now-playing", { playing: false });
    redis.queueError(new Error("ECONNREFUSED"));

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(nowPlaying204());
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ items: [] }),
        } as unknown as Response);
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200); // never a 5xx
    expect(res.body).toEqual({ playing: false });
  });

  it("status endpoint mirrors the same guarantees (never-5xx across Redis states)", async () => {
    // Redis configured, snapshot missing → serve degraded, no gateway call.
    const redis = createFakeRedis();
    installUpstream(redis);
    mockFetch.mockImplementation((url: string) => {
      if (url === "http://gateway:8080/health") {
        throw new Error("request path must not call the gateway");
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ degraded: true, services: [] });
  });
});

// ----------------------------------------------------------------------------
// (372 sanity) — status lane also always-writes on failure
// ----------------------------------------------------------------------------
describe("status lane symmetry — always writes a snapshot even on failure", () => {
  it("writes a degraded status snapshot when the fetcher throws", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const redis = createFakeRedis();
      installUpstream(redis);
      // Gateway throws hard.
      mockFetch.mockImplementation((url: string) => {
        if (url === "http://gateway:8080/health") {
          return Promise.reject(new Error("ETIMEDOUT"));
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      });

      const spotifyCalls = { calls: 0 };
      const lease = await acquireLease(redis);
      // Use fetchers where the status fetcher itself throws (bypass the
      // service's internal try/catch by throwing directly).
      const fetchers = buildFetchersWithLane(redis, spotifyCalls);
      fetchers.status = async () => {
        throw new Error("boom");
      };
      const handle = startPollLoop(redis, lease, fetchers, baseConfig());

      jest.setSystemTime(0);
      await handle.runTick();

      const snap = await readSnapshot<{ degraded: boolean }>(
        redis,
        ENV,
        "status"
      );
      expect(snap).not.toBeNull();
      expect(snap!.payload).toEqual({ degraded: true, services: [] });

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ----------------------------------------------------------------------------
// (helpers) — sanity: writeSpotifySuspension + readSpotifySuspension round-trip
// ----------------------------------------------------------------------------
describe("suspension record round-trip", () => {
  it("writes and reads back an auth suspension record", async () => {
    const redis = createFakeRedis();
    const record: SpotifySuspensionRecord = {
      suspended_until: new Date(60 * 60 * 1000).toISOString(),
      reason: "auth",
      detail: "invalid_grant on token refresh",
      captured_token_updated_at: new Date(1_000).toISOString(),
    };
    await writeSpotifySuspension(redis, ENV, record);
    const back = await readSpotifySuspension(redis, ENV);
    expect(back).toEqual(record);
  });

  it("writes and reads back a 429 suspension record", async () => {
    const redis = createFakeRedis();
    const record: SpotifySuspensionRecord = {
      suspended_until: new Date(60_000).toISOString(),
      reason: "429",
      detail: "Retry-After 60s",
    };
    await writeSpotifySuspension(redis, ENV, record);
    const back = await readSpotifySuspension(redis, ENV);
    expect(back).toEqual(record);
  });

  it("deleteSpotifySuspension clears the key", async () => {
    const redis = createFakeRedis();
    await writeSpotifySuspension(redis, ENV, {
      suspended_until: new Date(60_000).toISOString(),
      reason: "429",
    });
    await deleteSpotifySuspension(redis, ENV);
    expect(await readSpotifySuspension(redis, ENV)).toBeNull();
  });

  it("read returns null on Redis error (fail open)", async () => {
    const redis = createFakeRedis();
    redis.queueError(new Error("network"));
    expect(await readSpotifySuspension(redis, ENV)).toBeNull();
  });
});

// Silence unused warnings — helpers imported for potential future use.
void suspendSpotifyAuth;
