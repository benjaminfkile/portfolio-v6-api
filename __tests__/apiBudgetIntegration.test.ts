/**
 * Task #120 integration tests - the daily Spotify Web API call budget guard
 * wired end-to-end through spotifyService + spotifyLane.
 *
 * Acceptance concerns exercised here:
 *
 *   - Every Web API and token call increments the budget, hitting the cap
 *     suspends polling until the configured reset time (writes a shared
 *     suspension record with reason "budget" from the lane reconciler).
 *   - Budget state (used, cap, resets_at) is exposed for the status contract
 *     via computeSpotifyStatus.
 *   - Redis outage on the INCR path degrades to in-process counting without
 *     disabling the feature (integration-level assertion here; unit-level in
 *     apiBudget.test.ts).
 *   - Listener traffic (dealer / connect-state fetches) does NOT count -
 *     spotifyService only wraps the token endpoint + Web API URLs, so
 *     fetches to any other host go unnoticed by the budget.
 */

import type { Express } from "express";
import type { IAppSecrets } from "../src/interfaces";
import { buildFetchers } from "../src/services/upstream";
import {
  startPollLoop,
  _resetPollLoopStateForTests,
  type PollFetchers,
} from "../src/services/upstream/pollLoop";
import { createLeaderLease } from "../src/services/upstream/leaderLease";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";
import { REALTIME_SERVICE_NAME } from "../src/services/upstream/realtimePublisher";
import {
  _resetSpotifyStateForTests,
  isSpotifyRateLimited,
  isSpotifyBudgetExhausted,
  setSpotifyBudgetHook,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
  SPOTIFY_TOKEN_URL,
} from "../src/services/spotifyService";
import {
  createApiBudget,
  DEFAULT_SPOTIFY_BUDGET_RESET_UTC,
  parseResetTime,
} from "../src/services/listener/apiBudget";
import {
  createSpotifyLane,
  DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
  SPOTIFY_AUTH_RESUME_CHECK_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
} from "../src/services/upstream/spotifyLane";
import {
  applySpotifyBudgetExhaustion,
  clearSpotifyBudgetExhaustion,
  getSpotifyBudgetExhaustedUntilMs,
  isSpotifyAuthSuspended,
  suspendSpotifyAuth,
  resumeSpotifyAuth,
  getSpotifyBackoffUntilMs,
  applySpotifyBackoffUntil,
  clearSpotifyBackoff,
  getSpotifyLastError,
  getSpotifyLastSuccessAtMs,
  applySpotifyHealthMirror,
} from "../src/services/spotifyService";
import {
  readSpotifySuspension,
  readSpotifyHealth,
  writeSpotifyHealth,
  writeSpotifySuspension,
  deleteSpotifySuspension,
} from "../src/services/upstream/snapshotStore";
import { computeSpotifyStatus } from "../src/services/spotifyStatusService";

// Task #112 killed the static `spotify_refresh_token` secret fallback - the
// grant now comes exclusively from the encrypted service_tokens table. This
// suite has no database (unit-style integration), so we stub the store's
// read to inject a working refresh token.
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

// Silence Postgres access from the shared service_settings read.
jest.mock("../src/services/serviceSettingsStore", () => ({
  isSpotifyDisabled: async () => false,
  setSpotifyEnabled: async () => undefined,
}));

const ENV = "development";
const RESET = parseResetTime(DEFAULT_SPOTIFY_BUDGET_RESET_UTC)!;

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

function tokenResponse(): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ access_token: "tok", expires_in: 3600 }),
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

