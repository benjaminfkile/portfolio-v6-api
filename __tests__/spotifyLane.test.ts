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
  SPOTIFY_DRIFT_CHECK_MS,
  SPOTIFY_MIN_PREDICTIVE_INTERVAL_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
  SPOTIFY_TRACK_END_MARGIN_MS,
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
    isDisabled: async () => false,
    isAuthSuspended: () => false,
    getBackoffUntilMs: () => 0,
    applyAuthSuspension: () => undefined,
    applyBackoffUntil: () => undefined,
    clearBackoff: () => undefined,
    resumeAuth: () => undefined,
    getStoredTokenUpdatedAt: async () => null,
    getPresenceCount: async () => 0,
    getLastPublicRequestAt: async () => null,
    readSharedSuspension: async () => null,
    writeSharedSuspension: async () => undefined,
    clearSharedSuspension: async () => undefined,
    // Task #112 health-record deps — defaults are inert (null health, no-op
    // writes) so existing tests don't have to construct them.
    readLocalHealth: () => ({ last_success_at: null, last_error: null }),
    readSharedHealth: async () => null,
    writeSharedHealth: async () => undefined,
    applyHealthMirror: () => undefined,
    ...overrides,
  };
}

describe("spotifyLane — viewer-aware cadence (predictive, task #119)", () => {
  it("with a viewer + no payload yet, uses the drift-check ceiling (60s) between fetches", async () => {
    // Task #119 - the every-tick fast cadence is gone; without a payload
    // the lane falls back to the drift-check ceiling. Two viewers pinging
    // ticks 5s apart must NOT trigger a Spotify call each time.
    const deps = buildDeps({ getPresenceCount: async () => 3 });
    const lane = createSpotifyLane(deps, buildConfig());
    // Idle-to-active transition forces the first fetch immediately.
    expect(await lane.planTick(0)).toBe("fetch");
    // Within 60s of the first fetch: skipped (drift-check floor).
    expect(await lane.planTick(5_000)).toBe("skip-idle");
    expect(await lane.planTick(30_000)).toBe("skip-idle");
    expect(await lane.planTick(59_000)).toBe("skip-idle");
    // Past the drift-check deadline: another fetch.
    expect(await lane.planTick(60_500)).toBe("fetch");
  });

  it("polls once when a public request lands inside the window", async () => {
    const deps = buildDeps({
      getPresenceCount: async () => 0,
      getLastPublicRequestAt: async () => new Date(1000),
    });
    const lane = createSpotifyLane(deps, buildConfig());
    // 100s later - well inside the 5-minute window. Presence-driven active
    // triggers an immediate fetch (idle-to-active transition).
    expect(await lane.planTick(101_000)).toBe("fetch");
    // Task #119 - subsequent tick within the drift-check window is skipped.
    expect(await lane.planTick(120_000)).toBe("skip-idle");
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

  it("on idle → active transition, forces an immediate poll (task #119 preserved behavior)", async () => {
    let presence = 0;
    const deps = buildDeps({
      getPresenceCount: async () => presence,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    // Idle tick — polls once (nextDueAt=0 seed), then goes quiet for the
    // idle interval.
    expect(await lane.planTick(1_000)).toBe("fetch");
    expect(await lane.planTick(60_000)).toBe("skip-idle");

    // A viewer appears — the very next tick MUST fetch, not wait for the
    // idle deadline (5min) or the drift-check window. The presence cache
    // would otherwise hold the "no viewer" answer for 30s; advance past it
    // so the lane re-reads presence.
    presence = 1;
    const afterCache = 60_000 + SPOTIFY_PRESENCE_CACHE_MS + 1_000;
    expect(await lane.planTick(afterCache)).toBe("fetch");
    // Task #119 - subsequent ticks within the drift-check window skip
    // (no every-tick fast lane anymore).
    expect(await lane.planTick(afterCache + 5_000)).toBe("skip-idle");
    // Past the drift-check ceiling: fetch again.
    expect(
      await lane.planTick(afterCache + SPOTIFY_DRIFT_CHECK_MS + 1_000)
    ).toBe("fetch");
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
  it("counts a presence throw as active (never blocks the fallback lane)", async () => {
    const deps = buildDeps({
      getPresenceCount: async () => {
        throw new Error("gateway down");
      },
    });
    const lane = createSpotifyLane(deps, buildConfig());
    expect(await lane.planTick(1_000)).toBe("fetch");
    // Task #119 - drift-check applies while active; the immediate re-tick
    // skips (cached presence is still active, but nextDueAt is 60s out).
    expect(await lane.planTick(5_000)).toBe("skip-idle");
    // Past the drift-check window, another fetch.
    expect(await lane.planTick(1_000 + SPOTIFY_DRIFT_CHECK_MS + 100)).toBe(
      "fetch"
    );
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

describe("spotifyLane — predictive cadence (task #119)", () => {
  function playingPayload(progressMs: number, durationMs: number) {
    return {
      playing: true,
      track: {
        title: "Track",
        artists: ["Artist"],
        album: "Album",
        art_url: null,
        url: null,
        progress_ms: progressMs,
        duration_ms: durationMs,
      },
    };
  }

  it("schedules the next fetch at (track end + 2s) for short remaining time", async () => {
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    // Idle-to-active: first tick fetches immediately.
    expect(await lane.planTick(0)).toBe("fetch");
    // Fetch returned a track with 40s remaining. Predicted next = 42s (well
    // inside the drift-check ceiling of 60s and above the 15s floor).
    await lane.reconcileAfterFetch(0, playingPayload(160_000, 200_000));

    // Just before end + 2s: skip.
    expect(await lane.planTick(41_500)).toBe("skip-idle");
    // Right past end + 2s: fetch.
    expect(await lane.planTick(42_500)).toBe("fetch");
  });

  it("caps very long tracks at the 60s drift-check ceiling", async () => {
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("fetch");
    // Track with 10 minutes remaining. Predicted end + 2 = 602s, but clamp
    // + drift-check ceiling pin the next fetch to 60s.
    await lane.reconcileAfterFetch(0, playingPayload(0, 10 * 60_000));

    expect(await lane.planTick(30_000)).toBe("skip-idle");
    expect(await lane.planTick(59_000)).toBe("skip-idle");
    expect(await lane.planTick(60_500)).toBe("fetch");
  });

  it("floors very short tracks at 15s (no bursty polling on rapid outros)", async () => {
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("fetch");
    // Track with 3 seconds remaining. Predicted end + 2 = 5s, floored to 15s.
    await lane.reconcileAfterFetch(0, playingPayload(197_000, 200_000));

    expect(await lane.planTick(10_000)).toBe("skip-idle");
    expect(await lane.planTick(14_500)).toBe("skip-idle");
    expect(await lane.planTick(15_500)).toBe("fetch");
  });

  it("active + not-playing schedules the next fetch at the drift-check ceiling", async () => {
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("fetch");
    // Fetch returned an idle payload (nothing playing).
    await lane.reconcileAfterFetch(0, { playing: false });

    expect(await lane.planTick(30_000)).toBe("skip-idle");
    expect(await lane.planTick(SPOTIFY_DRIFT_CHECK_MS + 500)).toBe("fetch");
  });

  it("null payload keeps planTick's conservative default (60s while active)", async () => {
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("fetch");
    // Fetcher was short-circuited (e.g. rate-limited); no payload.
    await lane.reconcileAfterFetch(0, null);

    expect(await lane.planTick(30_000)).toBe("skip-idle");
    expect(await lane.planTick(SPOTIFY_DRIFT_CHECK_MS + 100)).toBe("fetch");
  });

  it("proves the playing quota ceiling: at most ~2 Spotify calls per minute averaged over an hour", async () => {
    // Averaged over 3600 seconds we should never exceed ~2 calls/min under
    // the new predictive cadence. Simulate a viewer + one long track that
    // exercises the drift-check ceiling for the full hour.
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    let fetches = 0;
    // Tick the lane every 5 seconds for one hour (real-world poll base).
    for (let now = 0; now < 3_600_000; now += 5_000) {
      const decision = await lane.planTick(now);
      if (decision === "fetch") {
        fetches += 1;
        // Simulate a very long track so the drift-check ceiling is what
        // governs cadence for the entire hour.
        await lane.reconcileAfterFetch(now, playingPayload(0, 10 * 60_000));
      }
    }
    // Drift-check ceiling is 60s -> at most 60 fetches per hour == 1/min
    // averaged. Even with the mandatory first (idle-to-active) tick, we
    // stay well under the "about 2 per minute" acceptance ceiling.
    expect(fetches).toBeLessThanOrEqual(60);
    expect(fetches / 60).toBeLessThanOrEqual(2); // 2 per minute ceiling
  });

  it("proves the mixed-track ceiling stays under 2 calls/min for realistic short tracks", async () => {
    // With 3-minute tracks the natural rhythm is: end-of-track fetch every
    // 3 minutes + drift-checks at 60s intervals in between. That's roughly
    // 1 call per minute averaged - still safely under the "about 2 per
    // minute" ceiling from the task's acceptance criterion.
    const deps = buildDeps({ getPresenceCount: async () => 5 });
    const lane = createSpotifyLane(deps, buildConfig());

    let fetches = 0;
    const TRACK_MS = 3 * 60_000;
    let trackStartMs = 0;
    for (let now = 0; now < 3_600_000; now += 5_000) {
      const decision = await lane.planTick(now);
      if (decision === "fetch") {
        fetches += 1;
        // If we're past the current track end, roll to the next track.
        if (now - trackStartMs >= TRACK_MS) trackStartMs = now;
        const progress = now - trackStartMs;
        await lane.reconcileAfterFetch(
          now,
          playingPayload(progress, TRACK_MS)
        );
      }
    }
    // 60 minutes / at most 60s per drift-check window = 60 fetches upper
    // bound, i.e. 1 per minute averaged. The acceptance criterion says
    // "about 2 per minute" which we clear with room to spare.
    expect(fetches / 60).toBeLessThanOrEqual(2);
  });
});

describe("spotifyLane — Redis is authoritative (task #97)", () => {
  it("clears local backoff mirror when the shared record is absent", async () => {
    // Local mirror says still-suspended, but the shared record is gone
    // (operator DEL). The lane MUST call clearBackoff so the fetcher wrapper
    // doesn't short-circuit on stale in-memory backoff.
    const clearBackoff = jest.fn();
    const deps = buildDeps({
      getBackoffUntilMs: () => 999_999,
      clearBackoff,
      readSharedSuspension: async () => null,
      getPresenceCount: async () => 1,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("fetch");
    expect(clearBackoff).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear local backoff on the shared-present skip-suspended path", async () => {
    // Shared record IS present — local mirror should stay as-is; only the
    // shared-absent branch clears the local backoff.
    const clearBackoff = jest.fn();
    const record = {
      suspended_until: new Date(500_000).toISOString(),
      reason: "429" as const,
      detail: "Spotify 429 backoff",
    };
    const deps = buildDeps({
      getBackoffUntilMs: () => 500_000,
      clearBackoff,
      readSharedSuspension: async () => record,
    });
    const lane = createSpotifyLane(deps, buildConfig());

    expect(await lane.planTick(0)).toBe("skip-suspended");
    expect(clearBackoff).not.toHaveBeenCalled();
  });
});

describe("spotifyLane — skip-listener-active (task #118)", () => {
  it("returns skip-listener-active whenever the listener is connected", async () => {
    const deps = buildDeps({
      isListenerConnected: () => true,
      // Deliberately set every other signal so the lane WOULD normally
      // fetch every tick - proves the listener check short-circuits before
      // suspension / viewer / idle logic.
      getPresenceCount: async () => 10,
      getLastPublicRequestAt: async () => new Date(0),
    });
    const lane = createSpotifyLane(deps, buildConfig());
    expect(await lane.planTick(1_000)).toBe("skip-listener-active");
    expect(await lane.planTick(6_000)).toBe("skip-listener-active");
    expect(await lane.planTick(11_000)).toBe("skip-listener-active");
  });

  it("does not short-circuit while the listener is idle / backoff / credential_dead", async () => {
    let connected = false;
    const deps = buildDeps({
      isListenerConnected: () => connected,
      getPresenceCount: async () => 3,
    });
    const lane = createSpotifyLane(deps, buildConfig());
    expect(await lane.planTick(0)).toBe("fetch");
    connected = true;
    expect(await lane.planTick(5_000)).toBe("skip-listener-active");
    // Task #119 - after the listener drops, the lane returns to its normal
    // predictive cadence. At t=10s we're still within the 60s drift-check
    // window from the t=0 fetch, so this tick skip-idles rather than
    // fetching (proving the listener check is what gated the previous skip,
    // not the cadence). Advancing past the drift-check window unblocks it.
    connected = false;
    expect(await lane.planTick(10_000)).toBe("skip-idle");
    expect(await lane.planTick(SPOTIFY_DRIFT_CHECK_MS + 500)).toBe("fetch");
  });

  it("the admin disable flag still wins over listener-active", async () => {
    const deps = buildDeps({
      isDisabled: async () => true,
      isListenerConnected: () => true,
    });
    const lane = createSpotifyLane(deps, buildConfig());
    // Disabled path returns skip-suspended before it even reads the
    // listener flag - a hard disable trumps every other signal.
    expect(await lane.planTick(0)).toBe("skip-suspended");
  });
});
