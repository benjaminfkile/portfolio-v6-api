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
    resumeAuth: () => undefined,
    getStoredTokenUpdatedAt: async () => null,
    getPresenceCount: async () => 0,
    getLastPublicRequestAt: async () => null,
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

describe("spotifyLane — auth suspension", () => {
  it("skips every tick while auth is suspended and never re-invokes the fetcher", async () => {
    const deps = buildDeps({
      isAuthSuspended: () => true,
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
    const getUpdated = jest.fn(async () => new Date(1_000));
    const deps = buildDeps({
      isAuthSuspended: () => true,
      getStoredTokenUpdatedAt: getUpdated,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // First tick captures the snapshot.
    await lane.planTick(0);
    expect(getUpdated).toHaveBeenCalledTimes(1);

    // Ticks within the throttle window do NOT re-read.
    await lane.planTick(10_000);
    await lane.planTick(30_000);
    await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS - 1);
    expect(getUpdated).toHaveBeenCalledTimes(1);

    // A tick past the throttle window re-reads exactly once.
    await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS + 100);
    expect(getUpdated).toHaveBeenCalledTimes(2);
  });

  it("resumes and forces an immediate poll when updated_at changes", async () => {
    let suspended = true;
    let updated = new Date(1_000);
    const resumeAuth = jest.fn(() => {
      suspended = false;
    });
    const deps = buildDeps({
      isAuthSuspended: () => suspended,
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
  });

  it("resumes when a previously-absent token row appears", async () => {
    let suspended = true;
    let updated: Date | null = null;
    const resumeAuth = jest.fn(() => {
      suspended = false;
    });
    const deps = buildDeps({
      isAuthSuspended: () => suspended,
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

  it("captures a fresh snapshot on a NEW suspension after a resume", async () => {
    let suspended = true;
    let updated = new Date(1_000);
    const resumeAuth = jest.fn(() => {
      suspended = false;
    });
    const getUpdated = jest.fn(async () => updated);
    const deps = buildDeps({
      isAuthSuspended: () => suspended,
      getStoredTokenUpdatedAt: getUpdated,
      resumeAuth,
      getPresenceCount: async () => 1,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // Suspended → resumed via updated_at change.
    await lane.planTick(0);
    updated = new Date(2_000);
    await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS + 100);
    expect(resumeAuth).toHaveBeenCalledTimes(1);

    // A new suspension trips again — the lane must snapshot the NEW updated_at
    // as its reference, not the stale pre-resume one.
    getUpdated.mockClear();
    suspended = true;
    await lane.planTick(SPOTIFY_AUTH_RESUME_CHECK_MS + 200);
    expect(getUpdated).toHaveBeenCalledTimes(1); // fresh capture
  });
});