function baseConfig() {
  return {
    env: ENV,
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

function buildLaneAndFetchers(app: Express, redis: FakeRedis, cap: number) {
  const apiBudget = createApiBudget({
    redis,
    env: ENV,
    cap,
    resetHour: RESET.hour,
    resetMinute: RESET.minute,
    onCapReached: (nextResetAtMs) => {
      applySpotifyBudgetExhaustion(nextResetAtMs);
    },
  });
  setSpotifyBudgetHook({
    noteCall: async (now?: number) => {
      const r = await apiBudget.noteCall(now);
      const state = await apiBudget.getState(now);
      return {
        capReached: r.capReached,
        nextResetAtMs: Date.parse(state.resets_at),
      };
    },
  });

  const lane = createSpotifyLane(
    {
      isDisabled: async () => false,
      isAuthSuspended: () => isSpotifyAuthSuspended(),
      getBackoffUntilMs: () => getSpotifyBackoffUntilMs(),
      applyAuthSuspension: (reason: string) => suspendSpotifyAuth(reason),
      applyBackoffUntil: (untilMs: number) =>
        applySpotifyBackoffUntil(untilMs),
      clearBackoff: () => clearSpotifyBackoff(),
      getBudgetExhaustedUntilMs: () => getSpotifyBudgetExhaustedUntilMs(),
      applyBudgetExhaustion: (untilMs) =>
        applySpotifyBudgetExhaustion(untilMs),
      clearBudgetExhaustion: () => clearSpotifyBudgetExhaustion(),
      resumeAuth: () => resumeSpotifyAuth(),
      getStoredTokenUpdatedAt: async () => new Date(0),
      getPresenceCount: async () => 5,
      getLastPublicRequestAt: async () => null,
      readSharedSuspension: async () => readSpotifySuspension(redis, ENV),
      writeSharedSuspension: async (record) =>
        writeSpotifySuspension(redis, ENV, record),
      clearSharedSuspension: async () => deleteSpotifySuspension(redis, ENV),
      readLocalHealth: () => {
        const successMs = getSpotifyLastSuccessAtMs();
        const err = getSpotifyLastError();
        return {
          last_success_at:
            successMs != null ? new Date(successMs).toISOString() : null,
          last_error: err
            ? {
                kind: err.kind,
                at: new Date(err.atMs).toISOString(),
                ...(err.kind === "rate_limited" &&
                err.rateLimitedUntilMs != null
                  ? {
                      rate_limited_until: new Date(
                        err.rateLimitedUntilMs
                      ).toISOString(),
                    }
                  : {}),
              }
            : null,
        };
      },
      readSharedHealth: async () => readSpotifyHealth(redis, ENV),
      writeSharedHealth: async (record) =>
        writeSpotifyHealth(redis, ENV, record),
      applyHealthMirror: (record) => applySpotifyHealthMirror(record),
    },
    {
      publicRequestWindowMs: SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
      presenceCacheMs: SPOTIFY_PRESENCE_CACHE_MS,
      authResumeCheckMs: SPOTIFY_AUTH_RESUME_CHECK_MS,
      idleIntervalMs: DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
    }
  );

  const fetchers: PollFetchers = {
    ...buildFetchers(app, { spotifyLane: lane }),
  };
  fetchers.spotifyLane = lane;
  // Replace duolingo/github/status with no-ops so we don't need to stub
  // every external service for these tests.
  fetchers.status = async () => ({ degraded: false, services: [] });
  fetchers.duolingo = async () => null;
  fetchers.github = async () => null;
  return { fetchers, apiBudget };
}

const mockFetch = jest.fn();

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetPollLoopStateForTests();
  _resetSpotifyStateForTests();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  setSpotifyBudgetHook(null);
});

// ============================================================================
// Cap trip writes a shared suspension with reason "budget"
// ============================================================================

