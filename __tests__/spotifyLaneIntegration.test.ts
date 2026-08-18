/**
 * End-to-end integration test for task #95 — the Spotify lane, wired into the
 * leader poll loop, using the real spotifyService state (auth suspension,
 * 429 backoff) and a fake Redis. Presence + service_tokens.updated_at are
 * still injected fakes: the goal is to prove the lane orchestrates the real
 * pieces correctly, not to boot Postgres or the gateway.
 *
 * Covers every acceptance criterion from the task:
 *   - invalid_grant → all Spotify traffic (API + token endpoint) stops.
 *   - Changed service_tokens.updated_at resumes within one throttle window.
 *   - With no viewers, Spotify is polled at most every 5 minutes.
 *   - A viewer appearing switches to fast cadence with an immediate poll.
 *   - Presence-API failure counts as active (fail open).
 *   - status/duolingo/github lanes untouched throughout.
 *   - 429 Retry-After backoff still honored in both cadences.
 */

import {
  startPollLoop,
  _resetPollLoopStateForTests,
  type PollFetchers,
  type PollLoopHandle,
} from "../src/services/upstream/pollLoop";
import { createLeaderLease } from "../src/services/upstream/leaderLease";
import {
  createSpotifyLane,
  DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
  SPOTIFY_AUTH_RESUME_CHECK_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
} from "../src/services/upstream/spotifyLane";
import {
  _resetSpotifyStateForTests,
  isSpotifyAuthSuspended,
  isSpotifyRateLimited,
  suspendSpotifyAuth,
  resumeSpotifyAuth,
  getSpotifyBackoffUntilMs,
  applySpotifyBackoffUntil,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
  SPOTIFY_TOKEN_URL,
} from "../src/services/spotifyService";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";
import {
  readSpotifySuspension,
  writeSpotifySuspension,
  deleteSpotifySuspension,
} from "../src/services/upstream/snapshotStore";
import { REALTIME_SERVICE_NAME } from "../src/services/upstream/realtimePublisher";

const ENV = "development";

const mockFetch = jest.fn();

function invalidGrant400(): Response {
  return {
    status: 400,
    ok: false,
    json: async () => ({ error: "invalid_grant" }),
  } as unknown as Response;
}

function rateLimited429(retryAfterSec?: number): Response {
  const headers = new Map<string, string>();
  if (retryAfterSec != null) {
    headers.set("retry-after", String(retryAfterSec));
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

function nowPlaying204(): Response {
  return {
    status: 204,
    ok: false,
    json: async () => ({}),
  } as unknown as Response;
}

function healthResponse(): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ degraded: false }),
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

/**
 * Track "wall clock" for the lane and callers. Jest's fake timers move
 * `Date.now()` when timers advance; using the real timer facility here would
 * open floods of unbound setInterval fires. Instead we set the poll loop
 * interval very high, drive ticks manually via `handle.runTick`, and pass an
 * explicit `now` into every planTick that the lane cares about — the lane
 * itself already accepts `now` as a param so tests can be deterministic.
 */
