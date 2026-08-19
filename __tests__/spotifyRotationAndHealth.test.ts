/**
 * Task #112 — no-DB unit tests for the four behaviors that don't need Postgres:
 *
 *   1. Rotation persistence — `refreshAccessToken` calls the injected
 *      `onRefreshTokenRotated` sink whenever Spotify's response includes a
 *      rotated `refresh_token`.
 *   2. Fallback removal — the router's `spotifyConfig` builder ignores the
 *      long-dead `spotify_refresh_token` secrets field even when a test
 *      forces it back into the config.
 *   3. Disconnected state — with no stored token AND no fallback, an HTTP
 *      hit fires zero Spotify calls (the auth-suspension machinery halts
 *      the token endpoint too, per task #95).
 *   4. Health record writes — the lane's `reconcileAfterFetch` flushes the
 *      in-memory health mirror (last_success_at, last_error {kind,at,
 *      rate_limited_until}) into the shared record on both success and
 *      failure paths.
 *
 * Persistence + rotation ROUND-TRIP against a real Postgres cluster is
 * separately covered by spotifyTokenStore.test.ts.
 */

import request from "supertest";

// Route every store call through a mock — this file has no Postgres. Tests
// swap the mock behaviour per case (returning a stored token, a null, etc.).
jest.mock("../src/services/spotifyTokenStore", () => {
  const actual = jest.requireActual("../src/services/spotifyTokenStore");
  return {
    ...actual,
    getStoredSpotifyToken: jest.fn(),
    rotateSpotifyRefreshToken: jest.fn(),
  };
});

import app from "../src/app";
import {
  getStoredSpotifyToken,
  rotateSpotifyRefreshToken,
} from "../src/services/spotifyTokenStore";
import {
  _resetSpotifyStateForTests,
  applySpotifyHealthMirror,
  getNowPlaying,
  getSpotifyLastError,
  getSpotifyLastSuccessAtMs,
  isSpotifyAuthSuspended,
  isSpotifyRateLimited,
  getSpotifyBackoffUntilMs,
  suspendSpotifyAuth,
  resumeSpotifyAuth,
  applySpotifyBackoffUntil,
  clearSpotifyBackoff,
  noteSpotifyApiSuccess,
  noteSpotifyApiError,
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_RECENTLY_PLAYED_URL,
  SPOTIFY_TOKEN_URL,
  type SpotifyConfig,
} from "../src/services/spotifyService";
import {
  createSpotifyLane,
  DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
  SPOTIFY_AUTH_RESUME_CHECK_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
} from "../src/services/upstream/spotifyLane";
import {
  readSpotifyHealth,
  writeSpotifyHealth,
  readSpotifySuspension,
  writeSpotifySuspension,
  deleteSpotifySuspension,
  spotifyHealthKey,
  type SpotifyHealthRecord,
} from "../src/services/upstream/snapshotStore";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";

const mockGetStored = getStoredSpotifyToken as jest.Mock;
const mockRotate = rotateSpotifyRefreshToken as jest.Mock;

const CONFIG_BASE = {
  clientId: "client-id-abc",
  clientSecret: "client-secret-xyz",
} as const;

const ENV = "test";

const mockFetch = jest.fn();

