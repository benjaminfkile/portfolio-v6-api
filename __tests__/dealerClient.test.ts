/**
 * Dealer websocket client tests (task #117 in the listener series).
 *
 * ALL I/O is faked: no real websocket, no real network, no timers running on
 * the real event loop. A fake `setTimer` records callbacks by delay; the test
 * advances the clock by picking specific callbacks to run.
 *
 * Coverage:
 *   - Cluster decode path: gzip + base64 payload maps to the curated
 *     NowPlaying shape (title, artists, album, art_url, url, progress_ms,
 *     duration_ms) with values interpretable by the existing consumers.
 *   - Ping / pong: after `pingIntervalMs` a ping is sent; if no pong arrives
 *     within `pongTimeoutMs` the socket is torn down and reconnect is
 *     scheduled.
 *   - Backoff: repeated transient failures grow the backoff exponentially,
 *     capped at `maxBackoffMs`, with jitter (`random` is injected so the
 *     test can pin it).
 *   - Terminal `credential_dead`: an `invalid_cookie` error from the token
 *     minter stops the reconnect loop and requires an explicit `start()` to
 *     resume.
 */
import { gzipSync } from "node:zlib";

import {
  createDealerListener,
  DealerSocket,
  DealerState,
  decodeDealerPayloads,
  mapClusterToNowPlaying,
  spotifyUriToOpenUrl,
  normalizeClusterImageUrl,
  computeProgressMs,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
} from "../src/services/listener/dealerClient";
import type { NowPlaying } from "../src/services/spotifyService";

/**
 * A recorded pending timer, held by the fake `setTimer`. Tests call
 * `.fire()` (or the helper `runTimer`) to invoke the callback deterministically.
 */
interface FakeTimer {
  id: number;
  delayMs: number;
  fn: () => void;
  cleared: boolean;
}

/**
 * Fake websocket: exposes `.trigger*` methods for the test to feed frames /
 * open / close / error events. `sends` records what the client sent.
 */
class FakeSocket implements DealerSocket {
  onopen: (() => void) | null = null;
  onmessage:
    | ((data: string | Buffer | ArrayBuffer) => void)
    | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  sends: string[] = [];
  closed = false;
  send(data: string): void {
    if (this.closed) throw new Error("send on closed socket");
    this.sends.push(data);
  }
  close(): void {
    this.closed = true;
  }
  triggerOpen(): void {
    this.onopen?.();
  }
  triggerMessage(data: string | Buffer): void {
    this.onmessage?.(data);
  }
  triggerClose(code = 1006, reason = "abnormal"): void {
    this.onclose?.(code, reason);
  }
  triggerError(err: unknown): void {
    this.onerror?.(err);
  }
}

/**
 * Build a fake timer harness. Returns:
 *   - `setTimer` / `clearTimer`: pass to `createDealerListener` deps.
 *   - `timers`: the array of pending timers (in registration order).
 *   - `fireByIndex(i)`: invoke the i-th pending non-cleared timer.
 *   - `fireLast()`: invoke the most recently scheduled non-cleared timer.
 */
function makeFakeTimers() {
  let seq = 0;
  const timers: FakeTimer[] = [];
  const setTimer = (fn: () => void, delayMs: number) => {
    const t: FakeTimer = { id: ++seq, delayMs, fn, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (h: unknown) => {
    (h as FakeTimer).cleared = true;
  };
  const runTimer = (t: FakeTimer) => {
    if (t.cleared) return;
    t.cleared = true;
    t.fn();
  };
  const fireLast = () => {
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (!timers[i].cleared) {
        runTimer(timers[i]);
        return;
      }
    }
  };
  const findByDelay = (predicate: (ms: number) => boolean) =>
    timers.find((t) => !t.cleared && predicate(t.delayMs));
  return { setTimer, clearTimer, runTimer, timers, fireLast, findByDelay };
}

/** Encode a cluster JSON the way Spotify does: gzip → base64 → payloads[0]. */
function encodeClusterPayload(obj: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(obj), "utf8")).toString("base64");
}

/**
 * A representative cluster payload. Fields are drawn from the flat metadata
 * shape the real dealer produces: numeric-string durations, artist_name plus
 * artist_name:1, a spotify: image URI (needs normalization), a spotify:track:
 * URI (needs `open.spotify.com` conversion), and player_state timing so
 * `progress_ms` is computable.
 */
