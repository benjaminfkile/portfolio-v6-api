import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

import type { NowPlaying, NowPlayingTrack } from "../spotifyService";

/**
 * Spotify dealer websocket client (task #117, third in the listener series).
 *
 * The dealer socket is what Spotify's own web player uses to receive cluster
 * (playback state) pushes for every device on an account, instantly, over one
 * long-lived websocket. This module holds that socket open for the portfolio
 * account and yields curated NowPlaying events so the leader loop (task #118)
 * can serve /api/now-playing straight from cluster pushes rather than by
 * polling the Spotify Web API.
 *
 * Design notes:
 *   - Everything network-shaped is injected (mintToken, createSocket,
 *     putConnectState), so this module is trivial to unit-test with a fake
 *     socket. The Jest test runner has no external network access, so real
 *     network calls in tests would just hang.
 *   - This module NEVER calls the Spotify Web API for enrichment. The mapping
 *     is pure cluster metadata, missing fields degrade to null.
 *   - A `WebTokenMintError` with `kind === "invalid_cookie"` (task #116) is
 *     TERMINAL: the state becomes `credential_dead` and we stop reconnecting
 *     until an explicit `start()` call is made against a fresh cookie. Any
 *     other failure (transient network, 5xx, dead socket, ping timeout) goes
 *     through the exponential-backoff-plus-jitter reconnect loop, capped at
 *     five minutes so a long outage does not spin.
 *   - No credential (sp_dc, minted access token, connection id) is ever
 *     logged. All log lines describe status codes, message types, and timing.
 */

/** Public listener state, exactly the five states the task spec calls out. */
export type DealerState =
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "credential_dead";

/** Dealer websocket URL. Access token is appended as a query parameter. */
export const DEALER_URL_BASE = "wss://dealer.spotify.com/";

/**
 * connect-state device endpoint. `gae2-spclient.spotify.com` is the current
 * regional edge the web player targets; the URL builder is injectable so
 * tests do not depend on any live host.
 */
export const DEFAULT_CONNECT_STATE_URL = (deviceId: string): string =>
  `https://gae2-spclient.spotify.com/connect-state/v1/devices/${deviceId}`;

export const DEFAULT_PING_INTERVAL_MS = 30_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
/** Five-minute cap, per the task spec. */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Cap the exponential exponent so `2 ** attempt` never overflows. */
const BACKOFF_ATTEMPT_CAP = 20;

/**
 * The token the minter (task #116) returns. `expiresAtMs` is optional in the
 * dealer's view - the dealer socket will close on its own when Spotify decides
 * the token is stale, at which point we reconnect.
 */
export interface DealerMintedToken {
  token: string;
  expiresAtMs?: number;
}

/**
 * Minimal websocket contract the dealer client depends on. Deliberately a
 * subset of both the browser WebSocket API and the `ws` package so callers
 * can adapt either without changing this module.
 */
export interface DealerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string | Buffer | ArrayBuffer) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((err: unknown) => void) | null;
}

/**
 * The minimal device descriptor the connect-state PUT needs. Nothing about
 * this device is user-visible: `disable_connect: true` marks us as an
 * observer, not a playable target.
 */
export interface DeviceDescriptor {
  device_id: string;
  device_type?: string;
  name?: string;
  brand?: string;
  model?: string;
  platform_identifier?: string;
  capabilities?: Record<string, unknown>;
  metadata_map?: Record<string, unknown>;
}

/** Arguments the injected connect-state PUT is called with. */
export interface PutConnectStateArgs {
  connectionId: string;
  token: string;
  device: DeviceDescriptor;
  memberType: "CONNECT_STATE";
}

export type PutConnectState = (
  args: PutConnectStateArgs
) => Promise<unknown>;

export type TimerHandle = unknown;