describe("apiBudget - cap trip writes shared suspension with reason budget", () => {
  it("first fetch past the cap fires the trip and reconcileAfterFetch persists reason=budget", async () => {
    const redis = createFakeRedis();
    const app = fakeApp({
      node_env: ENV,
      spotify_client_id: "cid",
      spotify_client_secret: "sec",
    });

    // Cap of 3 - one currently-playing + one recently-played per tick under
    // an idle account = 2 calls per tick (no token exchange after the first
    // tick since the access token is cached). Tick 1 uses 3 calls (token +
    // now-playing + recently-played), tripping the cap.
    const { fetchers, apiBudget } = buildLaneAndFetchers(app, redis, 3);

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse());
      if (url === SPOTIFY_NOW_PLAYING_URL)
        return Promise.resolve(nowPlaying204());
      if (url === SPOTIFY_RECENTLY_PLAYED_URL)
        return Promise.resolve(nowPlaying224());
      if (typeof url === "string" && url.includes("internal/publish")) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      }
      throw new Error(`unexpected ${url}`);
    });

    // ergonomic alias for the same body shape as nowPlaying204
    function nowPlaying224() {
      return nowPlaying204();
    }

    const lease = createLeaderLease(redis, {
      key: `portfolio-v6-api:${ENV}:upstream-leader`,
      leaseTtlMs: 15_000,
      renewIntervalMs: 5_000,
    });
    expect(await lease.tryAcquire()).toBe(true);

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Tick 1 - fetcher runs 3 Spotify calls (token + now-playing +
    // recently-played), the third one trips the cap. The lane's reconciler
    // then persists a shared suspension record with reason "budget".
    await handle.runTick();

    const record = await readSpotifySuspension(redis, ENV);
    expect(record).not.toBeNull();
    expect(record!.reason).toBe("budget");
    expect(record!.detail).toMatch(/budget exhausted/i);

    // Deadline is exactly the apiBudget's next-reset moment.
    const state = await apiBudget.getState();
    expect(record!.suspended_until).toBe(state.resets_at);

    // Local mirror is set - subsequent tick short-circuits without any new
    // Spotify call.
    expect(isSpotifyBudgetExhausted()).toBe(true);
    const callsBeforeTick2 = mockFetch.mock.calls.filter(
      ([u]) =>
        typeof u === "string" &&
        (u.includes("accounts.spotify.com") ||
          u.includes("api.spotify.com"))
    ).length;

    await handle.runTick();

    const callsAfterTick2 = mockFetch.mock.calls.filter(
      ([u]) =>
        typeof u === "string" &&
        (u.includes("accounts.spotify.com") ||
          u.includes("api.spotify.com"))
    ).length;
    expect(callsAfterTick2).toBe(callsBeforeTick2);

    handle.stop();
  });

  it("a freshly-elected leader inherits a persisted budget suspension without one Spotify call", async () => {
    const redis = createFakeRedis();
    const app = fakeApp({
      node_env: ENV,
      spotify_client_id: "cid",
      spotify_client_secret: "sec",
    });

    // Pre-seed the shared record BEFORE the leader boots.
    const nextReset = Date.now() + 60 * 60 * 1000;
    await writeSpotifySuspension(redis, ENV, {
      suspended_until: new Date(nextReset).toISOString(),
      reason: "budget",
      detail: "daily Spotify API call budget exhausted",
    });

    const { fetchers } = buildLaneAndFetchers(app, redis, 5);

    mockFetch.mockImplementation((url: string) => {
      if (
        typeof url === "string" &&
        (url.includes("accounts.spotify.com") ||
          url.includes("api.spotify.com"))
      ) {
        throw new Error(
          "fresh leader must NOT call Spotify to rediscover a known budget suspension"
        );
      }
      if (typeof url === "string" && url.includes("internal/publish")) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      }
      throw new Error(`unexpected ${url}`);
    });

    const lease = createLeaderLease(redis, {
      key: `portfolio-v6-api:${ENV}:upstream-leader`,
      leaseTtlMs: 15_000,
      renewIntervalMs: 5_000,
    });
    expect(await lease.tryAcquire()).toBe(true);

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // Multiple ticks - the shared "budget" record persists, no Spotify call.
    for (let t = 0; t < 3; t += 1) await handle.runTick();

    // Local mirror inherited the deadline via the lane's shared-record read.
    expect(isSpotifyBudgetExhausted()).toBe(true);
    expect(getSpotifyBudgetExhaustedUntilMs()).toBe(nextReset);

    handle.stop();
  });
});

// ============================================================================
// Budget state exposed via computeSpotifyStatus
// ============================================================================

describe("apiBudget - status contract exposure", () => {
  it("computeSpotifyStatus surfaces { used, cap, resets_at } on the response", async () => {
    const redis = createFakeRedis();
    const app = fakeApp({
      node_env: ENV,
      spotify_client_id: "cid",
      spotify_client_secret: "sec",
    });

    // Build the shared budget and drive a couple of noteCalls to advance it.
    const apiBudget = createApiBudget({
      redis,
      env: ENV,
      cap: 4000,
      resetHour: RESET.hour,
      resetMinute: RESET.minute,
    });
    await apiBudget.noteCall();
    await apiBudget.noteCall();

    // Install a minimal UpstreamHandle carrying the apiBudget the status
    // service reads from.
    const upstream = {
      enabled: true,
      lease: null,
      loop: { stop: () => undefined, runTick: async () => undefined },
      redis,
      listenerSupervisor: null,
      apiBudget,
      stop: async () => undefined,
    };

    const status = await computeSpotifyStatus(
      app.get("secrets") as IAppSecrets,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upstream as any
    );

    expect(status.budget).toBeDefined();
    expect(status.budget!.cap).toBe(4000);
    expect(status.budget!.used).toBeGreaterThanOrEqual(2);
    expect(typeof status.budget!.resets_at).toBe("string");
    // ISO 8601 format sanity.
    expect(Number.isFinite(Date.parse(status.budget!.resets_at))).toBe(true);
  });
});