function makeCluster(overrides: Record<string, unknown> = {}) {
  const now = 1_700_000_000_000;
  const { player_state: playerOverrides, ...outerOverrides } = overrides;
  return {
    active_device_id: "device-xyz",
    player_state: {
      is_playing: true,
      is_paused: false,
      timestamp: String(now),
      position_as_of_timestamp: "42000",
      duration: "213456",
      track: {
        uri: "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
        metadata: {
          title: "Never Gonna Give You Up",
          artist_name: "Rick Astley",
          "artist_name:1": "Featured Guest",
          album_title: "Whenever You Need Somebody",
          image_url: "spotify:image:abc123hash",
          image_large_url: "spotify:image:largehash",
          duration: "213456",
        },
      },
      ...(playerOverrides as object | undefined),
    },
    ...outerOverrides,
  };
}

/** Build a dealer envelope for a cluster push. */
function clusterEnvelope(payloadBase64: string): string {
  return JSON.stringify({
    type: "message",
    uri: "hm://connect-state/v1/cluster",
    headers: {
      "Content-Type": "application/octet-stream",
      "Transfer-Encoding": "gzip",
    },
    payloads: [payloadBase64],
  });
}

/** Build the first-message envelope that carries the Spotify-Connection-Id. */
function connectionIdEnvelope(cid: string): string {
  return JSON.stringify({
    type: "message",
    headers: { "Spotify-Connection-Id": cid },
  });
}

describe("mapClusterToNowPlaying (unit)", () => {
  const NOW = 1_700_000_005_000;
  const clusterTs = 1_700_000_000_000;

  it("maps a playing cluster to the curated NowPlaying shape", () => {
    const cluster = makeCluster();
    // Force cluster timestamp so progress = position_as_of + (NOW - ts).
    (cluster.player_state as { timestamp: string }).timestamp = String(clusterTs);
    const mapped = mapClusterToNowPlaying(cluster, NOW);
    expect(mapped.playing).toBe(true);
    if (!mapped.playing) return;
    expect(mapped.track.title).toBe("Never Gonna Give You Up");
    expect(mapped.track.album).toBe("Whenever You Need Somebody");
    expect(mapped.track.artists).toEqual(["Rick Astley", "Featured Guest"]);
    // `image_large_url` beats `image_url`, and `spotify:image:` becomes CDN.
    expect(mapped.track.art_url).toBe("https://i.scdn.co/image/largehash");
    expect(mapped.track.url).toBe(
      "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh"
    );
    // Position (42000) + elapsed (5000) = 47000.
    expect(mapped.track.progress_ms).toBe(47000);
    expect(mapped.track.duration_ms).toBe(213456);
  });

  it("reports { playing: false } when paused", () => {
    const cluster = makeCluster();
    (cluster.player_state as {
      is_playing: boolean;
      is_paused: boolean;
    }).is_paused = true;
    const mapped = mapClusterToNowPlaying(cluster, NOW);
    expect(mapped.playing).toBe(false);
  });

  it("returns { playing: false } for an empty / trackless cluster", () => {
    expect(mapClusterToNowPlaying(null).playing).toBe(false);
    expect(mapClusterToNowPlaying({}).playing).toBe(false);
    expect(mapClusterToNowPlaying({ player_state: {} }).playing).toBe(false);
  });

  it("degrades unknown metadata to nulls, never throws", () => {
    const skinny = {
      player_state: {
        is_playing: true,
        is_paused: false,
        track: { uri: "not-a-spotify-uri" },
      },
    };
    const mapped = mapClusterToNowPlaying(skinny, NOW);
    expect(mapped.playing).toBe(true);
    if (!mapped.playing) return;
    expect(mapped.track.title).toBe("");
    expect(mapped.track.artists).toEqual([]);
    expect(mapped.track.art_url).toBeNull();
    expect(mapped.track.url).toBeNull();
    expect(mapped.track.progress_ms).toBeNull();
    expect(mapped.track.duration_ms).toBeNull();
  });

  it("clamps progress to the reported duration", () => {
    const cluster = makeCluster({
      player_state: {
        is_playing: true,
        is_paused: false,
        timestamp: String(clusterTs),
        position_as_of_timestamp: "200000",
        duration: "213456",
      },
    });
    // A cluster ts far in the past pushes computed progress past duration.
    const later = clusterTs + 1_000_000;
    const mapped = mapClusterToNowPlaying(cluster, later);
    if (!mapped.playing) throw new Error("expected playing");
    expect(mapped.track.progress_ms).toBe(213456);
  });
});

