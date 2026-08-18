/**
 * Unit tests for the viewer-aware + auth-aware Spotify lane (task #95).
 *
 * The lane is a pure decision function around injected signals — this file
 * covers each planTick branch with a fake dep bundle. The end-to-end
 * poll-loop integration (real fetchers, real Redis, real presence GET) is
 * covered in spotifyLaneIntegration.test.ts.
 */

import {
  createSpotifyLane,
  DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
  SPOTIFY_AUTH_RESUME_CHECK_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
  type SpotifyLaneDeps,
} from "../src/services/upstream/spotifyLane";

function buildConfig() {
  return {
    publicRequestWindowMs: SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
    presenceCacheMs: SPOTIFY_PRESENCE_CACHE_MS,
    authResumeCheckMs: SPOTIFY_AUTH_RESUME_CHECK_MS,
    idleIntervalMs: DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  };
}

function buildDeps(overrides: Partial<SpotifyLaneDeps> = {}): SpotifyLaneDeps {
  return {
    isAuthSuspended: () => false,
    getBackoffUntilMs: () => 0,
    applyAuthSuspension: () => undefined,
    applyBackoffUntil: () => undefined,
    resumeAuth: () => undefined,
    getStoredTokenUpdatedAt: async () => null,
    getPresenceCount: async () => 0,
    getLastPublicRequestAt: async () => null,
    readSharedSuspension: async () => null,
    writeSharedSuspension: async () => undefined,
    clearSharedSuspension: async () => undefined,
    ...overrides,
  };
}

