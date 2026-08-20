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
 * Poll-loop tests.
 *
 * Now-playing is NOT driven by the poll loop anymore (it is listener-only); the
 * loop drives only the status, duolingo, and github lanes. Covered: only the
 * leader polls, change-detection publish (no publish when unchanged), slow-lane
 * cadence (Duolingo/GitHub don't fetch every tick), graceful degradation when
 * Redis errors on write, lease failover, and the in-process snapshot cache.
 */

const ENV = "test";
const PUBLISH_URL = publishUrl("http://gateway:8080");

const mockFetch = jest.fn();

interface Fetchers {
  status: jest.Mock;
  duolingo: jest.Mock;
  github: jest.Mock;
}

function buildFetchers(): Fetchers {
  return {
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
    expect(fetchers.status).not.toHaveBeenCalled();
    handle.stop();
  });

  it("does nothing on a runTick when we are not the leader", async () => {
    const redis = createFakeRedis();
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

    expect(fetchers.status).not.toHaveBeenCalled();
    expect(fetchers.duolingo).not.toHaveBeenCalled();
    expect(fetchers.github).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe("startPollLoop — status lane snapshot + publish", () => {
  it("writes the status snapshot on every tick and publishes on change", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    // First tick: degraded=false; second tick: degraded=true → change published.
    fetchers.status
      .mockResolvedValueOnce({ degraded: false, services: [] })
      .mockResolvedValueOnce({ degraded: true, services: [] });

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    await handle.runTick();

    expect(fetchers.status).toHaveBeenCalledTimes(2);

    const snap = await readSnapshot<{ degraded: boolean }>(redis, ENV, "status");
    expect(snap?.payload).toEqual({ degraded: true, services: [] });
    expect(snap?.fetched_at).toEqual(expect.any(String));

    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    const statusPublishes = publishCalls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return (
        body.channel === `${REALTIME_SERVICE_NAME}:status` &&
        body.event === "snapshot"
      );
    });
    // One for tick 1 (initial value counts as change), one for tick 2 (change).
    expect(statusPublishes).toHaveLength(2);

    // Wire contract: publish body carries the payload under `payload`, not `data`.
    for (const [, init] of publishCalls) {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toHaveProperty("payload");
      expect(body).not.toHaveProperty("data");
    }

    handle.stop();
  });

  it("does NOT publish when the status payload is unchanged", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    fetchers.status.mockResolvedValue({ degraded: false, services: [] });

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    await handle.runTick();
    await handle.runTick();

    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
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
    for (const [, init] of publishCalls) {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.channel).toMatch(new RegExp(`^${DEV_SERVICE}:`));
      expect(body.channel).not.toMatch(/^portfolio-v6-api:/);
    }
    const channels = publishCalls.map(([, init]) => {
      return JSON.parse((init as RequestInit).body as string).channel as string;
    });
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

  it("does NOT publish to a now-playing channel (listener-only)", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();
    await handle.runTick();

    const nowPlaying = mockFetch.mock.calls.filter(([url, init]) => {
      if (url !== PUBLISH_URL) return false;
      const body = JSON.parse((init as RequestInit).body as string);
      return body.channel === `${REALTIME_SERVICE_NAME}:now-playing`;
    });
    expect(nowPlaying).toHaveLength(0);
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
      slowLaneRefreshMs: 1_000_000,
    });

    await handle.runTick();
    await handle.runTick();
    await handle.runTick();

    // Status ran each tick; slow lane only on tick 1 (initial deadline 0).
    expect(fetchers.status).toHaveBeenCalledTimes(3);
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
    jest.spyOn(console, "error").mockImplementation(() => {});

    redis.queueError(new Error("write failed"));
    redis.queueError(new Error("write failed"));

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    expect(fetchers.status).toHaveBeenCalled();

    const publishCalls = mockFetch.mock.calls.filter(
      ([url]) => url === PUBLISH_URL
    );
    expect(publishCalls.length).toBeGreaterThan(0);
    handle.stop();
  });

  it("writes the degraded status when the status fetcher throws", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    fetchers.status.mockRejectedValueOnce(new Error("boom"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    const snap = await readSnapshot(redis, ENV, "status");
    expect(snap?.payload).toEqual({ degraded: true, services: [] });
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
        realtimeToken: "",
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

    await handle.runTick();
    expect(fetchers.status).toHaveBeenCalledTimes(1);

    redis.seed(`portfolio-v6-api:${ENV}:upstream-leader`, "usurper", 15_000);
    jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await lease.tryRenew()).toBe(false);

    fetchers.status.mockClear();
    fetchers.duolingo.mockClear();
    fetchers.github.mockClear();
    await handle.runTick();
    expect(fetchers.status).not.toHaveBeenCalled();
    expect(fetchers.duolingo).not.toHaveBeenCalled();
    expect(fetchers.github).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe("startPollLoop — in-process snapshot cache", () => {
  it("exposes the leader's last status payload via readLocalSnapshot", async () => {
    const redis = createFakeRedis();
    const lease = await acquireLease(redis);
    const fetchers = buildFetchers();
    fetchers.status.mockResolvedValueOnce({ degraded: false, services: [] });

    const handle = startPollLoop(redis, lease, fetchers, buildConfig());
    await handle.runTick();

    expect(readLocalSnapshot("status")).toEqual({
      degraded: false,
      services: [],
    });
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