export interface DealerDeps {
  /**
   * Returns a fresh Spotify web-player access token. Called on every connect
   * attempt so a reconnect never carries a stale token. Errors with
   * `kind === "invalid_cookie"` (matches WebTokenMintError from task #116)
   * are TERMINAL; any other error triggers a backoff-plus-retry.
   */
  mintToken: () => Promise<DealerMintedToken>;
  /** Factory that returns a socket-like object for the given wss URL. */
  createSocket?: (url: string) => DealerSocket;
  /**
   * PUT to Spotify's connect-state device endpoint with a minimal device
   * descriptor and the X-Spotify-Connection-Id header. The response body is
   * the current cluster, which we emit as the initial state.
   */
  putConnectState?: PutConnectState;
  /** Overrides the default minimal device descriptor. */
  device?: DeviceDescriptor;
  /** Overrides the default connect-state endpoint (test-only). */
  connectStateUrlBuilder?: (deviceId: string) => string;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  now?: () => number;
  /** Returns [0, 1). Injected so tests can pin the jitter value. */
  random?: () => number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Structured log sink. Called with a level and a status/timing message. */
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface DealerListener {
  /**
   * Start (or restart after `credential_dead`) the reconnect loop. Idempotent
   * while already connecting / connected. On `credential_dead`, a fresh
   * `start()` is the ONLY way to leave that state.
   */
  start(): void;
  /**
   * Stop the loop and close the socket. `getState()` becomes `idle`. Idempotent.
   */
  stop(): void;
  getState(): DealerState;
  /** Subscribe to curated NowPlaying events. Returns an unsubscribe function. */
  onEvent(cb: (payload: NowPlaying) => void): () => void;
  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(cb: (state: DealerState) => void): () => void;
}

const NOT_PLAYING: NowPlaying = { playing: false };

/**
 * Build the minimal observer-only device descriptor for the connect-state PUT.
 * Overridable via `deps.device`.
 *
 * Spotify's connect-state edge validates `device_info` strictly: any of the
 * librespot-style descriptive fields (device_type, name, brand, model, ...)
 * makes it reject the whole PUT as INVALID_ENTITY. It accepts only a
 * `capabilities` object, and only these three flags register a pure observer
 * that receives full cluster pushes without appearing as a playable device:
 *   - can_be_player: false        -> never a playback target
 *   - hidden: true                -> invisible on the account's device list
 *   - needs_full_player_state: true -> Spotify returns the current cluster
 * `device_id` is carried here only because it forms the PUT URL; it is NOT
 * sent inside `device_info` (see buildPutConnectState). Adding any other
 * capability (e.g. disable_connect) also trips INVALID_ENTITY.
 */
function makeDefaultDevice(): DeviceDescriptor {
  return {
    device_id: randomUUID().replace(/-/g, ""),
    capabilities: {
      can_be_player: false,
      hidden: true,
      needs_full_player_state: true,
    },
  };
}

/**
 * Any thrown value with `kind === "invalid_cookie"` matches the shape the
 * task-#116 token minter uses. We do not import the class directly so this
 * module remains loosely coupled and easy to fake in tests.
 */
function isInvalidCookieError(err: unknown): boolean {
  return !!err && typeof err === "object" &&
    (err as { kind?: unknown }).kind === "invalid_cookie";
}

/**
 * Convert `spotify:track:XYZ` (or any `spotify:*:XYZ`) into
 * `https://open.spotify.com/<kind>/XYZ`. Returns null on unknown shapes.
 */
export function spotifyUriToOpenUrl(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const parts = uri.split(":");
  if (parts.length < 3 || parts[0] !== "spotify") return null;
  const kind = parts[1];
  const id = parts.slice(2).join("/");
  if (!kind || !id) return null;
  return `https://open.spotify.com/${kind}/${id}`;
}

/**
 * Cluster metadata carries images as `spotify:image:HASH` OR as an already
 * fully-qualified `https://i.scdn.co/...` url. Normalize to the CDN url.
 */
export function normalizeClusterImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
  if (raw.startsWith("spotify:image:")) {
    const hash = raw.slice("spotify:image:".length);
    if (hash) return `https://i.scdn.co/image/${hash}`;
  }
  return null;
}

/**
 * Pick the largest-available cover art url out of the flat cluster metadata
 * keys. Spotify emits `image_xlarge_url`, `image_large_url`, `image_url`,
 * `image_small_url` in decreasing size order; take the first that resolves.
 */