function buildFetchersWithLane(
  laneDeps: {
    isAuthSuspended?: () => boolean;
    getStoredTokenUpdatedAt?: () => Promise<Date | null>;
    resumeAuth?: () => void;
    getPresenceCount?: () => Promise<number>;
    getLastPublicRequestAt?: () => Promise<Date | null>;
  },
  spotifyCallCounter: { calls: number },
  redis: FakeRedis,
  env: string = ENV,
  idleIntervalMs = DEFAULT_SPOTIFY_IDLE_INTERVAL_MS
): PollFetchers {
  const lane = createSpotifyLane(
    {
      isAuthSuspended: laneDeps.isAuthSuspended ?? isSpotifyAuthSuspended,
      getBackoffUntilMs: getSpotifyBackoffUntilMs,
      applyAuthSuspension: (reason: string) => suspendSpotifyAuth(reason),
      applyBackoffUntil: applySpotifyBackoffUntil,
      resumeAuth: laneDeps.resumeAuth ?? resumeSpotifyAuth,
      getStoredTokenUpdatedAt:
        laneDeps.getStoredTokenUpdatedAt ?? (async () => null),
      getPresenceCount: laneDeps.getPresenceCount ?? (async () => 0),
      getLastPublicRequestAt:
        laneDeps.getLastPublicRequestAt ?? (async () => null),
      readSharedSuspension: async () => readSpotifySuspension(redis, env),
      writeSharedSuspension: async (record) =>
        writeSpotifySuspension(redis, env, record),
      clearSharedSuspension: async () => deleteSpotifySuspension(redis, env),
    },
    {
      publicRequestWindowMs: SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
      presenceCacheMs: SPOTIFY_PRESENCE_CACHE_MS,
      authResumeCheckMs: SPOTIFY_AUTH_RESUME_CHECK_MS,
      idleIntervalMs,
    }
  );

  return {
    async nowPlaying() {
      spotifyCallCounter.calls += 1;
      // Real spotify path — hits the mocked fetch. Returns null on 429 or
      // auth-suspended so the loop preserves the last-good snapshot.
      const { getNowPlaying, isSpotifyRateLimited: rl, isSpotifyAuthSuspended: as } =
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
      // Simulates the real statusService's single-fetch — every tick pings the
      // health URL so we can assert non-Spotify lanes stay on the fast cadence.
      const res = await fetch("http://gateway:8080/health");
      const body = await res.json();
      return body;
    },
    async duolingo() {
      const res = await fetch("http://duolingo.example/api");
      return res.json();
    },
    async github() {
      const res = await fetch("http://api.github.com/users/x");
      return res.json();
    },
    spotifyLane: lane,
  };
}

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetPollLoopStateForTests();
  _resetSpotifyStateForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function baseConfig() {
  return {
    env: ENV,
    // Ridiculously high — we never let the underlying interval fire; every
    // tick is driven via `handle.runTick` so the test controls timing.
    pollIntervalMs: 10 * 60 * 60 * 1000,
    slowLaneRefreshMs: 60_000,
    heartbeatIntervalMs: 30_000,
    publisher: {
      gatewayInternalUrl: "http://gateway:8080",
      realtimeToken: "SECRET",
      serviceName: REALTIME_SERVICE_NAME,
    },
  };
}

/**
 * The lane calls `planTick(Date.now())`; jest fake timers let us move Date.now
 * so the lane's idle deadlines and throttle windows tick past deterministically.
 */
function useFakeClock() {
  jest.useFakeTimers({ now: 0 });
}

describe("integration — auth suspension", () => {
  it("invalid_grant stops ALL Spotify traffic including token retries", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(invalidGrant400());
      if (url === "http://gateway:8080/health") return Promise.resolve(healthResponse());
      // Any duolingo/github/publish/etc URL — 200 stub.
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response);
    });

    const spotifyCalls = { calls: 0 };
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    // Presence > 0 so the lane WOULD normally poll every tick — this proves the
    // suspension gate short-circuits the viewer-aware cadence too.
    const fetchers = buildFetchersWithLane(
      { getPresenceCount: async () => 5 },
      spotifyCalls,
      redis
    );

    const handle: PollLoopHandle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Tick 1: fetcher fires, real spotifyService hits the token endpoint which
    // returns 400 invalid_grant → suspension kicks in.
    await handle.runTick();
    expect(isSpotifyAuthSuspended()).toBe(true);
    // The token endpoint got hit exactly once so far.
    const tokenCallsAfterTrip = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_TOKEN_URL
    ).length;
    expect(tokenCallsAfterTrip).toBe(1);

    // Advance well past 100 ticks. All should skip — no fetcher call, no
    // token retry, nothing. The lane never re-invokes the fetcher because
    // planTick returns "skip-suspended" every time.
    for (let i = 0; i < 100; i += 1) {
      jest.setSystemTime(1_000 + i * 5_000); // 5s apart
      await handle.runTick();
    }

    // Fetcher was NOT called again (spotifyCalls stays at 1 from tick 1).
    expect(spotifyCalls.calls).toBe(1);
    // Token endpoint was NOT hit a second time.
    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_TOKEN_URL).length
    ).toBe(1);
    // Non-Spotify lanes kept polling every tick — assert on the health URL,
    // which is the fast lane's actual network call.
    const healthCallCount = mockFetch.mock.calls.filter(
      (c) => c[0] === "http://gateway:8080/health"
    ).length;
    expect(healthCallCount).toBeGreaterThanOrEqual(50);

    handle.stop();
  });

  it("resumes within one throttle window when service_tokens.updated_at changes", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    let storedUpdatedAt: Date | null = new Date(1_000);
    let tokenBehavior: "fail" | "ok" = "fail";
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(
          tokenBehavior === "fail" ? invalidGrant400() : tokenResponse("tok-new")
        );
      }
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
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      {
        getPresenceCount: async () => 3, // active
        getStoredTokenUpdatedAt: async () => storedUpdatedAt,
      },
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Tick 1 at t=0: lane not-yet-suspended, so calls the fetcher, which
    // trips suspension via the 400 invalid_grant on the token endpoint.
    await handle.runTick();
    expect(isSpotifyAuthSuspended()).toBe(true);
    expect(spotifyCalls.calls).toBe(1);

    // Tick 2 at t=1: lane observes suspension, captures snapshot=Date(1_000)
    // and sets lastResumeCheckAt=1.
    jest.setSystemTime(1);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(1);

    // Ticks inside the throttle window stay suspended without re-reading DB.
    jest.setSystemTime(30_000);
    await handle.runTick();
    jest.setSystemTime(50_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(1);
    expect(isSpotifyAuthSuspended()).toBe(true);

    // Admin reconnects: updated_at bumps AND token endpoint would now succeed.
    storedUpdatedAt = new Date(60_000);
    tokenBehavior = "ok";

    // Advance past the throttle window (lastResumeCheckAt=1, so next allowed
    // recheck is at 1 + 60_000 = 60_001). Lane rereads updated_at, detects
    // change, clears suspension, and forces an immediate fetch.
    jest.setSystemTime(SPOTIFY_AUTH_RESUME_CHECK_MS + 500);
    await handle.runTick();

    expect(isSpotifyAuthSuspended()).toBe(false);
    expect(spotifyCalls.calls).toBe(2); // fetched immediately on resume

    handle.stop();
  });
});

