/**
 * Public API for the single-poller / shared-snapshot subsystem (task #84).
 *
 * `bootstrapUpstream` is called once at boot from `index.ts`:
 *   - resolves the Redis client from `redis_url` (null when unset — everything
 *     degrades to today's per-instance path),
 *   - creates the leader lease and starts its renewal loop,
 *   - assembles the curated fetchers (Spotify/status/Duolingo/GitHub, wired to
 *     the existing services), and
 *   - starts the poll loop, which is a no-op until this instance wins the lease.
 *
 * The returned handle exposes `stop()` for tests + SIGINT/SIGTERM shutdown.
 * Routers reach the shared snapshot via `readSnapshot(...)` (async, Redis-backed)
 * and — on the leader — fall back to the in-process copy via `readLocalSnapshot`.
 */

import type { Express } from "express";
import type { IAppSecrets } from "../../interfaces";
import {
  resolveRedisClient,
  type RedisClient,
} from "./redisClient";
import {
  createLeaderLease,
  type LeaderLease,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RENEW_INTERVAL_MS,
} from "./leaderLease";
import {
  startPollLoop,
  DEFAULT_POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  SLOW_LANE_REFRESH_MS,
  type PollLoopHandle,
  type PollFetchers,
} from "./pollLoop";
import {
  DEFAULT_REALTIME_SERVICE_NAME,
  type RealtimePublisherConfig,
} from "./realtimePublisher";
import {
  createSpotifyLane,
  DEFAULT_SPOTIFY_IDLE_INTERVAL_MS,
  SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
  SPOTIFY_AUTH_RESUME_CHECK_MS,
  SPOTIFY_PRESENCE_CACHE_MS,
  type SpotifyLane,
} from "./spotifyLane";
import { fetchPresenceCount } from "./presenceQuery";
import {
  readNowPlayingLastRequest,
  readSpotifyHealth,
  readSpotifySuspension,
  writeSpotifyHealth,
  writeSpotifySuspension,
  deleteSpotifySuspension,
  type SpotifyHealthRecord,
} from "./snapshotStore";
import {
  createListenerSupervisor,
  type ListenerSupervisor,
} from "./listenerSupervisor";
import {
  createDealerListener,
  DEFAULT_CONNECT_STATE_URL,
  type DealerListener,
  type DealerSocket,
  type PutConnectStateArgs,
} from "../listener/dealerClient";
import { mintWebToken } from "../listener/webTokenMinter";
import {
  getListenerCredential,
  getListenerCredentialUpdatedAt,
} from "../listenerCredentialStore";

// Fetcher helpers reach into the existing per-service modules so the leader
// uses the SAME curation / degrade logic the routers used to serve directly.
import {
  getNowPlaying,
  isSpotifyRateLimited,
  isSpotifyAuthSuspended,
  resumeSpotifyAuth,
  suspendSpotifyAuth,
  getSpotifyBackoffUntilMs,
  applySpotifyBackoffUntil,
  clearSpotifyBackoff,
  getSpotifyLastSuccessAtMs,
  getSpotifyLastError,
  applySpotifyHealthMirror,
  type SpotifyConfig,
} from "../spotifyService";
import { getStatus } from "../statusService";
import {
  getDuolingo,
  DEFAULT_LANGUAGE,
  DUOLINGO_SERVICE_KEY,
} from "../duolingoService";
import {
  getGithub,
  GITHUB_SERVICE_KEY,
} from "../githubService";
import {
  getStoredServiceToken,
  getServiceTokenUpdatedAt,
  resolveEncryptionKey,
} from "../serviceTokenStore";
import {
  getStoredSpotifyToken,
  rotateSpotifyRefreshToken,
  SPOTIFY_SERVICE_KEY,
} from "../spotifyTokenStore";
import { isSpotifyDisabled } from "../serviceSettingsStore";

/** Handle returned from bootstrap — kept small for shutdown. */
export interface UpstreamHandle {
  /** True when a Redis client resolved and a lease started. */
  enabled: boolean;
  /** The in-process lease (null when Redis is unset). */
  lease: LeaderLease | null;
  /** The poll loop handle (inert when lease is null). */
  loop: PollLoopHandle;
  /** The Redis client, exposed so routers can read snapshots. */
  redis: RedisClient | null;
  /**
   * The connect-listener supervisor (task #118). Null when Redis is unset
   * (the listener path needs the shared snapshot store to be useful).
   * Exposed so the admin status endpoint / tests can inspect state.
   */
  listenerSupervisor: ListenerSupervisor | null;
  /** Release the lease + stop timers + close the Redis connection. */
  stop(): Promise<void>;
}

