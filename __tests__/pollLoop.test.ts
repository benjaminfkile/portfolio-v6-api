import {
  startPollLoop,
  stableStringify,
  _resetPollLoopStateForTests,
  readLocalSnapshot,
} from "../src/services/upstream/pollLoop";
import { createLeaderLease } from "../src/services/upstream/leaderLease";
import { readSnapshot } from "../src/services/upstream/snapshotStore";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";
import {
  REALTIME_SERVICE_NAME,
  REALTIME_TOKEN_HEADER,
  publishUrl,
} from "../src/services/upstream/realtimePublisher";

/**
 * Poll-loop tests (task #84 core acceptance criteria).
 *
 * Covered: only the leader polls, snapshot serving on non-leader instances,
 * change-detection publish (no publish when payload unchanged), heartbeat
 * emission, slow-lane cadence (Duolingo/GitHub don't fetch every tick),
 * graceful degradation when Redis errors on write, and no publish + no fetch
 * when the loop isn't the leader.
 */

const ENV = "test";
const PUBLISH_URL = publishUrl("http://gateway:8080");

const mockFetch = jest.fn();

interface Fetchers {
  nowPlaying: jest.Mock;
  status: jest.Mock;
  duolingo: jest.Mock;
  github: jest.Mock;
}

function buildFetchers(): Fetchers {
  return {
    nowPlaying: jest.fn().mockResolvedValue({ playing: false }),
    status: jest.fn().mockResolvedValue({ degraded: false, services: [] }),
    duolingo: jest.fn().mockResolvedValue({ available: false }),
    github: jest.fn().mockResolvedValue({ available: false }),
  };
}

function buildConfig() {
  return {
    env: ENV,
    pollIntervalMs: 5_000,
    slowLaneRefreshMs: 60_000,
    heartbeatIntervalMs: 30_000,
    publisher: {
      gatewayInternalUrl: "http://gateway:8080",
      realtimeToken: "SECRET-TOKEN-123",
      serviceName: REALTIME_SERVICE_NAME,
    },
  };
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

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({}),
    text: async () => "",
  });
  _resetPollLoopStateForTests();
});