describe("integration — viewer-aware cadence", () => {
  it("idles at 5-minute cadence with zero calls between", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

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
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      {
        getPresenceCount: async () => 0, // idle
        getLastPublicRequestAt: async () => null,
      },
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Fire every 5s for 4:30 (270 seconds).
    for (let t = 0; t <= 270_000; t += 5_000) {
      jest.setSystemTime(t);
      await handle.runTick();
    }
    // Only the very first tick (nextDueAt=0) called Spotify.
    expect(spotifyCalls.calls).toBe(1);

    // Just past the 5-minute deadline — one more poll.
    jest.setSystemTime(DEFAULT_SPOTIFY_IDLE_INTERVAL_MS + 1_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(2);

    // Continue for another 4:30 idle window — still exactly 2 calls.
    for (
      let t = DEFAULT_SPOTIFY_IDLE_INTERVAL_MS + 5_000;
      t <= DEFAULT_SPOTIFY_IDLE_INTERVAL_MS + 270_000;
      t += 5_000
    ) {
      jest.setSystemTime(t);
      await handle.runTick();
    }
    expect(spotifyCalls.calls).toBe(2);

    handle.stop();
  });

  it("a viewer appearing (presence > 0) restores fast cadence with immediate poll", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    let presence = 0;
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
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      { getPresenceCount: async () => presence },
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // First tick idle — polls once (nextDueAt=0), then goes quiet. The
    // presence cache TTL is armed at this tick and expires at t=30_000.
    jest.setSystemTime(0);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(1);

    // A viewer appears. Advance past the presence cache TTL so the lane
    // re-reads and observes presence>0. Immediate fetch on idle→active.
    presence = 1;
    jest.setSystemTime(SPOTIFY_PRESENCE_CACHE_MS + 1_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(2);

    // Continues on fast cadence — every tick calls Spotify.
    jest.setSystemTime(SPOTIFY_PRESENCE_CACHE_MS + 6_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(3);

    handle.stop();
  });

  it("a recent public /api/now-playing request also restores fast cadence", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    let lastRequest: Date | null = null;
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
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      {
        getPresenceCount: async () => 0,
        getLastPublicRequestAt: async () => lastRequest,
      },
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Idle first tick.
    await handle.runTick();
    jest.setSystemTime(30_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(1);

    // Someone hits GET /api/now-playing — stamps last-request-at.
    lastRequest = new Date(45_000);
    jest.setSystemTime(46_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(2);

    handle.stop();
  });

  it("presence-API failure counts as active (fail open)", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

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
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      {
        getPresenceCount: async () => {
          throw new Error("gateway 500");
        },
      },
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Every tick polls — presence throw is treated as active.
    await handle.runTick();
    jest.setSystemTime(5_000);
    await handle.runTick();
    jest.setSystemTime(10_000);
    await handle.runTick();
    expect(spotifyCalls.calls).toBe(3);

    handle.stop();
  });
});

describe("integration — 429 backoff preserved in both cadences", () => {
  it("Retry-After suspends Spotify even while the lane is active", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(rateLimited429(3600));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) return Promise.resolve(rateLimited429(3600));
      if (url === "http://gateway:8080/health") return Promise.resolve(healthResponse());
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response);
    });

    const spotifyCalls = { calls: 0 };
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      { getPresenceCount: async () => 5 }, // active
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Tick 1: Spotify 429 trips the backoff — fetcher runs, hits 429,
    // reconcileAfterFetch writes the shared 429 suspension record.
    await handle.runTick();
    expect(isSpotifyRateLimited()).toBe(true);
    expect(spotifyCalls.calls).toBe(1);
    const npCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
    ).length;

    // Subsequent ticks: the lane reads the shared suspension record and
    // skip-suspends. The fetcher wrapper is NOT invoked at all — task #96
    // has the lane gate on the shared record before touching the fetcher.
    jest.setSystemTime(5_000);
    await handle.runTick();
    jest.setSystemTime(10_000);
    await handle.runTick();
    jest.setSystemTime(15_000);
    await handle.runTick();

    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_NOW_PLAYING_URL).length
    ).toBe(npCalls); // no new network calls to Spotify
    expect(spotifyCalls.calls).toBe(1); // fetcher NOT re-invoked once suspension is shared

    handle.stop();
  });

  it("429 backoff also holds while the lane is idle", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    // Retry-After = 3600s (1 hour) — well past both the idle deadline (5m)
    // and everything else the test moves through. This guarantees the 429
    // window is what suppresses the fetch, not that the backoff simply
    // expired between ticks.
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse("tok"));
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(rateLimited429(3600));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) return Promise.resolve(rateLimited429(3600));
      if (url === "http://gateway:8080/health") return Promise.resolve(healthResponse());
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response);
    });

    const spotifyCalls = { calls: 0 };
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      { getPresenceCount: async () => 0 }, // idle
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // First idle tick: fetches once, trips backoff.
    await handle.runTick();
    expect(isSpotifyRateLimited()).toBe(true);
    const npCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === SPOTIFY_NOW_PLAYING_URL
    ).length;

    // Advance past the idle deadline — the lane says fetch again, but the
    // fetcher short-circuits on the 429 window and no new network call fires.
    jest.setSystemTime(DEFAULT_SPOTIFY_IDLE_INTERVAL_MS + 1_000);
    await handle.runTick();
    expect(
      mockFetch.mock.calls.filter((c) => c[0] === SPOTIFY_NOW_PLAYING_URL).length
    ).toBe(npCalls);

    handle.stop();
  });
});