/**
 * Extract the environment name used to prefix Redis keys. Uses `node_env` so
 * prod ("production") and dev ("development") never share keys, exactly as the
 * task requires. Kept as a helper so tests can pass any string.
 */
export function envKeyPrefix(secrets: IAppSecrets): string {
  return secrets.node_env;
}

/**
 * Options for `buildFetchers`. `spotifyLane` is opt-in so the existing tests
 * (which construct fetchers to assert individual behavior) don't accidentally
 * pick up viewer-aware cadence they don't want.
 */
export interface BuildFetchersOptions {
  spotifyLane?: SpotifyLane;
}

/**
 * Wire the curated fetchers to the existing service modules. Each fetcher
 * catches every error and returns `null` on failure so the poll loop treats
 * the tick as a skip (no snapshot write, no publish, no crash).
 */
export function buildFetchers(
  app: Express,
  options: BuildFetchersOptions = {}
): PollFetchers {
  const secrets = () => app.get("secrets") as IAppSecrets | undefined;

  async function spotifyConfig(): Promise<SpotifyConfig> {
    const s = secrets();
    const encryptionKey = resolveEncryptionKey(s);
    const stored = await getStoredSpotifyToken(encryptionKey);
    return {
      clientId: s?.spotify_client_id ?? "",
      clientSecret: s?.spotify_client_secret ?? "",
      // service_tokens is the ONLY grant source (task #112) — no static
      // spotify_refresh_token secret fallback. Missing row = DISCONNECTED,
      // silent, zero Spotify calls (reuse auth-suspension machinery).
      refreshToken: stored?.refreshToken ?? "",
      // Persist a rotated refresh token from any Spotify refresh response
      // (task #112). Only the polling leader hits this path (single-poller
      // invariant, task #84), so writes do not race; the store is
      // idempotent / last-write-wins anyway.
      onRefreshTokenRotated: async (newRefreshToken: string) => {
        await rotateSpotifyRefreshToken(encryptionKey, newRefreshToken);
      },
    };
  }

  async function duolingoUsername(): Promise<string> {
    const s = secrets();
    const stored = await getStoredServiceToken(
      DUOLINGO_SERVICE_KEY,
      resolveEncryptionKey(s)
    );
    return stored?.token ?? "";
  }

  async function githubPat(): Promise<string> {
    const s = secrets();
    const stored = await getStoredServiceToken(
      GITHUB_SERVICE_KEY,
      resolveEncryptionKey(s)
    );
    return stored?.token ?? "";
  }

  return {
    async nowPlaying() {
      // Task #113 — the admin disable flag makes zero Spotify calls
      // regardless of grant state. Checked FIRST so a disable flip takes
      // effect within one tick even on a code path that bypasses the lane
      // (tests, non-lane callers). A DB read failure fails open (treated
      // as enabled) so a Postgres blip cannot silently disable a working
      // integration.
      const disabled = await isSpotifyDisabled().catch(() => false);
      if (disabled) return null;
      // While under Spotify's 429 backoff (task #90) skip the tick entirely —
      // returning null tells the poll loop to preserve the last-good snapshot
      // and NOT record a failure. Non-Spotify lanes are unaffected.
      if (isSpotifyRateLimited()) return null;
      // Auth-suspended (task #95): the poll loop's spotifyLane also gates on
      // this, but a defense-in-depth check here means a direct call to the
      // fetcher (tests, non-lane paths) also short-circuits without touching
      // Spotify.
      if (isSpotifyAuthSuspended()) return null;
      try {
        return await getNowPlaying(await spotifyConfig());
      } catch (err) {
        console.error(
          "[upstream/nowPlaying] fetcher threw:",
          err instanceof Error ? err.message : err
        );
        return null;
      }
    },
    spotifyLane: options.spotifyLane,
    async status() {
      try {
        const s = secrets();
        const url =
          s?.gateway_health_url ??
          process.env.GATEWAY_HEALTH_URL ??
          "http://localhost:3000/api/health";
        return await getStatus(url);
      } catch (err) {
        console.error(
          "[upstream/status] fetcher threw:",
          err instanceof Error ? err.message : err
        );
        return null;
      }
    },
    async duolingo() {
      try {
        const username = await duolingoUsername();
        return await getDuolingo(username, DEFAULT_LANGUAGE);
      } catch (err) {
        console.error(
          "[upstream/duolingo] fetcher threw:",
          err instanceof Error ? err.message : err
        );
        return null;
      }
    },
    async github() {
      try {
        const pat = await githubPat();
        return await getGithub(pat);
      } catch (err) {
        console.error(
          "[upstream/github] fetcher threw:",
          err instanceof Error ? err.message : err
        );
        return null;
      }
    },
  };
}