describe("spotifyLane — viewer-aware cadence", () => {
  it("polls every tick while at least one client is subscribed (presence>0)", async () => {
    const deps = buildDeps({ getPresenceCount: async () => 3 });
    const lane = createSpotifyLane(deps, buildConfig());
    expect(await lane.planTick(0)).toBe("fetch");
    expect(await lane.planTick(5_000)).toBe("fetch");
    expect(await lane.planTick(10_000)).toBe("fetch");
  });

  it("polls every tick when a public request landed inside the window", async () => {
    const deps = buildDeps({
      getPresenceCount: async () => 0,
      getLastPublicRequestAt: async () => new Date(1000),
    });
    const lane = createSpotifyLane(deps, buildConfig());
    // 100s later — well inside the 5-minute window.
    expect(await lane.planTick(101_000)).toBe("fetch");
  });

  it("drops to the idle cadence with zero calls between polls", async () => {
    const deps = buildDeps({
      getPresenceCount: async () => 0,
      getLastPublicRequestAt: async () => null,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // First idle tick — nextDueAt starts at 0, so we fetch once immediately.
    expect(await lane.planTick(1_000)).toBe("fetch");
    // Every tick over the next 5 minutes is skipped.
    expect(await lane.planTick(60_000)).toBe("skip-idle");
    expect(await lane.planTick(120_000)).toBe("skip-idle");
    expect(await lane.planTick(240_000)).toBe("skip-idle");
    // Just before the 5-minute deadline — still skipped.
    expect(await lane.planTick(1_000 + 4 * 60_000 + 59_000)).toBe("skip-idle");
    // After the deadline elapses — fetch again.
    expect(await lane.planTick(1_000 + 5 * 60_000 + 500)).toBe("fetch");
    // Fresh 5-minute window opens after the poll.
    expect(await lane.planTick(1_000 + 5 * 60_000 + 60_000)).toBe("skip-idle");
  });

  it("restores fast cadence with an immediate poll on idle → active transition", async () => {
    let presence = 0;
    const deps = buildDeps({
      getPresenceCount: async () => presence,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // Idle tick.
    expect(await lane.planTick(1_000)).toBe("fetch");
    expect(await lane.planTick(60_000)).toBe("skip-idle");

    // A viewer appears — the very next tick must fetch, not wait 5 minutes.
    // The presence cache would otherwise hold the "no viewer" answer for 30s;
    // we advance past it so the lane rereads presence.
    presence = 1;
    const afterCache = 60_000 + SPOTIFY_PRESENCE_CACHE_MS + 1_000;
    expect(await lane.planTick(afterCache)).toBe("fetch");
    // And keeps fetching every tick.
    expect(await lane.planTick(afterCache + 5_000)).toBe("fetch");
  });

  it("keeps polling immediately on a public request even after idle timer", async () => {
    let last: Date | null = null;
    const deps = buildDeps({
      getPresenceCount: async () => 0,
      getLastPublicRequestAt: async () => last,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // Idle at t=1000; skip 60s later.
    expect(await lane.planTick(1_000)).toBe("fetch");
    expect(await lane.planTick(60_000)).toBe("skip-idle");
    // A visitor loads /api/now-playing — that lands in Redis.
    last = new Date(70_000);
    expect(await lane.planTick(71_000)).toBe("fetch");
  });
});

describe("spotifyLane — presence-API failure fails open", () => {
  it("counts a presence throw as active (never blocks the fast lane)", async () => {
    const deps = buildDeps({
      getPresenceCount: async () => {
        throw new Error("gateway down");
      },
    });
    const lane = createSpotifyLane(deps, buildConfig());
    expect(await lane.planTick(1_000)).toBe("fetch");
    // Presence is cached, so the next tick within the TTL doesn't rethrow.
    expect(await lane.planTick(5_000)).toBe("fetch");
  });
});

describe("spotifyLane — auth suspension (shared via Redis, task #96)", () => {
  function authRecord(untilMs: number, capturedAt?: string | null) {
    return {
      suspended_until: new Date(untilMs).toISOString(),
      reason: "auth" as const,
      detail: "invalid_grant on token refresh",
      captured_token_updated_at: capturedAt ?? null,
    };
  }

  it("skips every tick while shared record says auth-suspended", async () => {
    const record = authRecord(1_000_000, new Date(1_000).toISOString());
    const deps = buildDeps({
      isAuthSuspended: () => true,
      readSharedSuspension: async () => record,
      getStoredTokenUpdatedAt: async () => new Date(1_000),
      getPresenceCount: jest.fn(async () => 5), // wired but should not fire
    });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("skip-suspended");
    expect(await lane.planTick(5_000)).toBe("skip-suspended");
    expect(await lane.planTick(30_000)).toBe("skip-suspended");
    // Presence should NEVER be checked while suspended — we don't need to know
    // if viewers are around when the token is dead.
    expect(deps.getPresenceCount).not.toHaveBeenCalled();
  });

  it("does not re-read the token more often than authResumeCheckMs", async () => {
    const record = authRecord(10_000_000, new Date(1_000).toISOString());
    const getUpdated = jest.fn(async () => new Date(1_000));
    const deps = buildDeps({
      isAuthSuspended: () => true,
      readSharedSuspension: async () => record,
      getStoredTokenUpdatedAt: getUpdated,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // First tick — the captured snapshot came from the shared record, so the
    // DB is NOT read; that check waits until the throttle window elapses.
    await lane.planTick(0);
    expect(getUpdated).not.toHaveBeenCalled();

    // Ticks within the throttle window do NOT re-read.
    await lane.planTick(10_000);
    await lane.planTick(30_000);
    await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS - 1);
    expect(getUpdated).not.toHaveBeenCalled();

    // A tick past the throttle window re-reads exactly once.
    await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS + 100);
    expect(getUpdated).toHaveBeenCalledTimes(1);
  });

  it("resumes and forces an immediate poll when updated_at changes", async () => {
    let suspended = true;
    let updated = new Date(1_000);
    let sharedRecord: ReturnType<typeof authRecord> | null = authRecord(
      10_000_000,
      updated.toISOString()
    );
    const resumeAuth = jest.fn(() => {
      suspended = false;
    });
    const clearShared = jest.fn(async () => {
      sharedRecord = null;
    });
    const deps = buildDeps({
      isAuthSuspended: () => suspended,
      readSharedSuspension: async () => sharedRecord,
      clearSharedSuspension: clearShared,
      getStoredTokenUpdatedAt: async () => updated,
      resumeAuth,
      getPresenceCount: async () => 0,
      getLastPublicRequestAt: async () => null,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // Snapshot the current updated_at on the first suspended tick.
    expect(await lane.planTick(0)).toBe("skip-suspended");
    // Nothing changed by the next throttled recheck.
    updated = new Date(1_000);
    expect(
      await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS + 100)
    ).toBe("skip-suspended");
    expect(resumeAuth).not.toHaveBeenCalled();

    // Admin reconnects — updated_at changes.
    updated = new Date(500_000);
    expect(
      await lane.planTick(2 * SPOTIFY_AUTH_RESUME_CHECK_MS + 200)
    ).toBe("fetch");
    expect(resumeAuth).toHaveBeenCalledTimes(1);
    expect(clearShared).toHaveBeenCalledTimes(1);
  });

  it("resumes when a previously-absent token row appears", async () => {
    let suspended = true;
    let updated: Date | null = null;
    let sharedRecord: ReturnType<typeof authRecord> | null = authRecord(
      10_000_000,
      null
    );
    const resumeAuth = jest.fn(() => {
      suspended = false;
    });
    const clearShared = jest.fn(async () => {
      sharedRecord = null;
    });
    const deps = buildDeps({
      isAuthSuspended: () => suspended,
      readSharedSuspension: async () => sharedRecord,
      clearSharedSuspension: clearShared,
      getStoredTokenUpdatedAt: async () => updated,
      resumeAuth,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // Snapshot: no row yet.
    expect(await lane.planTick(0)).toBe("skip-suspended");
    // A row appears — that's a change too.
    updated = new Date(500_000);
    expect(
      await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS + 500)
    ).toBe("fetch");
    expect(resumeAuth).toHaveBeenCalledTimes(1);
  });

  it("mirrors the shared record into local state on a fresh leader", async () => {
    // The fresh leader observes an active shared record but its local
    // isAuthSuspended flag starts false. The lane must call applyAuthSuspension
    // so the HTTP request-path fallback (Redis outage) also honors it.
    const applyAuth = jest.fn();
    const record = authRecord(10_000_000, new Date(1_000).toISOString());
    const deps = buildDeps({
      isAuthSuspended: () => false, // fresh leader, local flag not set
      applyAuthSuspension: applyAuth,
      readSharedSuspension: async () => record,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("skip-suspended");
    expect(applyAuth).toHaveBeenCalledWith(record.detail);
  });

  it("mirrors a 429 shared record into the local backoff window", async () => {
    const applyBackoff = jest.fn();
    const record = {
      suspended_until: new Date(500_000).toISOString(),
      reason: "429" as const,
      detail: "Spotify 429 backoff",
    };
    const deps = buildDeps({
      readSharedSuspension: async () => record,
      applyBackoffUntil: applyBackoff,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("skip-suspended");
    expect(applyBackoff).toHaveBeenCalledWith(500_000);
  });

  it("with no shared suspension, clears local auth flag and continues (operator override)", async () => {
    // Local flag says suspended but Redis has no record (e.g. the operator
    // deleted the key). The lane must reconcile: clear local + fetch.
    let suspended = true;
    const resumeAuth = jest.fn(() => {
      suspended = false;
    });
    const deps = buildDeps({
      isAuthSuspended: () => suspended,
      resumeAuth,
      readSharedSuspension: async () => null,
      getPresenceCount: async () => 1, // active
    });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("fetch");
    expect(resumeAuth).toHaveBeenCalledTimes(1);
  });

  it("expired shared record (deadline in the past) is treated as no suspension", async () => {
    const stale = authRecord(500, new Date(0).toISOString()); // deadline passed
    let cleared = false;
    const deps = buildDeps({
      readSharedSuspension: async () => (cleared ? null : stale),
      clearSharedSuspension: async () => {
        cleared = true;
      },
      getPresenceCount: async () => 1,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // planTick at t=10_000: deadline (500) is in the past → fetch.
    expect(await lane.planTick(10_000)).toBe("fetch");
  });
});

describe("spotifyLane — reconcileAfterFetch", () => {
  function shared429() {
    return {
      suspended_until: new Date(3_600_000).toISOString(),
      reason: "429" as const,
      detail: "Spotify 429 backoff",
    };
  }

  it("writes a 429 record when local backoff is active after fetch", async () => {
    const writeShared: jest.Mock = jest.fn(async () => undefined);
    const deps = buildDeps({
      getBackoffUntilMs: () => 3_600_000,
      writeSharedSuspension: writeShared,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    await lane.reconcileAfterFetch(0);
    expect(writeShared).toHaveBeenCalledTimes(1);
    expect(writeShared.mock.calls[0][0]).toMatchObject({ reason: "429" });
  });

  it("writes an auth record when local auth is suspended after fetch", async () => {
    const writeShared: jest.Mock = jest.fn(async () => undefined);
    const deps = buildDeps({
      isAuthSuspended: () => true,
      writeSharedSuspension: writeShared,
      getStoredTokenUpdatedAt: async () => new Date(1_000),
    });
    const lane = createSpotifyLane(deps, buildConfig());

    await lane.reconcileAfterFetch(0);
    expect(writeShared).toHaveBeenCalledTimes(1);
    expect(writeShared.mock.calls[0][0]).toMatchObject({
      reason: "auth",
      captured_token_updated_at: new Date(1_000).toISOString(),
    });
  });

  it("clears the shared record when local state is now healthy", async () => {
    const clearShared = jest.fn(async () => undefined);
    const deps = buildDeps({
      isAuthSuspended: () => false,
      getBackoffUntilMs: () => 0,
      readSharedSuspension: async () => shared429(), // stale
      clearSharedSuspension: clearShared,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    await lane.reconcileAfterFetch(0);
    expect(clearShared).toHaveBeenCalledTimes(1);
  });
});