describe("startPollLoop — leader gating", () => {
  it("does nothing when Redis is unset (subsystem inert)", async () => {
    const fetchers = buildFetchers();
    const handle = startPollLoop(null, null, fetchers, buildConfig());
    await handle.runTick();
    expect(fetchers.nowPlaying).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does nothing on a runTick when we are not the leader", async () => {
    const redis = createFakeRedis();
    // Seed another instance's lease so we can't acquire.
    redis.seed(
      `portfolio-v6-api:${ENV}:upstream-leader`,
      "someone-else",
      15_000
    );
    const lease = createLeaderLease(redis, {
      key: `portfolio-v6-api:${ENV}:upstream-leader`,
      leaseTtlMs: 15_000,
      renewIntervalMs: 5_000,
    });
    expect(await lease.tryAcquire()).toBe(false);

    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, buildConfig());

    await handle.runTick();

    expect(fetchers.nowPlaying).not.toHaveBeenCalled();
    expect(fetchers.status).not.toHaveBeenCalled();
    expect(fetchers.duolingo).not.toHaveBeenCalled();
    expect(fetchers.github).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe("startPollLoop — fast lane snapshot + publish", () => {
  it("writes fast-lane snapshots on every tick and publishes on change", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    // First tick: playing=false; second tick: playing=true → change published.
    fetchers.nowPlaying
      .mockResolvedValueOnce({ playing: false })
      .mockResolvedValueOnce({
        playing: true,
        track: { title: "S", artists: [], album: "", art_url: null, url: null, progress_ms: null, duration_ms: null },
      });

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    await handle.runTick();

    expect(fetchers.nowPlaying).toHaveBeenCalledTimes(2);
    expect(fetchers.status).toHaveBeenCalledTimes(2);

    // Snapshot is present and readable by any instance.
    const snap = await readSnapshot<{ playing: boolean }>(redis, ENV, "now-playing");
    expect(snap?.payload).toEqual({
      playing: true,
      track: expect.any(Object),
    });
    expect(snap?.fetched_at).toEqual(expect.any(String));

    // Publishes: one for now-playing on tick 1 (initial value counts as change),
    // one for now-playing on tick 2 (change), one for status tick 1 (initial),
    // plus at least one heartbeat.
    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    const nowPlayingPublishes = publishCalls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return (
        body.channel === `${REALTIME_SERVICE_NAME}:now-playing` &&
        body.event === "snapshot"
      );
    });
    expect(nowPlayingPublishes).toHaveLength(2);

    // Wire contract (REALTIME.md §4): the publish body carries the payload
    // under `payload`, never `data` — the gateway 500s on a missing `payload`.
    for (const [, init] of publishCalls) {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toHaveProperty("payload");
      expect(body).not.toHaveProperty("data");
    }

    handle.stop();
  });

  it("does NOT publish when the fast-lane payload is unchanged", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    fetchers.nowPlaying.mockResolvedValue({ playing: false });
    fetchers.status.mockResolvedValue({ degraded: false, services: [] });

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    await handle.runTick();
    await handle.runTick();

    // First tick publishes each ("empty" prev → first payload is a change);
    // subsequent unchanged ticks must NOT publish.
    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    const nowPlayingPublishes = publishCalls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return (
        body.channel === `${REALTIME_SERVICE_NAME}:now-playing` &&
        body.event === "snapshot"
      );
    });
    expect(nowPlayingPublishes).toHaveLength(1);

    const statusPublishes = publishCalls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return (
        body.channel === `${REALTIME_SERVICE_NAME}:status` &&
        body.event === "snapshot"
      );
    });
    expect(statusPublishes).toHaveLength(1);

    handle.stop();
  });

  it("prefixes published channels with the configured service name (dev override)", async () => {
    // The dev deployment runs under a different service name — the channel
    // prefix must follow, or the gateway rejects the publish with 403.
    const DEV_SERVICE = "portfolio-v6-api-dev";
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, {
      ...buildConfig(),
      publisher: {
        gatewayInternalUrl: "http://gateway:8080",
        realtimeToken: "SECRET-TOKEN-123",
        serviceName: DEV_SERVICE,
      },
    });
    await handle.runTick();

    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    expect(publishCalls.length).toBeGreaterThan(0);
    // Every published channel MUST carry the dev service prefix — nothing
    // should leak the default `portfolio-v6-api` prefix into the payload.
    for (const [, init] of publishCalls) {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.channel).toMatch(new RegExp(`^${DEV_SERVICE}:`));
      expect(body.channel).not.toMatch(/^portfolio-v6-api:/);
    }
    // Both fast-lane snapshot channels + the heartbeat carry the override.
    const channels = publishCalls.map(([, init]) => {
      return JSON.parse((init as RequestInit).body as string).channel as string;
    });
    expect(channels).toContain(`${DEV_SERVICE}:now-playing`);
    expect(channels).toContain(`${DEV_SERVICE}:status`);
    handle.stop();
  });

  it("sends the realtime auth header on every publish", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    expect(publishCalls.length).toBeGreaterThan(0);
    for (const [, init] of publishCalls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers[REALTIME_TOKEN_HEADER]).toBe("SECRET-TOKEN-123");
    }
    handle.stop();
  });
});

describe("startPollLoop — heartbeat", () => {
  it("emits a heartbeat on the now-playing channel", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    const heartbeats = mockFetch.mock.calls.filter(([url, init]) => {
      if (url !== PUBLISH_URL) return false;
      const body = JSON.parse((init as RequestInit).body as string);
      return (
        body.channel === `${REALTIME_SERVICE_NAME}:now-playing` &&
        body.event === "heartbeat"
      );
    });
    expect(heartbeats).toHaveLength(1);
    handle.stop();
  });

  it("does not emit multiple heartbeats within the interval", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    // Interval configured at 30s; two fast ticks must NOT produce two heartbeats.
    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    await handle.runTick();

    const heartbeats = mockFetch.mock.calls.filter(([url, init]) => {
      if (url !== PUBLISH_URL) return false;
      const body = JSON.parse((init as RequestInit).body as string);
      return body.event === "heartbeat";
    });
    expect(heartbeats).toHaveLength(1);
    handle.stop();
  });
});