/**
 * Bootstrap the whole subsystem. Idempotent: calling twice is safe (each call
 * creates its own lease id, so the second one is just a standby). Returns an
 * inert handle when `redis_url` is unset.
 */
export function bootstrapUpstream(app: Express): UpstreamHandle {
  const secrets = app.get("secrets") as IAppSecrets | undefined;
  const url = secrets?.redis_url ?? process.env.REDIS_URL ?? null;

  const client = resolveRedisClient(url);
  if (!secrets || !client) {
    return {
      enabled: false,
      lease: null,
      loop: { stop: () => undefined, runTick: async () => undefined },
      redis: null,
      listenerSupervisor: null,
      stop: async () => undefined,
    };
  }

  const env = envKeyPrefix(secrets);
  const lease = createLeaderLease(client, {
    key: `portfolio-v6-api:${env}:upstream-leader`,
    leaseTtlMs: DEFAULT_LEASE_TTL_MS,
    renewIntervalMs: DEFAULT_RENEW_INTERVAL_MS,
  });

  const publisher: RealtimePublisherConfig = {
    gatewayInternalUrl:
      secrets.gateway_internal_url ??
      process.env.GATEWAY_INTERNAL_URL ??
      "http://gateway:8080",
    realtimeToken:
      secrets.gateway_realtime_token ??
      process.env.GATEWAY_REALTIME_TOKEN ??
      "",
    serviceName:
      secrets.realtime_service_name ??
      process.env.REALTIME_SERVICE_NAME ??
      DEFAULT_REALTIME_SERVICE_NAME,
  };

  const pollIntervalMs =
    secrets.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  const spotifyIdleIntervalMs =
    secrets.spotify_idle_interval_ms ?? DEFAULT_SPOTIFY_IDLE_INTERVAL_MS;

  // Connect-listener supervisor (task #118). Owns the dealer websocket
  // lifecycle for this process; leader-gated exactly like polling. Wired
  // BEFORE the Spotify lane so we can pass `isListenerConnected` into the
  // lane and it can suppress the polling fetch while the listener is
  // holding the primary source.
  const listenerSupervisor = createListenerSupervisor({
    env,
    redis: client,
    publisher: {
      gatewayInternalUrl:
        secrets.gateway_internal_url ??
        process.env.GATEWAY_INTERNAL_URL ??
        "http://gateway:8080",
      realtimeToken:
        secrets.gateway_realtime_token ??
        process.env.GATEWAY_REALTIME_TOKEN ??
        "",
      serviceName:
        secrets.realtime_service_name ??
        process.env.REALTIME_SERVICE_NAME ??
        DEFAULT_REALTIME_SERVICE_NAME,
    },
    async loadCredential() {
      const s = app.get("secrets") as IAppSecrets | undefined;
      const stored = await getListenerCredential(resolveEncryptionKey(s));
      return stored?.spDc ?? null;
    },
    async getCredentialUpdatedAt() {
      return getListenerCredentialUpdatedAt();
    },
    createListener(spDc: string): DealerListener {
      return createDealerListener({
        mintToken: async () => {
          const minted = await mintWebToken(spDc);
          return { token: minted.token, expiresAtMs: minted.expiresAtMs };
        },
        createSocket: buildDealerSocket,
        putConnectState: buildPutConnectState(),
        logger: (level, message) => {
          if (level === "error") console.error(`[listener] ${message}`);
          else if (level === "warn") console.warn(`[listener] ${message}`);
          else console.log(`[listener] ${message}`);
        },
      });
    },
    logger: (level, message) => {
      if (level === "error") console.error(`[listenerSupervisor] ${message}`);
      else if (level === "warn") console.warn(`[listenerSupervisor] ${message}`);
      else console.log(`[listenerSupervisor] ${message}`);
    },
  });

  // Viewer-aware + auth-aware Spotify lane (task #95 + shared-suspension #96).
  // Everything the lane needs from the outside world is injected here so the
  // lane module has no dependency on Express / Redis / DB — the tests can
  // build a pure fake.
  const spotifyLane = createSpotifyLane(
    {
      async isDisabled() {
        return isSpotifyDisabled();
      },
      isAuthSuspended: () => isSpotifyAuthSuspended(),
      // Task #118 — while the listener is `connected` the Spotify polling
      // lane must not fetch: the connect-listener is the primary source.
      isListenerConnected: () => listenerSupervisor.isListenerConnected(),
      getBackoffUntilMs: () => getSpotifyBackoffUntilMs(),
      applyAuthSuspension: (reason) => suspendSpotifyAuth(reason),
      applyBackoffUntil: (untilMs) => applySpotifyBackoffUntil(untilMs),
      clearBackoff: () => clearSpotifyBackoff(),
      resumeAuth: () => resumeSpotifyAuth(),
      async getStoredTokenUpdatedAt() {
        return getServiceTokenUpdatedAt(SPOTIFY_SERVICE_KEY);
      },
      async getPresenceCount() {
        return fetchPresenceCount({
          gatewayInternalUrl: publisher.gatewayInternalUrl,
          realtimeToken: publisher.realtimeToken,
          serviceName: publisher.serviceName ?? DEFAULT_REALTIME_SERVICE_NAME,
          topic: "now-playing",
        });
      },
      async getLastPublicRequestAt() {
        return readNowPlayingLastRequest(client, env);
      },
      async readSharedSuspension() {
        return readSpotifySuspension(client, env);
      },
      async writeSharedSuspension(record) {
        return writeSpotifySuspension(client, env, record);
      },
      async clearSharedSuspension() {
        return deleteSpotifySuspension(client, env);
      },
      readLocalHealth(): SpotifyHealthRecord {
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
      async readSharedHealth() {
        return readSpotifyHealth(client, env);
      },
      async writeSharedHealth(record) {
        return writeSpotifyHealth(client, env, record);
      },
      applyHealthMirror(record) {
        applySpotifyHealthMirror(record);
      },
    },
    {
      publicRequestWindowMs: SPOTIFY_ACTIVE_PUBLIC_REQUEST_WINDOW_MS,
      presenceCacheMs: SPOTIFY_PRESENCE_CACHE_MS,
      authResumeCheckMs: SPOTIFY_AUTH_RESUME_CHECK_MS,
      idleIntervalMs: spotifyIdleIntervalMs,
    }
  );

  const loop = startPollLoop(
    client,
    lease,
    buildFetchers(app, { spotifyLane }),
    {
      env,
      pollIntervalMs,
      slowLaneRefreshMs: SLOW_LANE_REFRESH_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      publisher,
    }
  );

  // Track our own view of leadership so we can drive listener-supervisor
  // lifecycle on transitions. The lease itself does not fire an
  // `onLeadershipGain` callback (task #84 predates the listener); we detect
  // transitions in-band from `isLeader()` observations.
  let observedLeader = false;
  async function reconcileLeadership(): Promise<void> {
    const nowLeader = lease.isLeader();
    if (nowLeader && !observedLeader) {
      observedLeader = true;
      await listenerSupervisor
        .onLeadershipGain()
        .catch((err) =>
          console.error(
            "[upstream/bootstrap] listener onLeadershipGain failed:",
            err instanceof Error ? err.message : err
          )
        );
    } else if (!nowLeader && observedLeader) {
      observedLeader = false;
      await listenerSupervisor
        .onLeadershipLoss()
        .catch((err) =>
          console.error(
            "[upstream/bootstrap] listener onLeadershipLoss failed:",
            err instanceof Error ? err.message : err
          )
        );
    }
  }

  // First-boot acquisition attempt, then the renewal loop takes over. We DO NOT
  // await this — the poll loop is inert until the lease flips leader anyway.
  lease
    .tryAcquire()
    .then(() => reconcileLeadership())
    .catch((err) =>
      console.error(
        "[upstream/bootstrap] initial acquire failed:",
        err instanceof Error ? err.message : err
      )
    );
  lease.start({
    onLostLease: () => {
      // Task spec: "on renewal failure the loop stops fetching immediately".
      // We do NOT stop the timer — the lease keeps trying to re-acquire so this
      // instance can resume when Redis recovers. `runTick` self-guards on
      // `isLeader()` so the timer firing while we've lost the lease is a no-op.
      console.warn("[upstream/bootstrap] lost lease; polling suspended");
      // Task #118 — mirror the leadership loss into the listener supervisor
      // so the dealer socket is torn down and any other instance can take
      // over ownership of the single dealer connection per environment.
      void reconcileLeadership();
    },
  });

  // Piggyback on the lease renewal interval to reconcile the listener on
  // acquisition too - the lease's built-in acquisition attempts inside the
  // renewal loop do not surface a gain callback, so poll `isLeader()`
  // cheaply on the same cadence. The reconciler is idempotent.
  const leadershipWatch = setInterval(() => {
    void reconcileLeadership();
  }, DEFAULT_RENEW_INTERVAL_MS);
  if (typeof (leadershipWatch as unknown as { unref?: () => void }).unref === "function") {
    (leadershipWatch as unknown as { unref: () => void }).unref();
  }

  return {
    enabled: true,
    lease,
    loop,
    redis: client,
    listenerSupervisor,
    async stop() {
      clearInterval(leadershipWatch);
      loop.stop();
      lease.stop();
      await listenerSupervisor.stop().catch(() => undefined);
      await lease.release().catch(() => undefined);
      await client.quit().catch(() => undefined);
    },
  };
}

/**
 * Build a production dealer websocket. Uses the runtime's global
 * `WebSocket` (Node 22+ has it, and Node 20 exposes it under
 * `--experimental-websocket`) - the listener path is opt-in per environment
 * (needs a stored `spotify_listener` credential) so a runtime that lacks
 * `WebSocket` simply keeps the polling lane in charge until the runtime is
 * upgraded. Tests inject a fake, so this default is never exercised there.
 */
function buildDealerSocket(url: string): DealerSocket {
  const WS = (globalThis as { WebSocket?: new (u: string) => unknown })
    .WebSocket;
  if (!WS) {
    throw new Error(
      "listener: no global WebSocket available; upgrade Node or install a WebSocket polyfill"
    );
  }
  const raw = new WS(url) as unknown as {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(name: string, cb: (evt: unknown) => void): void;
  };
  const adapter: DealerSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      raw.send(data);
    },
    close(code, reason) {
      raw.close(code, reason);
    },
  };
  raw.addEventListener("open", () => adapter.onopen?.());
  raw.addEventListener("message", (evt) => {
    const data = (evt as { data: string | Buffer | ArrayBuffer }).data;
    adapter.onmessage?.(data);
  });
  raw.addEventListener("close", (evt) => {
    const e = evt as { code?: number; reason?: string };
    adapter.onclose?.(e.code ?? 1006, e.reason ?? "");
  });
  raw.addEventListener("error", (evt) => {
    adapter.onerror?.(evt);
  });
  return adapter;
}

