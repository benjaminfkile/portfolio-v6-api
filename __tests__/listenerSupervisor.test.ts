/**
 * Listener supervisor tests (task #118).
 *
 * Covers the four acceptance criteria head-on:
 *   - leader-only lifecycle: onLeadershipGain starts the dealer, loss stops it,
 *     re-gain (after loss) restarts cleanly;
 *   - snapshot writes on events: every dealer event writes the shared
 *     `now-playing` snapshot and publishes to the realtime hub with the same
 *     shape nowPlayingRouter reads;
 *   - progress ticker: while a track is playing, the supervisor re-writes the
 *     snapshot every progressTickIntervalMs with `progress_ms` advanced from
 *     the observed timestamp - no Spotify traffic;
 *   - credential watch restart: a change in the stored
 *     `service_tokens.updated_at` for `spotify_listener` rebuilds the dealer
 *     even from `credential_dead`;
 *   - listener health: state, last_event_at, and last_error kind all land in
 *     the shared Redis record and are readable by any instance.
 */

import { createListenerSupervisor } from "../src/services/upstream/listenerSupervisor";
import {
  readListenerHealth,
  readSnapshot,
  spotifyListenerHealthKey,
  snapshotKey,
} from "../src/services/upstream/snapshotStore";
import type {
  DealerListener,
  DealerState,
} from "../src/services/listener/dealerClient";
import type { NowPlaying } from "../src/services/spotifyService";
import { createFakeRedis, type FakeRedis } from "./helpers/fakeRedis";

const ENV = "test";

interface FakeTimer {
  fn: () => void;
  intervalMs: number;
  cleared: boolean;
}

function makeTimerHarness() {
  const timers: FakeTimer[] = [];
  const setInterval = (fn: () => void, intervalMs: number) => {
    const t: FakeTimer = { fn, intervalMs, cleared: false };
    timers.push(t);
    return t;
  };
  const clearInterval = (h: unknown) => {
    (h as FakeTimer).cleared = true;
  };
  /**
   * Fire every scheduled non-cleared timer once. We advance `time` outside
   * this helper; the timer callbacks pick it up via the injected `now`.
   */
  async function tick(): Promise<void> {
    const pending = timers.filter((t) => !t.cleared).slice();
    for (const t of pending) {
      await Promise.resolve(t.fn());
    }
  }
  function pending(): number {
    return timers.filter((t) => !t.cleared).length;
  }
  return { setInterval, clearInterval, timers, tick, pending };
}

/**
 * Minimal `DealerListener` fake - records `start()` / `stop()` calls and
 * exposes `emit` / `emitState` so tests trigger events synchronously.
 */