describe("startPollLoop — slow lane cadence", () => {
  it("refreshes Duolingo/GitHub only when the deadline elapses", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, {
      ...buildConfig(),
      // Slow lane elapses well past this test's tick timing.
      slowLaneRefreshMs: 1_000_000,
    });

    await handle.runTick();
    await handle.runTick();
    await handle.runTick();

    // Fast lane ran each tick; slow lane only on tick 1 (initial deadline 0).
    expect(fetchers.nowPlaying).toHaveBeenCalledTimes(3);
    expect(fetchers.duolingo).toHaveBeenCalledTimes(1);
    expect(fetchers.github).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});

describe("startPollLoop — degradation", () => {
  it("keeps polling when Redis write fails (never throws upward)", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    // Silence expected errors.
    jest.spyOn(console, "error").mockImplementation(() => {});

    // Every subsequent Redis command errors. Publish must still fire.
    redis.queueError(new Error("write failed"));
    redis.queueError(new Error("write failed"));

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    // Fetchers still ran even though snapshot writes failed.
    expect(fetchers.nowPlaying).toHaveBeenCalled();
    expect(fetchers.status).toHaveBeenCalled();

    // Publish still fired for now-playing (change from empty).
    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    expect(publishCalls.length).toBeGreaterThan(0);
    handle.stop();
  });

  it("skips a tick when a fetcher throws (never crashes the loop)", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    fetchers.nowPlaying.mockRejectedValueOnce(new Error("boom"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    // The status fetcher still ran even though now-playing threw first.
    expect(fetchers.status).toHaveBeenCalled();

    // No now-playing snapshot was written (fetcher threw), but subsequent
    // ticks recover on the next successful call.
    fetchers.nowPlaying.mockResolvedValueOnce({ playing: false });
    await handle.runTick();
    const snap = await readSnapshot(redis, ENV, "now-playing");
    expect(snap?.payload).toEqual({ playing: false });
    handle.stop();
  });

  it("does not publish when the realtime token is missing (no-op)", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, {
      ...buildConfig(),
      publisher: {
        gatewayInternalUrl: "http://gateway:8080",
        realtimeToken: "", // missing → publish is a no-op
      },
    });
    await handle.runTick();
    expect(
      mockFetch.mock.calls.filter(([url]) => url === PUBLISH_URL)
    ).toHaveLength(0);
    handle.stop();
  });
});

describe("startPollLoop — lease failover mid-loop", () => {
  it("stops fetching immediately when the lease is lost mid-run", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, buildConfig());

    // Tick 1 as leader.
    await handle.runTick();
    expect(fetchers.nowPlaying).toHaveBeenCalledTimes(1);

    // Another instance seizes the lease.
    redis.seed(
      `portfolio-v6-api:${ENV}:upstream-leader`,
      "usurper",
      15_000
    );
    // Ensure our in-process leader state reflects the loss.
    jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await lease.tryRenew()).toBe(false);

    // Tick 2 must be a no-op: no upstream fetchers called, no snapshot written.
    fetchers.nowPlaying.mockClear();
    fetchers.status.mockClear();
    fetchers.duolingo.mockClear();
    fetchers.github.mockClear();
    await handle.runTick();
    expect(fetchers.nowPlaying).not.toHaveBeenCalled();
    expect(fetchers.status).not.toHaveBeenCalled();
    expect(fetchers.duolingo).not.toHaveBeenCalled();
    expect(fetchers.github).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe("startPollLoop — in-process snapshot cache", () => {
  it("exposes the leader's last payload via readLocalSnapshot", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    fetchers.nowPlaying.mockResolvedValueOnce({ playing: false });

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    expect(readLocalSnapshot("now-playing")).toEqual({ playing: false });
    handle.stop();
  });
});

describe("stableStringify", () => {
  it("sorts keys for change-detection", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(
      stableStringify({ b: 2, a: 1 })
    );
  });

  it("handles arrays and nested objects", () => {
    expect(stableStringify({ x: [{ b: 2, a: 1 }] })).toBe(
      stableStringify({ x: [{ a: 1, b: 2 }] })
    );
  });
});