/**
 * Build the production `putConnectState` implementation - a POST to
 * Spotify's connect-state edge with the minimal observer device descriptor.
 * The response body carries the current cluster; the dealer client emits it
 * as the initial `NowPlaying` state.
 */
function buildPutConnectState(): (
  args: PutConnectStateArgs
) => Promise<unknown> {
  return async (args) => {
    const url = DEFAULT_CONNECT_STATE_URL(args.device.device_id);
    const body = JSON.stringify({
      member_type: args.memberType,
      device: {
        device_info: args.device,
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.token}`,
          "X-Spotify-Connection-Id": args.connectionId,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`connect-state PUT returned status ${res.status}`);
      }
      try {
        return await res.json();
      } catch {
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

// Convenience re-exports for the routers/tests.
export {
  readSnapshot,
  readSnapshotRaw,
  snapshotKey,
  readSpotifySuspension,
  writeSpotifySuspension,
  deleteSpotifySuspension,
  spotifySuspensionKey,
  readSpotifyHealth,
  writeSpotifyHealth,
  spotifyHealthKey,
  readListenerHealth,
  writeListenerHealth,
  spotifyListenerHealthKey,
  type SpotifySuspensionRecord,
  type SpotifyHealthRecord,
  type SpotifyHealthLastError,
  type SpotifyHealthErrorKind,
  type ListenerHealthRecord,
  type ListenerHealthState,
  type ListenerHealthErrorKind,
  type ListenerHealthLastError,
} from "./snapshotStore";
export { readLocalSnapshot } from "./pollLoop";
export {
  createListenerSupervisor,
  LISTENER_CREDENTIAL_CHECK_INTERVAL_MS,
  LISTENER_PROGRESS_TICK_MS,
  type ListenerSupervisor,
  type ListenerSupervisorDeps,
} from "./listenerSupervisor";