describe("integration — other lanes unaffected", () => {
  it("status/duolingo/github lanes stay on their own cadence when Spotify is suspended", async () => {
    useFakeClock();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    // Pre-suspend Spotify so we don't need to trip via the network. Under
    // task #96 the SHARED Redis record is the source of truth for the lane;
    // seed it below in addition to the in-process flag.
    suspendSpotifyAuth("test-injection");

    let statusHits = 0;
    let duolingoHits = 0;
    let githubHits = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === "http://gateway:8080/health") {
        statusHits += 1;
        return Promise.resolve(healthResponse());
      }
      if (typeof url === "string" && url.includes("duolingo")) {
        duolingoHits += 1;
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
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
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response);
    });

    const spotifyCalls = { calls: 0 };
    const redis = createFakeRedis();
    // Seed the shared suspension record so the lane skip-suspends from tick 1.
    await writeSpotifySuspension(redis, ENV, {
      suspended_until: new Date(24 * 60 * 60 * 1000).toISOString(),
      reason: "auth",
      detail: "test-injection",
      captured_token_updated_at: new Date(0).toISOString(),
    });
    const lease = await acquireLease(redis);
    const fetchers = buildFetchersWithLane(
      {
        // Ensure the lane knows we're auth-suspended and short-circuits.
        isAuthSuspended: () => isSpotifyAuthSuspended(),
        // No updated_at change — stays suspended.
        getStoredTokenUpdatedAt: async () => new Date(0),
      },
      spotifyCalls,
      redis
    );

    const handle = startPollLoop(redis, lease, fetchers, {
      ...baseConfig(),
      // Slow lane fires once per tick when deadline elapses; small refresh so
      // we can see multiple hits over the loop.
      slowLaneRefreshMs: 20_000,
    });

    // 10 ticks over ~50s.
    for (let i = 0; i < 10; i += 1) {
      jest.setSystemTime(i * 5_000);
      await handle.runTick();
    }
    expect(spotifyCalls.calls).toBe(0); // Spotify NEVER called
    expect(statusHits).toBe(10); // status fires every tick
    // Slow lane fired at least twice as deadlines elapsed.
    expect(duolingoHits).toBeGreaterThanOrEqual(2);
    expect(githubHits).toBeGreaterThanOrEqual(2);

    handle.stop();
  });
});