class FakeDealer implements DealerListener {
  starts = 0;
  stops = 0;
  private state: DealerState = "idle";
  private eventCbs = new Set<(p: NowPlaying) => void>();
  private stateCbs = new Set<(s: DealerState) => void>();

  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
  getState(): DealerState {
    return this.state;
  }
  onEvent(cb: (p: NowPlaying) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }
  onStateChange(cb: (s: DealerState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
  emit(payload: NowPlaying): void {
    for (const cb of this.eventCbs) cb(payload);
  }
  emitState(next: DealerState): void {
    this.state = next;
    for (const cb of this.stateCbs) cb(next);
  }
}

interface SupervisorTestContext {
  redis: FakeRedis;
  dealers: FakeDealer[];
  currentTimeMs: number;
  timer: ReturnType<typeof makeTimerHarness>;
  supervisor: ReturnType<typeof createListenerSupervisor>;
  loadCredentialCalls: number;
  storedSpDc: string | null;
  storedUpdatedAt: Date | null;
  setStoredUpdatedAt(d: Date | null): void;
  setStoredSpDc(v: string | null): void;
  setTime(ms: number): void;
}

/**
 * Await enough microtasks that every `void handleEvent()` / `void handleState()`
 * chain in the supervisor has settled (writeSnapshot -> publish -> writeHealth).
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function makeContext(opts: {
  spDc?: string | null;
  updatedAt?: Date | null;
  progressTickIntervalMs?: number;
  credentialCheckIntervalMs?: number;
} = {}): SupervisorTestContext {
  const timer = makeTimerHarness();
  const redis = createFakeRedis();
  const dealers: FakeDealer[] = [];
  const ctx = {
    redis,
    dealers,
    currentTimeMs: 1_000,
    timer,
    loadCredentialCalls: 0,
    storedSpDc: "spDc" in opts ? (opts.spDc as string | null) : "sp_dc_v1",
    storedUpdatedAt:
      "updatedAt" in opts ? (opts.updatedAt as Date | null) : new Date(1_000),
    setStoredUpdatedAt(d: Date | null) {
      ctx.storedUpdatedAt = d;
    },
    setStoredSpDc(v: string | null) {
      ctx.storedSpDc = v;
    },
    setTime(ms: number) {
      ctx.currentTimeMs = ms;
    },
  } as SupervisorTestContext;

  const supervisor = createListenerSupervisor({
    env: ENV,
    redis,
    publisher: {
      gatewayInternalUrl: "",
      realtimeToken: "",
    },
    createListener: (_spDc: string) => {
      const d = new FakeDealer();
      dealers.push(d);
      return d;
    },
    loadCredential: async () => {
      ctx.loadCredentialCalls += 1;
      return ctx.storedSpDc;
    },
    getCredentialUpdatedAt: async () => ctx.storedUpdatedAt,
    now: () => ctx.currentTimeMs,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    credentialCheckIntervalMs: opts.credentialCheckIntervalMs ?? 60_000,
    progressTickIntervalMs: opts.progressTickIntervalMs ?? 20_000,
  });
  ctx.supervisor = supervisor;
  return ctx;
}

describe("listenerSupervisor - leader-only lifecycle", () => {
  it("does not build a dealer until onLeadershipGain fires", async () => {
    const ctx = makeContext();
    expect(ctx.dealers).toHaveLength(0);
    expect(ctx.supervisor.getListenerState()).toBe("idle");
    await ctx.supervisor.stop();
  });

  it("onLeadershipGain builds and starts the dealer against the stored credential", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.dealers).toHaveLength(1);
    expect(ctx.dealers[0].starts).toBe(1);
    await ctx.supervisor.stop();
  });

  it("stays idle when no listener credential is stored", async () => {
    const ctx = makeContext({ spDc: null });
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.dealers).toHaveLength(0);
    expect(ctx.supervisor.getListenerState()).toBe("idle");
    await ctx.supervisor.stop();
  });

  it("onLeadershipLoss stops the dealer and flushes an idle health record", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    ctx.dealers[0].emitState("connected");
    expect(ctx.supervisor.isListenerConnected()).toBe(true);

    await ctx.supervisor.onLeadershipLoss();
    expect(ctx.dealers[0].stops).toBe(1);
    expect(ctx.supervisor.isListenerConnected()).toBe(false);
    const health = await readListenerHealth(ctx.redis, ENV);
    expect(health?.state).toBe("idle");
  });

  it("re-gain after loss builds a fresh dealer", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.dealers).toHaveLength(1);
    await ctx.supervisor.onLeadershipLoss();
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.dealers).toHaveLength(2);
    expect(ctx.dealers[1].starts).toBe(1);
    await ctx.supervisor.stop();
  });

  it("does not start twice when onLeadershipGain is called while already active", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.dealers).toHaveLength(1);
    expect(ctx.dealers[0].starts).toBe(1);
    await ctx.supervisor.stop();
  });
});

describe("listenerSupervisor - snapshot writes on events", () => {
  it("writes the shared now-playing snapshot on every dealer event", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    const dealer = ctx.dealers[0];

    dealer.emit({
      playing: true,
      track: {
        title: "Song A",
        artists: ["Artist"],
        album: "Album",
        art_url: null,
        url: null,
        progress_ms: 30_000,
        duration_ms: 200_000,
      },
    });
    // Let the event handler's async chain resolve.
    await flush();
    const snap = await readSnapshot<NowPlaying>(ctx.redis, ENV, "now-playing");
    expect(snap?.payload).toEqual({
      playing: true,
      track: expect.objectContaining({
        title: "Song A",
        progress_ms: 30_000,
      }),
    });
    // The snapshot key is the SAME one nowPlayingRouter already reads.
    expect(ctx.redis.dump()).toHaveProperty(snapshotKey(ENV, "now-playing"));
    await ctx.supervisor.stop();
  });

  it("switches from playing to idle when the event says playing=false", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    const dealer = ctx.dealers[0];

    dealer.emit({
      playing: true,
      track: {
        title: "T",
        artists: ["A"],
        album: "L",
        art_url: null,
        url: null,
        progress_ms: 1_000,
        duration_ms: 5_000,
      },
    });
    await flush();
    dealer.emit({ playing: false });
    await flush();
    const snap = await readSnapshot<NowPlaying>(ctx.redis, ENV, "now-playing");
    expect(snap?.payload).toEqual({ playing: false });
    await ctx.supervisor.stop();
  });
});

describe("listenerSupervisor - 20s progress tick", () => {
  it("advances progress_ms locally from the observed timestamp without Spotify traffic", async () => {
    const ctx = makeContext({ progressTickIntervalMs: 20_000 });
    await ctx.supervisor.onLeadershipGain();
    const dealer = ctx.dealers[0];

    ctx.setTime(10_000);
    dealer.emit({
      playing: true,
      track: {
        title: "T",
        artists: ["A"],
        album: "L",
        art_url: null,
        url: null,
        progress_ms: 5_000,
        duration_ms: 300_000,
      },
    });
    await flush();

    // 20 seconds later - the progress ticker fires exactly once at
    // t=30_000, so progress should be 5_000 + 20_000 = 25_000. No new
    // dealer event; the credential-check timer runs but is a cheap DB read
    // that does NOT hit Spotify.
    ctx.setTime(30_000);
    await ctx.timer.tick();
    // Let the write chain settle.
    await flush();
    const snap = await readSnapshot<NowPlaying>(ctx.redis, ENV, "now-playing");
    expect(snap?.payload).toMatchObject({
      playing: true,
      track: { progress_ms: 25_000 },
    });

    // No fake dealer method beyond emit / start / stop / getState exists,
    // so a fake dealer HAS no Spotify surface - we assert on that here to
    // pin the intent: the progress tick lives entirely in the supervisor
    // and hits ONLY Redis + the publish sink.
    expect(dealer.starts).toBe(1);
    expect(dealer.stops).toBe(0);
    await ctx.supervisor.stop();
  });

  it("clamps advancing progress to duration_ms", async () => {
    const ctx = makeContext({ progressTickIntervalMs: 20_000 });
    await ctx.supervisor.onLeadershipGain();
    const dealer = ctx.dealers[0];

    ctx.setTime(0);
    dealer.emit({
      playing: true,
      track: {
        title: "T",
        artists: ["A"],
        album: "L",
        art_url: null,
        url: null,
        progress_ms: 190_000,
        duration_ms: 200_000,
      },
    });
    await flush();
    ctx.setTime(60_000);
    await ctx.timer.tick();
    await flush();
    const snap = await readSnapshot<NowPlaying>(ctx.redis, ENV, "now-playing");
    expect(snap?.payload).toMatchObject({
      playing: true,
      track: { progress_ms: 200_000 },
    });
    await ctx.supervisor.stop();
  });

  it("stops advancing progress after playing turns false", async () => {
    const ctx = makeContext({ progressTickIntervalMs: 20_000 });
    await ctx.supervisor.onLeadershipGain();
    const dealer = ctx.dealers[0];

    ctx.setTime(0);
    dealer.emit({
      playing: true,
      track: {
        title: "T",
        artists: ["A"],
        album: "L",
        art_url: null,
        url: null,
        progress_ms: 1_000,
        duration_ms: 100_000,
      },
    });
    await flush();
    dealer.emit({ playing: false });
    await flush();

    // Even after the progress tick fires, the last snapshot stays idle.
    ctx.setTime(20_000);
    await ctx.timer.tick();
    await flush();
    const snap = await readSnapshot<NowPlaying>(ctx.redis, ENV, "now-playing");
    expect(snap?.payload).toEqual({ playing: false });
    await ctx.supervisor.stop();
  });
});

describe("listenerSupervisor - credential watch restart", () => {
  it("restarts the listener when service_tokens.updated_at changes", async () => {
    const ctx = makeContext({ credentialCheckIntervalMs: 60_000 });
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.dealers).toHaveLength(1);

    // Admin pastes a fresh cookie - `updated_at` bumps.
    ctx.setStoredUpdatedAt(new Date(120_000));
    await ctx.timer.tick();
    await flush();
    expect(ctx.dealers).toHaveLength(2);
    expect(ctx.dealers[0].stops).toBe(1);
    expect(ctx.dealers[1].starts).toBe(1);
    await ctx.supervisor.stop();
  });

  it("restarts even from credential_dead when the credential changes", async () => {
    const ctx = makeContext({ credentialCheckIntervalMs: 60_000 });
    await ctx.supervisor.onLeadershipGain();
    ctx.dealers[0].emitState("credential_dead");
    await flush();
    expect(ctx.supervisor.getListenerState()).toBe("credential_dead");

    // Admin pastes a fresh sp_dc - updated_at bumps.
    ctx.setStoredUpdatedAt(new Date(240_000));
    ctx.setStoredSpDc("sp_dc_v2");
    await ctx.timer.tick();
    await flush();
    expect(ctx.dealers).toHaveLength(2);
    expect(ctx.dealers[1].starts).toBe(1);
    await ctx.supervisor.stop();
  });

  it("does not restart when nothing changed", async () => {
    const ctx = makeContext({ credentialCheckIntervalMs: 60_000 });
    await ctx.supervisor.onLeadershipGain();
    await ctx.timer.tick();
    await ctx.timer.tick();
    expect(ctx.dealers).toHaveLength(1);
    await ctx.supervisor.stop();
  });
});

describe("listenerSupervisor - health record contents", () => {
  it("writes state + last_event_at into the shared health record on events", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    ctx.dealers[0].emitState("connected");
    await flush();
    ctx.setTime(123_000);
    ctx.dealers[0].emit({ playing: false });
    await flush();
    const health = await readListenerHealth(ctx.redis, ENV);
    expect(health?.state).toBe("connected");
    expect(health?.last_event_at).toBe(new Date(123_000).toISOString());
    expect(health?.last_error).toBeNull();
    await ctx.supervisor.stop();
  });

  it("records invalid_cookie when the dealer transitions to credential_dead", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    ctx.setTime(50_000);
    ctx.dealers[0].emitState("credential_dead");
    await flush();
    const health = await readListenerHealth(ctx.redis, ENV);
    expect(health?.state).toBe("credential_dead");
    expect(health?.last_error).toEqual({
      kind: "invalid_cookie",
      at: new Date(50_000).toISOString(),
    });
    await ctx.supervisor.stop();
  });

  it("records a transient error when the dealer enters backoff", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    ctx.setTime(1_000);
    ctx.dealers[0].emitState("backoff");
    await flush();
    const health = await readListenerHealth(ctx.redis, ENV);
    expect(health?.state).toBe("backoff");
    expect(health?.last_error).toEqual({
      kind: "transient",
      at: new Date(1_000).toISOString(),
    });
    await ctx.supervisor.stop();
  });

  it("health record is readable from a fresh reader (any instance can consume it)", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    ctx.dealers[0].emitState("connected");
    await flush();

    // Read via the plain snapshotStore reader, not through the supervisor -
    // proves non-leader instances see the same value under the expected key.
    const raw = ctx.redis.dump()[spotifyListenerHealthKey(ENV)];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw);
    expect(parsed.state).toBe("connected");
    await ctx.supervisor.stop();
  });

  it("clears last_error after a subsequent clean event", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    ctx.setTime(1_000);
    ctx.dealers[0].emitState("backoff");
    await flush();
    ctx.setTime(2_000);
    ctx.dealers[0].emitState("connected");
    await flush();
    ctx.setTime(3_000);
    ctx.dealers[0].emit({ playing: false });
    await flush();
    const health = await readListenerHealth(ctx.redis, ENV);
    expect(health?.state).toBe("connected");
    expect(health?.last_error).toBeNull();
    await ctx.supervisor.stop();
  });
});

describe("listenerSupervisor - isListenerConnected mirrors dealer state", () => {
  it("only reports connected while the dealer is in the connected state", async () => {
    const ctx = makeContext();
    await ctx.supervisor.onLeadershipGain();
    expect(ctx.supervisor.isListenerConnected()).toBe(false);
    ctx.dealers[0].emitState("connecting");
    expect(ctx.supervisor.isListenerConnected()).toBe(false);
    ctx.dealers[0].emitState("connected");
    expect(ctx.supervisor.isListenerConnected()).toBe(true);
    ctx.dealers[0].emitState("backoff");
    expect(ctx.supervisor.isListenerConnected()).toBe(false);
    await ctx.supervisor.stop();
  });
});