function tokenResponseWith(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function status(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({}),
  } as unknown as Response;
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

beforeAll(() => {
  app.set("secrets", {
    node_env: ENV,
    spotify_client_id: CONFIG_BASE.clientId,
    spotify_client_secret: CONFIG_BASE.clientSecret,
  });
});

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  mockGetStored.mockReset();
  mockRotate.mockReset();
  mockRotate.mockResolvedValue(true);
  _resetSpotifyStateForTests();
  // Default: the request-path fallback has NO upstream context installed —
  // the router either falls back to the direct-fetch legacy path or serves
  // idle from the "disconnected" auth-suspended machinery.
  app.set("upstream", undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ============================================================================
// 1. Rotation persistence
// ============================================================================

describe("rotation persistence — refresh response with rotated token", () => {
  it("calls onRefreshTokenRotated with the NEW token when Spotify returns one", async () => {
    const rotated: string[] = [];
    const config: SpotifyConfig = {
      ...CONFIG_BASE,
      refreshToken: "original-refresh-token",
      onRefreshTokenRotated: async (t) => {
        rotated.push(t);
      },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(
          tokenResponseWith({
            access_token: "at-1",
            expires_in: 3600,
            refresh_token: "new-rotated-token",
          })
        );
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(status(204));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve(
          tokenResponseWith({ items: [] })
        );
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const payload = await getNowPlaying(config);
    expect(payload).toEqual({ playing: false });
    expect(rotated).toEqual(["new-rotated-token"]);
  });

  it("does NOT invoke the sink when the response's refresh_token matches the current one", async () => {
    const rotated: string[] = [];
    const config: SpotifyConfig = {
      ...CONFIG_BASE,
      refreshToken: "same-token",
      onRefreshTokenRotated: async (t) => {
        rotated.push(t);
      },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(
          tokenResponseWith({
            access_token: "at-1",
            expires_in: 3600,
            refresh_token: "same-token", // echoed back unchanged
          })
        );
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(status(204));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve(tokenResponseWith({ items: [] }));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    await getNowPlaying(config);
    expect(rotated).toEqual([]);
  });

  it("does NOT invoke the sink when the response has no refresh_token", async () => {
    const rotated: string[] = [];
    const config: SpotifyConfig = {
      ...CONFIG_BASE,
      refreshToken: "original-token",
      onRefreshTokenRotated: async (t) => {
        rotated.push(t);
      },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(
          tokenResponseWith({ access_token: "at-1", expires_in: 3600 })
        );
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(status(204));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve(tokenResponseWith({ items: [] }));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    await getNowPlaying(config);
    expect(rotated).toEqual([]);
  });

  it("swallows sink errors so a persistence blip does NOT fail the live request", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const config: SpotifyConfig = {
      ...CONFIG_BASE,
      refreshToken: "original-token",
      onRefreshTokenRotated: async () => {
        throw new Error("DB blip");
      },
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(
          tokenResponseWith({
            access_token: "at-1",
            expires_in: 3600,
            refresh_token: "rotated-token",
          })
        );
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(status(204));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve(tokenResponseWith({ items: [] }));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const payload = await getNowPlaying(config);
    // The rotation persistence FAILED but the fresh access token was still
    // returned and used for the currently-playing call → idle, not error.
    expect(payload).toEqual({ playing: false });
  });

  it("HTTP router path: rotation invokes rotateSpotifyRefreshToken with the encrypted-store key", async () => {
    mockGetStored.mockResolvedValue({
      refreshToken: "original-refresh-token",
      authorizedAt: new Date(0),
    });

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve(
          tokenResponseWith({
            access_token: "at-1",
            expires_in: 3600,
            refresh_token: "rotated-refresh-token",
          })
        );
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) return Promise.resolve(status(204));
      if (url === SPOTIFY_RECENTLY_PLAYED_URL) {
        return Promise.resolve(tokenResponseWith({ items: [] }));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(mockRotate).toHaveBeenCalledWith(
      // Encryption key resolves to the client secret when no dedicated key
      // is set (see resolveEncryptionKey / back-compat rule in §4.7).
      CONFIG_BASE.clientSecret,
      "rotated-refresh-token"
    );
  });
});

// ============================================================================
// 2. Fallback removal — secret ignored even when present
// ============================================================================

describe("fallback removal — spotify_refresh_token secret is IGNORED", () => {
  it("HTTP path: no stored token + `spotify_refresh_token` set in secrets → zero Spotify calls", async () => {
    mockGetStored.mockResolvedValue(null);
    // Sneak the long-dead field back into the secrets to prove the router
    // does not read it — the type has removed it but this simulates a
    // stale deploy that still has it in the JSON blob.
    app.set("secrets", {
      node_env: ENV,
      spotify_client_id: CONFIG_BASE.clientId,
      spotify_client_secret: CONFIG_BASE.clientSecret,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spotify_refresh_token: "STALE-SECRET-FALLBACK",
    } as any);

    // Any Spotify call would be seen through this mock.
    mockFetch.mockImplementation(() => {
      throw new Error("Spotify must not be called with no service_tokens row");
    });

    try {
      const res = await request(app).get("/api/now-playing");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ playing: false });
      const spotifyCalls = mockFetch.mock.calls.filter(([u]) =>
        typeof u === "string" &&
        (u.includes("accounts.spotify.com") || u.includes("api.spotify.com"))
      );
      expect(spotifyCalls).toHaveLength(0);
    } finally {
      app.set("secrets", {
        node_env: ENV,
        spotify_client_id: CONFIG_BASE.clientId,
        spotify_client_secret: CONFIG_BASE.clientSecret,
      });
    }
  });
});

// ============================================================================
// 3. Disconnected state — silent, zero Spotify calls
// ============================================================================

describe("disconnected state — no stored token, zero Spotify calls", () => {
  it("first HTTP hit suspends auth and does NOT touch Spotify; subsequent hits stay silent", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockGetStored.mockResolvedValue(null);

    mockFetch.mockImplementation(() => {
      throw new Error("Spotify must not be called in the disconnected state");
    });

    // Three requests — first triggers the one-time suspension log, rest are
    // silent. All three answer 200 { playing: false }, and Spotify is
    // never touched.
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get("/api/now-playing");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ playing: false });
    }

    const spotifyCalls = mockFetch.mock.calls.filter(([u]) =>
      typeof u === "string" &&
      (u.includes("accounts.spotify.com") || u.includes("api.spotify.com"))
    );
    expect(spotifyCalls).toHaveLength(0);

    // Exactly ONE "auth suspended" warn line across the run.
    const suspensionLogs = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("Spotify auth suspended")
    );
    expect(suspensionLogs.length).toBe(1);
    expect(isSpotifyAuthSuspended()).toBe(true);
  });

  it("getNowPlaying with empty config returns idle without any fetch (direct call)", async () => {
    const payload = await getNowPlaying({
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    });
    expect(payload).toEqual({ playing: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. Shared health record writes
// ============================================================================

describe("shared health record (task #112) — writes on success and failure", () => {
  function buildLane(
    redis: FakeRedis
  ): ReturnType<typeof createSpotifyLane> {
    return createSpotifyLane(
      {
        isAuthSuspended: () => isSpotifyAuthSuspended(),
        getBackoffUntilMs: () => getSpotifyBackoffUntilMs(),
        applyAuthSuspension: (reason: string) => suspendSpotifyAuth(reason),
        applyBackoffUntil: (untilMs: number) =>
          applySpotifyBackoffUntil(untilMs),
        clearBackoff: () => clearSpotifyBackoff(),
        resumeAuth: () => resumeSpotifyAuth(),
        getStoredTokenUpdatedAt: async () => new Date(0),
        getPresenceCount: async () => 5,
        getLastPublicRequestAt: async () => null,
        readSharedSuspension: async () => readSpotifySuspension(redis, ENV),
        writeSharedSuspension: async (r) => writeSpotifySuspension(redis, ENV, r),
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
        writeSharedHealth: async (r) => writeSpotifyHealth(redis, ENV, r),
        applyHealthMirror: (r) => applySpotifyHealthMirror(r),
      },
      {
        publicRequestWindowMs: SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
        presenceCacheMs: SPOTIFY_PRESENCE_CACHE_MS,
        authResumeCheckMs: SPOTIFY_AUTH_RESUME_CHECK_MS,
        idleIntervalMs: DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
      }
    );
  }

  it("records last_success_at after a 200 from Spotify (success path)", async () => {
    const redis = createFakeRedis();
    const lane = buildLane(redis);

    // Plan the tick + persist a success into the local mirror + reconcile.
    await lane.planTick(Date.now());
    noteSpotifyApiSuccess(1_700_000_000_000);
    await lane.reconcileAfterFetch(Date.now());

    const record = await readSpotifyHealth(redis, ENV);
    expect(record).not.toBeNull();
    expect(record!.last_success_at).toBe(
      new Date(1_700_000_000_000).toISOString()
    );
    expect(record!.last_error).toBeNull();
  });

  it("records last_error kind=invalid_grant on a token 400", async () => {
    const redis = createFakeRedis();
    const lane = buildLane(redis);

    // Simulate a 400 invalid_grant observation.
    noteSpotifyApiError("invalid_grant", 1_700_000_500_000);
    suspendSpotifyAuth("invalid_grant on token refresh");

    await lane.planTick(Date.now());
    await lane.reconcileAfterFetch(Date.now());

    const record = await readSpotifyHealth(redis, ENV);
    expect(record).not.toBeNull();
    expect(record!.last_error).toEqual({
      kind: "invalid_grant",
      at: new Date(1_700_000_500_000).toISOString(),
    });
  });

  it("records last_error kind=rate_limited with rate_limited_until on a 429", async () => {
    const redis = createFakeRedis();
    const lane = buildLane(redis);

    const errAt = 1_700_001_000_000;
    const until = errAt + 120_000;
    noteSpotifyApiError("rate_limited", errAt, until);
    applySpotifyBackoffUntil(until);

    await lane.planTick(Date.now());
    await lane.reconcileAfterFetch(Date.now());

    const record = await readSpotifyHealth(redis, ENV);
    expect(record).not.toBeNull();
    expect(record!.last_error).toEqual({
      kind: "rate_limited",
      at: new Date(errAt).toISOString(),
      rate_limited_until: new Date(until).toISOString(),
    });
  });

  it("records last_error kind=other on a non-categorized failure", async () => {
    const redis = createFakeRedis();
    const lane = buildLane(redis);

    noteSpotifyApiError("other", 1_700_002_000_000);

    await lane.planTick(Date.now());
    await lane.reconcileAfterFetch(Date.now());

    const record = await readSpotifyHealth(redis, ENV);
    expect(record).not.toBeNull();
    expect(record!.last_error).toEqual({
      kind: "other",
      at: new Date(1_700_002_000_000).toISOString(),
    });
  });

  it("shared record key is env-prefixed alongside the suspension key", () => {
    expect(spotifyHealthKey("production")).toBe(
      "portfolio-v6-api:production:snapshot:now-playing:health"
    );
    expect(spotifyHealthKey("development")).toBe(
      "portfolio-v6-api:development:snapshot:now-playing:health"
    );
  });

  it("shared health read/write round-trips (fail-open on missing/malformed)", async () => {
    const redis = createFakeRedis();
    const record: SpotifyHealthRecord = {
      last_success_at: new Date(1_700_000_000_000).toISOString(),
      last_error: {
        kind: "rate_limited",
        at: new Date(1_700_000_500_000).toISOString(),
        rate_limited_until: new Date(1_700_000_620_000).toISOString(),
      },
    };
    await writeSpotifyHealth(redis, ENV, record);
    expect(await readSpotifyHealth(redis, ENV)).toEqual(record);

    // Missing / malformed → null (never throws).
    const empty = createFakeRedis();
    expect(await readSpotifyHealth(empty, ENV)).toBeNull();
    empty.seed(spotifyHealthKey(ENV), "not-json");
    expect(await readSpotifyHealth(empty, ENV)).toBeNull();

    // Redis error on read → null (fail open, never a 5xx).
    const flaky = createFakeRedis();
    flaky.queueError(new Error("ECONNREFUSED"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await readSpotifyHealth(flaky, ENV)).toBeNull();
  });

  it("a fresh leader inherits the shared health mirror on its first tick", async () => {
    const redis = createFakeRedis();
    // Previous leader wrote a health record; process locals are clean.
    const priorSuccess = 1_700_100_000_000;
    await writeSpotifyHealth(redis, ENV, {
      last_success_at: new Date(priorSuccess).toISOString(),
      last_error: null,
    });

    expect(getSpotifyLastSuccessAtMs()).toBeNull();

    // First tick on this leader: the lane applies the shared health record
    // into the process-local mirror BEFORE running its normal planning.
    const lane = buildLane(redis);
    await lane.planTick(Date.now());

    expect(getSpotifyLastSuccessAtMs()).toBe(priorSuccess);
  });

  it("suspension record and health record are kept as SEPARATE keys", async () => {
    const redis = createFakeRedis();
    const lane = buildLane(redis);

    // Simulate the real flow: planTick observes no suspension and returns
    // "fetch"; the fetcher then trips a 429 that populates local backoff +
    // health mirror; reconcileAfterFetch writes BOTH the suspension and
    // health records on the same pass.
    const now = 1_700_003_000_000;
    await lane.planTick(now);
    const errAt = now + 100;
    const until = errAt + 60_000;
    noteSpotifyApiError("rate_limited", errAt, until);
    applySpotifyBackoffUntil(until);
    await lane.reconcileAfterFetch(errAt);

    const health = await readSpotifyHealth(redis, ENV);
    const suspension = await readSpotifySuspension(redis, ENV);
    expect(health).not.toBeNull();
    expect(suspension).not.toBeNull();
    expect(health!.last_error?.kind).toBe("rate_limited");
    expect(suspension!.reason).toBe("429");
    // The two Redis keys are distinct (defense against accidental clobber).
    expect(Object.keys(redis.dump()).sort()).toEqual(
      [
        "portfolio-v6-api:test:snapshot:now-playing:health",
        "portfolio-v6-api:test:snapshot:now-playing:suspension",
      ].sort()
    );
  });
});

// Silence unused import warnings for helpers pulled in for symmetry.
void isSpotifyRateLimited;