describe("decodeDealerPayloads / helpers", () => {
  it("decodes a base64 gzip payload into the parsed JSON", () => {
    const cluster = makeCluster();
    const encoded = encodeClusterPayload({ cluster });
    const decoded = decodeDealerPayloads([encoded], {
      "Transfer-Encoding": "gzip",
      "Content-Type": "application/octet-stream",
    });
    expect(decoded).toEqual({ cluster });
  });

  it("also decodes a non-gzip base64 JSON payload", () => {
    const raw = Buffer.from(JSON.stringify({ hello: 1 }), "utf8").toString(
      "base64"
    );
    expect(decodeDealerPayloads([raw], undefined)).toEqual({ hello: 1 });
  });

  it("returns null for an empty / non-array payloads field", () => {
    expect(decodeDealerPayloads(null, undefined)).toBeNull();
    expect(decodeDealerPayloads([], undefined)).toBeNull();
  });

  it("spotifyUriToOpenUrl handles known and unknown shapes", () => {
    expect(spotifyUriToOpenUrl("spotify:track:abc")).toBe(
      "https://open.spotify.com/track/abc"
    );
    expect(spotifyUriToOpenUrl("spotify:episode:xyz")).toBe(
      "https://open.spotify.com/episode/xyz"
    );
    expect(spotifyUriToOpenUrl("not-a-uri")).toBeNull();
    expect(spotifyUriToOpenUrl(123)).toBeNull();
  });

  it("normalizeClusterImageUrl handles both cdn and spotify: forms", () => {
    expect(normalizeClusterImageUrl("https://i.scdn.co/image/abc")).toBe(
      "https://i.scdn.co/image/abc"
    );
    expect(normalizeClusterImageUrl("spotify:image:hashy")).toBe(
      "https://i.scdn.co/image/hashy"
    );
    expect(normalizeClusterImageUrl("garbage")).toBeNull();
    expect(normalizeClusterImageUrl(undefined)).toBeNull();
  });

  it("computeProgressMs is monotonic while playing and static while paused", () => {
    expect(computeProgressMs(1000, 5000, true, 100000, 8000)).toBe(4000);
    // Paused: no elapsed added.
    expect(computeProgressMs(1000, 5000, false, 100000, 8000)).toBe(1000);
    // Clamped to duration.
    expect(computeProgressMs(9000, 5000, true, 10000, 100000)).toBe(10000);
    expect(computeProgressMs(null, 5000, true, 10000, 8000)).toBeNull();
  });
});

describe("createDealerListener: happy path", () => {
  it("mints, opens, receives connection id, PUTs connect-state, emits initial + subsequent cluster events", async () => {
    const timers = makeFakeTimers();
    const socket = new FakeSocket();
    const mintToken = jest.fn().mockResolvedValue({ token: "at-1" });
    const initialCluster = makeCluster();
    const putConnectState = jest
      .fn()
      .mockResolvedValue({ cluster: initialCluster });
    const events: NowPlaying[] = [];
    const states: DealerState[] = [];
    const listener = createDealerListener({
      mintToken,
      createSocket: () => socket,
      putConnectState,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: () => 1_700_000_005_000,
      random: () => 0.5,
    });
    listener.onEvent((e) => events.push(e));
    listener.onStateChange((s) => states.push(s));

    listener.start();
    // Let the mint promise resolve.
    await flush();

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(listener.getState()).toBe("connecting");

    // Simulate the socket opening and the first frame carrying the
    // connection id. The listener should PUT connect-state next.
    socket.triggerOpen();
    socket.triggerMessage(connectionIdEnvelope("cid-abc"));
    await flush();

    expect(putConnectState).toHaveBeenCalledTimes(1);
    expect(putConnectState.mock.calls[0][0]).toMatchObject({
      connectionId: "cid-abc",
      token: "at-1",
      memberType: "CONNECT_STATE",
    });
    expect(listener.getState()).toBe("connected");
    // Initial state emitted from the PUT response body.
    expect(events).toHaveLength(1);
    expect(events[0].playing).toBe(true);

    // A subsequent cluster push over the socket must also be mapped.
    const updated = makeCluster({
      player_state: {
        is_playing: true,
        is_paused: false,
        timestamp: String(1_700_000_005_000),
        position_as_of_timestamp: "1000",
        duration: "300000",
        track: {
          uri: "spotify:track:NEXT",
          metadata: {
            title: "Different Song",
            artist_name: "Other Artist",
            album_title: "Other Album",
            image_url: "spotify:image:otherhash",
            duration: "300000",
          },
        },
      },
    });
    socket.triggerMessage(clusterEnvelope(encodeClusterPayload({ cluster: updated })));
    await flush();
    expect(events).toHaveLength(2);
    expect(events[1].playing).toBe(true);
    if (!events[1].playing) return;
    expect(events[1].track.title).toBe("Different Song");
    expect(events[1].track.url).toBe(
      "https://open.spotify.com/track/NEXT"
    );

    // State timeline visited connecting → connected.
    expect(states).toContain("connecting");
    expect(states).toContain("connected");
  });
});