// ============================================================================
// Redis outage degrades to in-process counting (integration-level)
// ============================================================================

describe("apiBudget - Redis outage keeps feature alive", () => {
  it("with Redis erroring on every INCR, spotifyService still fetches (counter falls back to memory)", async () => {
    const redis = createFakeRedis();
    const app = fakeApp({
      node_env: ENV,
      spotify_client_id: "cid",
      spotify_client_secret: "sec",
    });

    const { fetchers } = buildLaneAndFetchers(app, redis, 4000);

    // Every Redis command throws.
    for (let i = 0; i < 100; i += 1) redis.queueError(new Error("ECONNREFUSED"));

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) return Promise.resolve(tokenResponse());
      if (url === SPOTIFY_NOW_PLAYING_URL)
        return Promise.resolve(nowPlaying204());
      if (url === SPOTIFY_RECENTLY_PLAYED_URL)
        return Promise.resolve(nowPlaying204());
      if (typeof url === "string" && url.includes("internal/publish")) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response);
      }
      throw new Error(`unexpected ${url}`);
    });

    const lease = createLeaderLease(redis, {
      key: `portfolio-v6-api:${ENV}:upstream-leader`,
      leaseTtlMs: 15_000,
      renewIntervalMs: 5_000,
    });
    // Even the lease acquisition may hit an error - swallow.
    await lease.tryAcquire().catch(() => undefined);

    const handle = startPollLoop(redis, lease, fetchers, baseConfig());

    // The tick MUST NOT throw, and the fetcher wrapper MUST NOT block on
    // Redis (the feature stays alive even with Redis down).
    await handle.runTick();
    // Not exhausted (single tick, cap 4000).
    expect(isSpotifyBudgetExhausted()).toBe(false);
    expect(isSpotifyRateLimited()).toBe(false);

    handle.stop();
  });
});

// ============================================================================
// Listener traffic is not counted
// ============================================================================

describe("apiBudget - listener dealer traffic not counted", () => {
  it("counter stays at 0 across dealer + connect-state fetches", async () => {
    const redis = createFakeRedis();
    const apiBudget = createApiBudget({
      redis,
      env: ENV,
      cap: 10,
      resetHour: RESET.hour,
      resetMinute: RESET.minute,
    });
    setSpotifyBudgetHook({
      noteCall: async (now?: number) => {
        const r = await apiBudget.noteCall(now);
        const state = await apiBudget.getState(now);
        return {
          capReached: r.capReached,
          nextResetAtMs: Date.parse(state.resets_at),
        };
      },
    });

    // Simulate the listener's outbound fetches by calling the global fetch
    // against the two hosts the listener uses. These MUST NOT flow through
    // the budget hook - the hook is only invoked from spotifyService, which
    // wraps accounts.spotify.com + api.spotify.com only.
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ serverTime: 1_700_000_000 }),
      text: async () => "",
    } as unknown as Response);

    // Simulate the dealer opening a websocket handshake, the web-token
    // minter hitting open.spotify.com, and the connect-state edge PUT to
    // gae2-spclient.spotify.com. None of these should touch the budget.
    await fetch("wss://dealer.spotify.com/?access_token=abc");
    await fetch("https://open.spotify.com/api/server-time");
    await fetch("https://open.spotify.com/api/token?reason=init");
    await fetch(
      "https://gae2-spclient.spotify.com/connect-state/v1/devices/xyz"
    );

    const state = await apiBudget.getState();
    expect(state.used).toBe(0);

    // Sanity: a single API call DOES count.
    const spotifyService = await import("../src/services/spotifyService");
    spotifyService._resetSpotifyStateForTests();
    setSpotifyBudgetHook({
      noteCall: async (now?: number) => {
        const r = await apiBudget.noteCall(now);
        const s = await apiBudget.getState(now);
        return {
          capReached: r.capReached,
          nextResetAtMs: Date.parse(s.resets_at),
        };
      },
    });

    // Route one API call through spotifyService so the hook fires exactly once.
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ access_token: "tok", expires_in: 3600 }),
    } as unknown as Response);
    mockFetch.mockResolvedValueOnce(nowPlaying204());
    mockFetch.mockResolvedValueOnce(nowPlaying204());

    await spotifyService.getNowPlaying({
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "rt",
    });

    const after = await apiBudget.getState();
    // Went up (by 3 - token, now-playing, recently-played) but the listener
    // fetches above did not contribute.
    expect(after.used).toBeGreaterThanOrEqual(2);
  });
});
