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
  SLOW_LANE_REFRESH_MS,
  type PollLoopHandle,
  type PollFetchers,
} from "./pollLoop";
import {
  DEFAULT_REALTIME_SERVICE_NAME,
  type RealtimePublisherConfig,
} from "./realtimePublisher";
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
import { saveLastNowPlaying } from "../nowPlayingStateStore";

// Fetcher helpers reach into the existing per-service modules so the leader
// uses the SAME curation / degrade logic the routers used to serve directly.
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
  resolveEncryptionKey,
} from "../serviceTokenStore";

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
 * Wire the curated fetchers to the existing service modules. Each fetcher
 * catches every error and returns `null` on failure so the poll loop treats
 * the tick as a skip (no snapshot write, no publish, no crash).
 *
 * Now-playing is NOT here — it is listener-only (the dealer listener owns that
 * snapshot). The loop drives only status, duolingo, and github.
 */
export function buildFetchers(app: Express): PollFetchers {
  const secrets = () => app.get("secrets") as IAppSecrets | undefined;

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

  // Connect-listener supervisor (task #118). Owns the dealer websocket
  // lifecycle for this process; leader-gated. It is the SOLE source of
  // now-playing (the Spotify Web API polling path was removed).
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
    async persistLastNowPlaying(payload) {
      await saveLastNowPlaying(payload);
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

  const loop = startPollLoop(
    client,
    lease,
    buildFetchers(app),
    {
      env,
      pollIntervalMs,
      slowLaneRefreshMs: SLOW_LANE_REFRESH_MS,
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
 * Build a production dealer websocket. Prefers the runtime's global
 * `WebSocket` (Node 22+ has it) and falls back to the bundled `ws` package on
 * runtimes that lack it (the runtime image is Node 20, whose global WebSocket
 * is only behind `--experimental-websocket`). Both expose the same
 * `addEventListener`-based surface, so the adapter below is identical for
 * either. Tests inject a fake, so this default is never exercised there.
 */
function buildDealerSocket(url: string): DealerSocket {
  const WS =
    (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket ??
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require("ws") as new (u: string) => unknown);
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
    // Spotify's connect-state edge rejects any descriptive device fields
    // (device_id/name/brand/...) inside device_info as INVALID_ENTITY; it
    // accepts only the capabilities object. The device_id lives in the URL
    // above, never in the body.
    const body = JSON.stringify({
      member_type: args.memberType,
      device: {
        device_info: {
          capabilities: args.device.capabilities,
        },
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