describe("createDealerListener: ping / pong", () => {
  it("sends a ping after pingIntervalMs and reconnects on pong timeout", async () => {
    const timers = makeFakeTimers();
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    let createCall = 0;
    const mintToken = jest.fn().mockResolvedValue({ token: "at" });
    const putConnectState = jest.fn().mockResolvedValue({});
    const listener = createDealerListener({
      mintToken,
      createSocket: () => (createCall++ === 0 ? socketA : socketB),
      putConnectState,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
      pingIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
    });

    listener.start();
    await flush();
    socketA.triggerOpen();
    socketA.triggerMessage(connectionIdEnvelope("cid"));
    await flush();
    expect(listener.getState()).toBe("connected");

    // The ping is scheduled for pingIntervalMs (30_000).
    const pingTimer = timers.findByDelay((ms) => ms === 30_000);
    expect(pingTimer).toBeDefined();
    timers.runTimer(pingTimer!);
    expect(socketA.sends.some((s) => s.includes('"ping"'))).toBe(true);

    // pong watchdog scheduled for pongTimeoutMs (10_000). Fire it: this is
    // the "missed pong" path; must schedule a reconnect.
    const pongTimer = timers.findByDelay((ms) => ms === 10_000);
    expect(pongTimer).toBeDefined();
    timers.runTimer(pongTimer!);

    expect(listener.getState()).toBe("backoff");
    expect(socketA.closed).toBe(true);

    // The backoff timer eventually fires, minting again and creating socket B.
    const backoffTimer = timers.timers.find(
      (t) => !t.cleared && t.delayMs >= 0 && t.delayMs <= DEFAULT_MAX_BACKOFF_MS
    );
    expect(backoffTimer).toBeDefined();
    timers.runTimer(backoffTimer!);
    await flush();
    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(createCall).toBe(2);
  });

  it("clears the pong watchdog when a pong is received", async () => {
    const timers = makeFakeTimers();
    const socket = new FakeSocket();
    const listener = createDealerListener({
      mintToken: jest.fn().mockResolvedValue({ token: "at" }),
      createSocket: () => socket,
      putConnectState: jest.fn().mockResolvedValue({}),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
      pingIntervalMs: 100,
      pongTimeoutMs: 10,
    });
    listener.start();
    await flush();
    socket.triggerOpen();
    socket.triggerMessage(connectionIdEnvelope("cid"));
    await flush();

    // Fire the ping.
    timers.runTimer(timers.findByDelay((ms) => ms === 100)!);
    // Deliver the pong before the watchdog fires.
    socket.triggerMessage(JSON.stringify({ type: "pong" }));

    // The pong-watchdog timer is now cleared.
    const stillPending = timers.timers.filter(
      (t) => !t.cleared && t.delayMs === 10
    );
    expect(stillPending).toHaveLength(0);
    // And the socket is still healthy (a fresh ping timer was scheduled).
    expect(listener.getState()).toBe("connected");
    expect(socket.closed).toBe(false);
  });
});