function pickClusterArt(metadata: Record<string, unknown>): string | null {
  for (const key of [
    "image_xlarge_url",
    "image_large_url",
    "image_url",
    "image_small_url",
  ]) {
    const normalized = normalizeClusterImageUrl(metadata[key]);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Cluster metadata is a flat map. Primary artist is `artist_name`; additional
 * artists come as `artist_name:1`, `artist_name:2`, ... in order.
 */
function pickClusterArtists(metadata: Record<string, unknown>): string[] {
  const primary = metadata.artist_name;
  const out: string[] = [];
  if (typeof primary === "string" && primary.length > 0) out.push(primary);
  for (let i = 1; i < 20; i += 1) {
    const v = metadata[`artist_name:${i}`];
    if (typeof v !== "string" || v.length === 0) break;
    out.push(v);
  }
  return out;
}

/**
 * Cluster fields (durations, positions, timestamps) are commonly encoded as
 * numeric strings. Accepts both, rejects anything else. Returns null for
 * missing / malformed values so the curated NowPlaying degrades cleanly.
 */
function readClusterNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Compute the current progress in ms given the cluster position, the cluster
 * position-timestamp, and whether playback is running. Clamps to [0, duration]
 * when a duration is known.
 */
export function computeProgressMs(
  positionAsOfTs: number | null,
  positionTimestamp: number | null,
  isPlaying: boolean,
  duration: number | null,
  now: number
): number | null {
  if (positionAsOfTs == null) return null;
  let progress = positionAsOfTs;
  if (isPlaying && positionTimestamp != null) {
    const elapsed = Math.max(0, now - positionTimestamp);
    progress = positionAsOfTs + elapsed;
  }
  if (progress < 0) progress = 0;
  if (duration != null && progress > duration) progress = duration;
  return progress;
}

/**
 * Map a raw cluster JSON to the curated NowPlaying shape from spotifyService.
 * Defensive: anything unrecognized becomes idle; any missing field on a
 * playing track becomes null (never a throw).
 */
export function mapClusterToNowPlaying(
  cluster: unknown,
  now: number = Date.now()
): NowPlaying {
  if (!cluster || typeof cluster !== "object") return NOT_PLAYING;
  const rec = cluster as Record<string, unknown>;
  const playerState = rec.player_state as Record<string, unknown> | undefined;
  if (!playerState || typeof playerState !== "object") return NOT_PLAYING;

  const isPlayingRaw = playerState.is_playing;
  const isPausedRaw = playerState.is_paused;
  const isPlaying =
    isPlayingRaw === true && isPausedRaw !== true;

  const track = playerState.track as Record<string, unknown> | undefined;
  // No track at all - could be an "empty" cluster while nothing is loaded.
  if (!track || typeof track !== "object") {
    return NOT_PLAYING;
  }
  const metadata =
    (track.metadata as Record<string, unknown> | undefined) ?? {};

  const title =
    typeof metadata.title === "string" ? (metadata.title as string) : "";
  const albumName =
    typeof metadata.album_title === "string"
      ? (metadata.album_title as string)
      : "";
  const artists = pickClusterArtists(metadata);
  const art = pickClusterArt(metadata);
  const url = spotifyUriToOpenUrl(track.uri);

  const position = readClusterNumber(playerState.position_as_of_timestamp);
  const positionTs = readClusterNumber(playerState.timestamp);
  const duration =
    readClusterNumber(playerState.duration) ??
    readClusterNumber(metadata.duration);
  const progress = computeProgressMs(
    position,
    positionTs,
    isPlaying,
    duration,
    now
  );

  const curated: NowPlayingTrack = {
    title,
    artists,
    album: albumName,
    art_url: art,
    url,
    progress_ms: progress,
    duration_ms: duration,
  };

  if (!isPlaying) {
    // A track is loaded but not actively playing (paused, or the session is
    // idle on this device). Surface it as the last-played track — with its
    // album art — so the widget keeps showing what was on rather than blanking.
    // Spotify reports `is_playing: true, is_paused: true` for a paused track,
    // so this is the common case, not an edge case.
    return {
      playing: false,
      last_played: { track: curated, played_at: new Date(now).toISOString() },
    };
  }
  return { playing: true, track: curated };
}

/**
 * Decode a dealer message's `payloads` field. Payloads are an array; each
 * entry is either a JSON object already, a JSON string, or a base64 string
 * whose bytes may be gzip-compressed JSON. We try the cheapest interpretation
 * first and swallow decode errors (unknown shapes become null and the caller
 * ignores the message).
 */
export function decodeDealerPayloads(
  payloads: unknown,
  headers: Record<string, unknown> | undefined
): unknown {
  if (!Array.isArray(payloads) || payloads.length === 0) return null;
  const first = payloads[0];
  if (first == null) return null;

  // Already-decoded object.
  if (typeof first === "object") return first;

  if (typeof first !== "string") return null;

  const transferEncoding = readHeader(headers, "Transfer-Encoding");
  const contentType = readHeader(headers, "Content-Type");
  const gzipped =
    transferEncoding === "gzip" || contentType === "application/octet-stream";

  // Base64-decode first; if the header says gzip, gunzip; otherwise try to
  // parse as UTF-8 JSON. On any failure fall back to parsing the raw string
  // as JSON directly (some payload variants are plain JSON strings).
  try {
    const bytes = Buffer.from(first, "base64");
    if (gzipped) {
      const inflated = gunzipSync(bytes);
      return JSON.parse(inflated.toString("utf8"));
    }
    // Not gzipped: the base64 might have been an ASCII JSON string.
    const asText = bytes.toString("utf8");
    return JSON.parse(asText);
  } catch {
    // Fall through to a raw-JSON attempt.
  }
  try {
    return JSON.parse(first);
  } catch {
    return null;
  }
}

function readHeader(
  headers: Record<string, unknown> | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v;
  }
  return null;
}

/**
 * Envelope emitted by the dealer over the websocket. Fields we care about:
 *   - `type`: "message" | "ping" | "pong"
 *   - `headers`: only meaningful on the very first message (carries
 *     Spotify-Connection-Id) or on cluster pushes (encoding hints).
 *   - `uri`: on cluster pushes, starts with "hm://connect-state/v1/cluster".
 *   - `payloads`: base64-encoded gzip JSON for cluster updates.
 */
interface DealerEnvelope {
  type?: unknown;
  headers?: unknown;
  uri?: unknown;
  payloads?: unknown;
}

/**
 * Factory for the dealer listener. Nothing runs until `start()`.
 *
 * A single instance owns exactly one reconnect loop. Multiple `start()` calls
 * while already running are no-ops; a `start()` after `credential_dead` (i.e.,
 * an admin has pasted a fresh sp_dc) resets the terminal state and reconnects.
 */
export function createDealerListener(deps: DealerDeps): DealerListener {
  const mintToken = deps.mintToken;
  const createSocket = deps.createSocket ?? defaultCreateSocket;
  const putConnectState = deps.putConnectState ?? defaultPutConnectState;
  const device = deps.device ?? makeDefaultDevice();
  // The URL builder is not used by the injected-PUT surface (the fake in
  // tests owns the URL). It is exposed on `deps` so the leader loop (task
  // #118) can build the URL with the same rule the module documents.
  void (deps.connectStateUrlBuilder ?? DEFAULT_CONNECT_STATE_URL);
  const setTimer =
    deps.setTimer ??
    ((fn, ms) =>
      setTimeout(fn, ms) as unknown as TimerHandle);
  const clearTimer =
    deps.clearTimer ??
    ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = deps.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  const initialBackoffMs = deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const log = deps.logger ?? (() => undefined);

  let state: DealerState = "idle";
  let socket: DealerSocket | null = null;
  let currentToken: string | null = null;
  let connectionId: string | null = null;
  let pingTimer: TimerHandle | null = null;
  let pongTimer: TimerHandle | null = null;
  let backoffTimer: TimerHandle | null = null;
  let backoffAttempt = 0;
  let stopped = true;
  // A monotonically increasing epoch bumped every time the loop tears down a
  // socket; pending async work (connect-state PUT, timers) checks that the
  // epoch has not moved before mutating state, so a slow response from a
  // dead connection cannot poison the next attempt.
  let epoch = 0;

  const eventCbs = new Set<(p: NowPlaying) => void>();
  const stateCbs = new Set<(s: DealerState) => void>();

  function setState(next: DealerState): void {
    if (state === next) return;
    state = next;
    for (const cb of stateCbs) {
      try {
        cb(next);
      } catch (e) {
        log("error", `state cb threw: ${describeError(e)}`);
      }
    }
  }

  function emit(payload: NowPlaying): void {
    for (const cb of eventCbs) {
      try {
        cb(payload);
      } catch (e) {
        log("error", `event cb threw: ${describeError(e)}`);
      }
    }
  }

  function clearPing(): void {
    if (pingTimer != null) {
      clearTimer(pingTimer);
      pingTimer = null;
    }
    if (pongTimer != null) {
      clearTimer(pongTimer);
      pongTimer = null;
    }
  }

  function clearBackoff(): void {
    if (backoffTimer != null) {
      clearTimer(backoffTimer);
      backoffTimer = null;
    }
  }

  function teardownSocket(): void {
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Ignore close errors; we're tearing down.
      }
      socket = null;
    }
    connectionId = null;
    currentToken = null;
    epoch += 1;
  }

  function scheduleReconnect(reason: string): void {
    if (stopped) return;
    if (state === "credential_dead") return;
    clearPing();
    clearBackoff();
    teardownSocket();
    setState("backoff");
    const exponent = Math.min(backoffAttempt, BACKOFF_ATTEMPT_CAP);
    const cap = Math.min(maxBackoffMs, initialBackoffMs * 2 ** exponent);
    // Full jitter (AWS builder's-library style): uniformly random in [0, cap).
    // Avoids herds of clients reconnecting at the same instant.
    const jittered = Math.floor(random() * cap);
    backoffAttempt = Math.min(backoffAttempt + 1, BACKOFF_ATTEMPT_CAP);
    log("warn", `dealer reconnect in ${jittered}ms (reason: ${reason})`);
    backoffTimer = setTimer(() => {
      backoffTimer = null;
      void connect();
    }, jittered);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    if (state === "credential_dead") return;
    setState("connecting");
    const myEpoch = epoch;

    let minted: DealerMintedToken;
    try {
      minted = await mintToken();
    } catch (err) {
      if (myEpoch !== epoch) return;
      if (isInvalidCookieError(err)) {
        clearPing();
        clearBackoff();
        teardownSocket();
        setState("credential_dead");
        log(
          "warn",
          "dealer: token minter reports invalid_cookie; going credential_dead until explicit restart"
        );
        return;
      }
      log("warn", `dealer: token mint failed (transient): ${describeError(err)}`);
      scheduleReconnect("mint transient");
      return;
    }
    if (myEpoch !== epoch) return;

    currentToken = minted.token;
    const url =
      DEALER_URL_BASE + "?access_token=" + encodeURIComponent(minted.token);
    let ws: DealerSocket;
    try {
      ws = createSocket(url);
    } catch (err) {
      log("warn", `dealer: socket create failed: ${describeError(err)}`);
      scheduleReconnect("socket create failed");
      return;
    }
    socket = ws;
    connectionId = null;

    ws.onopen = () => {
      if (myEpoch !== epoch) return;
      log("info", "dealer: socket open");
      // Kick off the keepalive loop; connect-state registration starts once
      // the dealer's very first message hands us the Spotify-Connection-Id.
      schedulePing();
    };
    ws.onmessage = (data) => {
      if (myEpoch !== epoch) return;
      handleMessage(data, myEpoch);
    };
    ws.onclose = (code, reason) => {
      if (myEpoch !== epoch) return;
      log("warn", `dealer: socket closed (code=${code} reason=${reason})`);
      scheduleReconnect(`close ${code}`);
    };
    ws.onerror = (err) => {
      if (myEpoch !== epoch) return;
      log(
        "warn",
        `dealer: socket error: ${describeError(err)}`
      );
      // Rely on onclose to reconnect; some implementations fire only onerror
      // without an onclose, so schedule defensively if the socket is still
      // set (teardown clears it).
      if (socket === ws) scheduleReconnect("socket error");
    };
  }

  function schedulePing(): void {
    if (pingTimer != null) clearTimer(pingTimer);
    pingTimer = setTimer(() => {
      pingTimer = null;
      sendPing();
    }, pingIntervalMs);
  }

  function sendPing(): void {
    if (!socket) return;
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch (err) {
      scheduleReconnect(`ping send failed: ${describeError(err)}`);
      return;
    }
    if (pongTimer != null) clearTimer(pongTimer);
    pongTimer = setTimer(() => {
      pongTimer = null;
      scheduleReconnect("pong timeout");
    }, pongTimeoutMs);
  }

  function handleMessage(
    data: string | Buffer | ArrayBuffer,
    myEpoch: number
  ): void {
    const text = normalizeFrameToString(data);
    if (text == null) return;

    let envelope: DealerEnvelope;
    try {
      envelope = JSON.parse(text) as DealerEnvelope;
    } catch {
      // Frames that are not JSON are ignored silently per spec.
      return;
    }
    if (!envelope || typeof envelope !== "object") return;

    const type = envelope.type;
    if (type === "pong") {
      if (pongTimer != null) {
        clearTimer(pongTimer);
        pongTimer = null;
      }
      schedulePing();
      return;
    }
    if (type === "ping") {
      // Dealer occasionally sends server-side pings; reply so it does not
      // decide we are dead.
      try {
        socket?.send(JSON.stringify({ type: "pong" }));
      } catch {
        // If the send fails the ping loop / close handler will reconnect.
      }
      return;
    }
    if (type !== "message") return;

    const headers =
      envelope.headers && typeof envelope.headers === "object"
        ? (envelope.headers as Record<string, unknown>)
        : undefined;
    const providedCid = readHeader(headers, "Spotify-Connection-Id");
    if (providedCid && !connectionId) {
      connectionId = providedCid;
      void registerConnectState(providedCid, myEpoch);
      return;
    }

    const uri = envelope.uri;
    if (typeof uri === "string" && uri.startsWith("hm://connect-state/v1/cluster")) {
      const decoded = decodeDealerPayloads(envelope.payloads, headers);
      if (decoded && typeof decoded === "object") {
        // The cluster-update wrapper may nest the cluster under `.cluster`.
        const clusterObj =
          "cluster" in (decoded as Record<string, unknown>)
            ? (decoded as { cluster: unknown }).cluster
            : decoded;
        emit(mapClusterToNowPlaying(clusterObj, now()));
      }
      return;
    }
    // Unknown message type / uri: silently drop.
  }

  async function registerConnectState(
    cid: string,
    myEpoch: number
  ): Promise<void> {
    if (myEpoch !== epoch) return;
    const token = currentToken;
    if (!token) {
      // Should not happen, but if the token disappeared under us treat as a
      // transient socket problem and reconnect.
      scheduleReconnect("no token for connect-state PUT");
      return;
    }
    try {
      const cluster = await putConnectState({
        connectionId: cid,
        token,
        device,
        memberType: "CONNECT_STATE",
      });
      if (myEpoch !== epoch) return;
      setState("connected");
      backoffAttempt = 0;
      if (cluster && typeof cluster === "object") {
        const clusterObj =
          "cluster" in (cluster as Record<string, unknown>)
            ? (cluster as { cluster: unknown }).cluster
            : cluster;
        emit(mapClusterToNowPlaying(clusterObj, now()));
      }
    } catch (err) {
      if (myEpoch !== epoch) return;
      log(
        "warn",
        `dealer: connect-state PUT failed: ${describeError(err)}`
      );
      scheduleReconnect("connect-state failed");
    }
  }

  function doStart(): void {
    if (state === "connecting" || state === "connected") return;
    stopped = false;
    // A fresh start from credential_dead is the ONLY way to leave that
    // terminal state - it resets the epoch and drops the terminal flag so
    // the loop begins as if newly-constructed.
    if (state === "credential_dead") {
      setState("idle");
      backoffAttempt = 0;
    }
    clearBackoff();
    void connect();
  }

  function doStop(): void {
    stopped = true;
    clearPing();
    clearBackoff();
    teardownSocket();
    setState("idle");
    backoffAttempt = 0;
  }

  return {
    start: doStart,
    stop: doStop,
    getState: () => state,
    onEvent(cb) {
      eventCbs.add(cb);
      return () => {
        eventCbs.delete(cb);
      };
    },
    onStateChange(cb) {
      stateCbs.add(cb);
      return () => {
        stateCbs.delete(cb);
      };
    },
  };
}

function normalizeFrameToString(
  data: string | Buffer | ArrayBuffer
): string | null {
  try {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    return Buffer.from(data as ArrayBuffer).toString("utf8");
  } catch {
    return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "unknown";
}

/**
 * Default websocket factory. NEVER used in tests; only the injected fake is.
 * Throws in environments without a native WebSocket AND without the `ws`
 * package installed - the leader loop (task #118) is responsible for wiring
 * a real socket factory.
 */
function defaultCreateSocket(_url: string): DealerSocket {
  throw new Error(
    "createDealerListener: no createSocket dep provided and no default socket implementation available"
  );
}

/**
 * Default connect-state PUT. NEVER used in tests; only the injected fake is.
 * The real implementation lives in the leader-loop wiring (task #118) so it
 * can share whichever HTTP client that layer uses.
 */
async function defaultPutConnectState(
  _args: PutConnectStateArgs
): Promise<unknown> {
  throw new Error(
    "createDealerListener: no putConnectState dep provided and no default HTTP client available"
  );
}
