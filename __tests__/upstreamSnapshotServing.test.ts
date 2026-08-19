import request from "supertest";
import app from "../src/app";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";
import {
  writeSnapshot,
  snapshotKey,
} from "../src/services/upstream/snapshotStore";
import { _resetPollLoopStateForTests } from "../src/services/upstream/pollLoop";
import { _resetSpotifyStateForTests } from "../src/services/spotifyService";
import { _resetStatusCacheForTests } from "../src/services/statusService";
import { _resetDuolingoCacheForTests } from "../src/services/duolingoService";
import { _resetGithubCacheForTests } from "../src/services/githubService";

/**
 * Router-side shared-snapshot tests (task #84).
 *
 * When Redis is configured and a snapshot exists, /api/now-playing, /api/status,
 * /api/duolingo (default `es`), and /api/github (default view) serve that
 * snapshot instead of hitting the upstream. When Redis is *down* or a snapshot
 * is missing, they fall back to the per-instance path.
 *
 * The upstream handle is injected via `app.set('upstream', ...)`; no real Redis
 * connection is opened.
 */

const ENV = "test";
const REALTIME_TOKEN = "SECRET-TOKEN";

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

beforeAll(() => {
  app.set("secrets", {
    node_env: ENV,
    spotify_client_id: "spid",
    spotify_client_secret: "sec",
    gateway_health_url: "http://gateway.test/api/health",
    gateway_realtime_token: REALTIME_TOKEN,
  });
});

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetPollLoopStateForTests();
  _resetSpotifyStateForTests();
  _resetStatusCacheForTests();
  _resetDuolingoCacheForTests();
  _resetGithubCacheForTests();
  installUpstream(null);
});

afterAll(() => {
  installUpstream(null);
});

describe("/api/now-playing — shared snapshot serving", () => {
  it("serves the Redis snapshot when present (no upstream call)", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    await writeSnapshot(redis, ENV, "now-playing", {
      playing: true,
      track: {
        title: "T",
        artists: ["A"],
        album: "AL",
        art_url: null,
        url: null,
        progress_ms: null,
        duration_ms: null,
      },
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      playing: true,
      track: {
        title: "T",
        artists: ["A"],
        album: "AL",
        art_url: null,
        url: null,
        progress_ms: null,
        duration_ms: null,
      },
    });
    // No upstream call at all — we came straight from Redis.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("serves degraded idle (never fetches Spotify) when Redis is healthy but no snapshot exists (task #96)", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    // Mock Spotify to prove it is never called.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("accounts.spotify.com") || url.includes("api.spotify.com")) {
        throw new Error(
          "the request path must NOT fetch Spotify when Redis is configured"
        );
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
      } as unknown as Response);
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
    // Spotify was NEVER called — the shared-snapshot design forbids it.
    const spotifyCalls = mockFetch.mock.calls.filter(
      ([url]) =>
        typeof url === "string" &&
        (url.includes("accounts.spotify.com") || url.includes("api.spotify.com"))
    );
    expect(spotifyCalls).toHaveLength(0);
  });

  it("falls back to the per-instance path when Redis errors on read", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    jest.spyOn(console, "error").mockImplementation(() => {});

    // Prime the snapshot, then queue an error so the read fails once.
    await writeSnapshot(redis, ENV, "now-playing", { playing: false });
    redis.queueError(new Error("ECONNREFUSED"));

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("accounts.spotify.com")) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ access_token: "t", expires_in: 3600 }),
        } as unknown as Response);
      }
      if (url.includes("currently-playing")) {
        return Promise.resolve({
          status: 204,
          ok: false,
          json: async () => ({}),
        } as unknown as Response);
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ items: [] }),
      } as unknown as Response);
    });

    const res = await request(app).get("/api/now-playing");
    // Never 5xx even when Redis is down.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
  });
});

describe("/api/status — shared snapshot serving", () => {
  it("serves the Redis snapshot when present", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    await writeSnapshot(redis, ENV, "status", {
      degraded: false,
      services: [{ name: "a", ok: true }],
    });

    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      degraded: false,
      services: [{ name: "a", ok: true }],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("/api/duolingo — shared snapshot serving (default language)", () => {
  it("serves the Redis snapshot when no ?language= (defaults to es)", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    await writeSnapshot(redis, ENV, "duolingo", {
      available: true,
      streak: 10,
      course: { title: "Spanish", xp: 1, crowns: 1 },
    });

    const res = await request(app).get("/api/duolingo");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      streak: 10,
      course: { title: "Spanish", xp: 1, crowns: 1 },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("/api/github — shared snapshot serving (default view)", () => {
  it("serves the Redis snapshot when no ?year=", async () => {
    const redis = createFakeRedis();
    installUpstream(redis);
    await writeSnapshot(redis, ENV, "github", {
      available: true,
      total: 42,
      from: "2025-08-17",
      to: "2026-08-16",
      years: [2026, 2025, 2024],
      weeks: [],
    });

    const res = await request(app).get("/api/github");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(42);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("snapshotKey — env prefixing", () => {
  it("produces env-scoped keys that never collide across environments", () => {
    expect(snapshotKey("prod", "now-playing")).toBe(
      "portfolio-v6-api:prod:snapshot:now-playing"
    );
    expect(snapshotKey("development", "now-playing")).toBe(
      "portfolio-v6-api:development:snapshot:now-playing"
    );
    expect(snapshotKey("prod", "duolingo", "es")).toBe(
      "portfolio-v6-api:prod:snapshot:duolingo:es"
    );
  });
});