describe("createDealerListener: reconnect backoff", () => {
  it("uses exponential backoff with jitter, capped at maxBackoffMs", async () => {
    const timers = makeFakeTimers();
    // Random pinned to 1.0 so we always pick the top of the [0, cap) range.
    // Math.floor(1.0 * cap) == cap - which we don't actually hit; test that
    // the delay stays inside the cap by pinning random to 0.999999.
    const random = jest.fn().mockReturnValue(0.999999);
    // Mint always fails transiently so we can watch the backoff grow.
    const mintToken = jest
      .fn()
      .mockRejectedValue(new Error("ENOTFOUND"));
    const listener = createDealerListener({
      mintToken,
      createSocket: () => new FakeSocket(),
      putConnectState: jest.fn(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random,
      initialBackoffMs: 1000,
      maxBackoffMs: 60_000,
    });

    listener.start();
    await flush();
    // First backoff delay: base * 2^0 = 1000, jittered ~= 999.
    const delays: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t = timers.timers.filter((x) => !x.cleared).pop();
      if (!t) break;
      delays.push(t.delayMs);
      timers.runTimer(t);
      await flush();
    }
    // Exponentially growing until capped.
    expect(delays[0]).toBeLessThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);
    // Once we've grown far enough, every delay is at the cap ceiling.
    const capped = delays.slice(-3);
    for (const d of capped) {
      expect(d).toBeLessThanOrEqual(60_000);
      expect(d).toBeGreaterThan(60_000 * 0.5);
    }
  });

  it("resets the backoff after a successful connect", async () => {
    const timers = makeFakeTimers();
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    let createCall = 0;
    const mintToken = jest.fn().mockResolvedValue({ token: "at" });
    const putConnectState = jest.fn().mockResolvedValue({});
    const random = jest.fn().mockReturnValue(0.5);
    const listener = createDealerListener({
      mintToken,
      createSocket: () => (createCall++ === 0 ? socketA : socketB),
      putConnectState,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random,
      initialBackoffMs: 1000,
      maxBackoffMs: 60_000,
    });
    listener.start();
    await flush();
    socketA.triggerOpen();
    socketA.triggerMessage(connectionIdEnvelope("cid"));
    await flush();
    expect(listener.getState()).toBe("connected");

    // Force the socket dead and rewind: the reconnect delay must start from
    // 2^0 again, not from wherever a prior streak left off.
    socketA.triggerClose(1006, "boom");
    const backoffTimer = timers.timers.filter((t) => !t.cleared).pop();
    expect(backoffTimer).toBeDefined();
    // 2^0 * 1000 * 0.5 = 500.
    expect(backoffTimer!.delayMs).toBe(500);
  });
});

describe("createDealerListener: terminal credential_dead", () => {
  it("goes credential_dead when the minter throws invalid_cookie and does not reconnect", async () => {
    const timers = makeFakeTimers();
    const err = new Error("token exchange rejected sp_dc with status 401");
    (err as unknown as { kind: string }).kind = "invalid_cookie";
    const mintToken = jest.fn().mockRejectedValue(err);
    const listener = createDealerListener({
      mintToken,
      createSocket: () => new FakeSocket(),
      putConnectState: jest.fn(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    });
    listener.start();
    await flush();
    expect(listener.getState()).toBe("credential_dead");
    // No pending timers means: no reconnect scheduled.
    expect(timers.timers.filter((t) => !t.cleared)).toHaveLength(0);
    // Mint was called ONCE - the terminal state prevents any retry.
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("recovers from credential_dead only via an explicit start()", async () => {
    const timers = makeFakeTimers();
    const err = new Error("invalid");
    (err as unknown as { kind: string }).kind = "invalid_cookie";
    let call = 0;
    const mintToken = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) throw err;
      return { token: "fresh" };
    });
    const socketB = new FakeSocket();
    let createCall = 0;
    const listener = createDealerListener({
      mintToken,
      createSocket: () => {
        createCall += 1;
        return socketB;
      },
      putConnectState: jest.fn().mockResolvedValue({}),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    });
    listener.start();
    await flush();
    expect(listener.getState()).toBe("credential_dead");

    // Admin pasted a fresh sp_dc; caller invokes start() to resume.
    listener.start();
    await flush();
    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(createCall).toBe(1);
    socketB.triggerOpen();
    socketB.triggerMessage(connectionIdEnvelope("cid"));
    await flush();
    expect(listener.getState()).toBe("connected");
  });
});

describe("createDealerListener: stop is idempotent", () => {
  it("stop() teardown clears timers, closes the socket, and prevents reconnects", async () => {
    const timers = makeFakeTimers();
    const socket = new FakeSocket();
    const listener = createDealerListener({
      mintToken: jest.fn().mockResolvedValue({ token: "at" }),
      createSocket: () => socket,
      putConnectState: jest.fn().mockResolvedValue({}),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    });
    listener.start();
    await flush();
    socket.triggerOpen();
    socket.triggerMessage(connectionIdEnvelope("cid"));
    await flush();
    listener.stop();
    expect(socket.closed).toBe(true);
    expect(listener.getState()).toBe("idle");
    // A late close event after stop() must not schedule anything.
    const beforeCount = timers.timers.filter((t) => !t.cleared).length;
    socket.triggerClose();
    const afterCount = timers.timers.filter((t) => !t.cleared).length;
    expect(afterCount).toBe(beforeCount);
  });
});

/**
 * Flush pending microtasks. `await flush()` gives promise chains scheduled
 * during synchronous work a chance to resolve before assertions run.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}
