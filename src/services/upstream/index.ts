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
  readSpotifySuspension,
  writeSpotifySuspension,
  deleteSpotifySuspension,
} from "./snapshotStore";

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
  SPOTIFY_SERVICE_KEY,
} from "../spotifyTokenStore";

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
    const stored = await getStoredSpotifyToken(resolveEncryptionKey(s));
    return {
      clientId: s?.spotify_client_id ?? "",
      clientSecret: s?.spotify_client_secret ?? "",
      refreshToken: stored?.refreshToken ?? s?.spotify_refresh_token ?? "",
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

  // Viewer-aware + auth-aware Spotify lane (task #95 + shared-suspension #96).
  // Everything the lane needs from the outside world is injected here so the
  // lane module has no dependency on Express / Redis / DB — the tests can
  // build a pure fake.
  const spotifyLane = createSpotifyLane(
    {
      isAuthSuspended: () => isSpotifyAuthSuspended(),
      getBackoffUntilMs: () => getSpotifyBackoffUntilMs(),
      applyAuthSuspension: (reason) => suspendSpotifyAuth(reason),
      applyBackoffUntil: (untilMs) => applySpotifyBackoffUntil(untilMs),
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

  // First-boot acquisition attempt, then the renewal loop takes over. We DO NOT
  // await this — the poll loop is inert until the lease flips leader anyway.
  lease
    .tryAcquire()
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
    },
  });

  return {
    enabled: true,
    lease,
    loop,
    redis: client,
    async stop() {
      loop.stop();
      lease.stop();
      await lease.release().catch(() => undefined);
      await client.quit().catch(() => undefined);
    },
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
  type SpotifySuspensionRecord,
} from "./snapshotStore";
export { readLocalSnapshot } from "./pollLoop";
