/**
 * Single-poller upstream refresh loop (task #84).
 *
 * The leader (see `leaderLease`) runs this loop; every non-leader is silent.
 * The base tick — `POLL_INTERVAL_MS`, default 10s (prod runs 5s, dev 10s) —
 * drives:
 *   - Spotify now-playing (fallback lane): the dealer listener from task
 *     series #115-#123 is the primary source; polling only runs when the
 *     listener is not connected AND the Spotify lane's predictive/idle
 *     deadline has elapsed (see spotifyLane for the full cadence rules).
 *   - gateway status, refreshed EVERY tick (independent of Spotify).
 *   - slow lane, refreshed only when the local deadline has elapsed: Duolingo
 *     and GitHub. Their upstream TTLs stay long (~1h); the leader re-fetches
 *     them once per TTL, not every tick.
 *
 * After each fetch, the loop:
 *   1. writes the curated payload + `fetched_at` to the shared snapshot store,
 *   2. publishes to the gateway realtime hub ONLY IF the payload differs from
 *      the previous one (change-detection — silent when nothing changed),
 *   3. emits a lightweight heartbeat on the now-playing channel every ~30s so
 *      clients can detect a stalled stream (REALTIME.md polling-floor pattern).
 *
 * Publish failures and snapshot write failures are logged and swallowed — they
 * never affect the poll cadence or public HTTP serving. On renewal failure the
 * lease invokes `onLostLease`, which stops the loop immediately.
 */

import type { RedisClient } from "./redisClient";
import type { LeaderLease } from "./leaderLease";
import {
  writeSnapshot,
  SnapshotService,
} from "./snapshotStore";
import {
  publish,
  RealtimePublisherConfig,
} from "./realtimePublisher";

type StatusLike = { degraded: boolean; services: unknown[] };

const DEGRADED_STATUS: StatusLike = { degraded: true, services: [] };

/** Base tick default — used when POLL_INTERVAL_MS is unset. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Duolingo/GitHub upstream TTL. The leader re-fetches the default view of each
 * slow-lane service every `SLOW_LANE_REFRESH_MS`. Kept SLIGHTLY under the
 * services' existing 1h upstream cache TTL so the shared snapshot never lags
 * the local caches: `55 * 60_000` = 55 minutes.
 */
export const SLOW_LANE_REFRESH_MS = 55 * 60 * 1000;

/**
 * A curated fetcher for one service. Returns the payload (any shape — opaque to
 * the loop) or `null` when the fetch surfaces nothing worth writing. Fetchers
 * MUST NEVER throw — the loop is trust-boundary and treats a rejection as a
 * one-tick skip.
 */
export type Fetcher<T> = () => Promise<T | null>;

/**
 * The set of curated fetchers the loop drives. Kept generic so tests inject
 * fakes; the real bindings are assembled in the bootstrap module (`index.ts`
 * next to this file) so this module stays free of app-specific imports.
 *
 * Now-playing is NOT here: it is listener-only (the dealer listener owns that
 * snapshot). The loop drives only the status, duolingo, and github lanes.
 */
export interface PollFetchers {
  status: Fetcher<unknown>;
  duolingo: Fetcher<unknown>;
  github: Fetcher<unknown>;
}

/** Runtime knobs. Every field is required so the loop has no implicit config. */
export interface PollLoopConfig {
  /** Environment name used to prefix Redis snapshot keys. */
  env: string;
  /** Base tick — how often the loop wakes and evaluates each lane. */
  pollIntervalMs: number;
  /**
   * Slow-lane refresh deadline. Exposed so tests can shorten it; production
   * uses `SLOW_LANE_REFRESH_MS`.
   */
  slowLaneRefreshMs: number;
  /** Realtime publish config; unset fields disable publishing (no-op). */
  publisher: RealtimePublisherConfig;
}

/**
 * Handle returned by `startPollLoop`. `stop()` clears every timer and is
 * idempotent; `runTick()` runs one tick synchronously (exposed for tests).
 */
export interface PollLoopHandle {
  stop(): void;
  runTick(): Promise<void>;
}

/**
 * Public read of the currently-in-memory snapshot payload for `service`, used
 * by routers as a fallback when Redis is unreachable but this instance is the
 * leader that just wrote a fresh payload. Kept module-scoped so both the loop
 * (writer) and the router-side helper (reader) see the same map.
 */
const localSnapshots = new Map<SnapshotService, unknown>();

/** Test-only reset — clears the in-process snapshot cache and prev payloads. */
export function _resetPollLoopStateForTests(): void {
  localSnapshots.clear();
}

/** Read the leader's most recent in-process payload for `service`, or null. */
export function readLocalSnapshot<T = unknown>(
  service: SnapshotService
): T | null {
  const v = localSnapshots.get(service);
  return v == null ? null : (v as T);
}

/**
 * Stable JSON serialize for change detection. Object keys are sorted so
 * `{a:1,b:2}` and `{b:2,a:1}` hash the same — the upstream services build
 * their payloads deterministically, but a defensive sort costs almost nothing
 * and immunizes us against a future refactor that re-orders fields.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Start the leader poll loop.
 *
 * The loop only fetches while `lease.isLeader()` is true — a `runTick` on a
 * non-leader is a no-op. The lease's `onLostLease` should call `stop()` on the
 * returned handle, though the loop is also self-guarded so a race between
 * "renew failed" and "next tick fires" is benign.
 *
 * Passing `client === null` (Redis unset or unavailable at boot) makes the
 * whole loop inert — nothing is scheduled, and every router falls back to its
 * per-instance path. This is the "REDIS_URL unset → behavior identical to
 * today" acceptance path.
 */
export function startPollLoop(
  client: RedisClient | null,
  lease: LeaderLease | null,
  fetchers: PollFetchers,
  config: PollLoopConfig
): PollLoopHandle {
  if (!client || !lease) {
    return { stop: () => undefined, runTick: async () => undefined };
  }

  // Per-service change-detection state (only leader writes it).
  const prevSerialized = new Map<SnapshotService, string>();

  // Slow-lane deadlines: when the next fetch is due for each service.
  let duolingoDueAt = 0;
  let githubDueAt = 0;

  async function writeAndMaybePublish<T>(
    service: SnapshotService,
    payload: T,
    publishTopic?: string
  ): Promise<void> {
    localSnapshots.set(service, payload);
    await writeSnapshot(client!, config.env, service, payload);

    if (publishTopic) {
      const serialized = stableStringify(payload);
      if (prevSerialized.get(service) !== serialized) {
        prevSerialized.set(service, serialized);
        await publish(config.publisher, {
          topic: publishTopic,
          event: "snapshot",
          data: payload,
        });
      }
    }
  }

  /**
   * Fetch a payload and, if the fetcher returned data, write / publish it.
   * Returns the payload that was written, or `null` when the fetcher skipped
   * (429 backoff, auth-suspended, upstream error) - callers fall back to a
   * degraded payload in that case. Task #96 invariant: EVERY processed tick
   * writes SOME snapshot for now-playing + status.
   */
  async function refreshOne<T>(
    service: SnapshotService,
    fetcher: Fetcher<T>,
    publishTopic?: string
  ): Promise<T | null> {
    let payload: T | null = null;
    try {
      payload = await fetcher();
    } catch (err) {
      console.error(
        `[pollLoop] fetch failed for ${service}:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
    if (payload == null) return null;

    await writeAndMaybePublish(service, payload, publishTopic);
    return payload;
  }

  async function runTick(): Promise<void> {
    if (!lease!.isLeader()) return;

    const now = Date.now();

    // Now-playing is listener-only (the dealer listener owns that snapshot and
    // persists to the DB). The poll loop no longer touches Spotify at all — it
    // drives the status, duolingo, and github lanes exclusively.

    // Status refreshes on the base tick.
    // Same always-write invariant: a fetcher failure / null payload writes
    // the degraded shape so non-leaders never find the key missing.
    const statusPayload = await refreshOne("status", fetchers.status, "status");
    if (statusPayload == null) {
      await writeAndMaybePublish("status", DEGRADED_STATUS, "status");
    }

    // Slow lane — only when the local deadline elapses.
    if (now >= duolingoDueAt) {
      duolingoDueAt = now + config.slowLaneRefreshMs;
      await refreshOne("duolingo", fetchers.duolingo);
    }
    if (now >= githubDueAt) {
      githubDueAt = now + config.slowLaneRefreshMs;
      await refreshOne("github", fetchers.github);
    }
  }

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return; // never overlap ticks — degrade to skip
    ticking = true;
    try {
      await runTick();
    } catch (err) {
      // Belt-and-braces — refreshOne/publish already swallow their own errors.
      console.error(
        "[pollLoop] tick threw:",
        err instanceof Error ? err.message : err
      );
    } finally {
      ticking = false;
    }
  }, config.pollIntervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
    runTick,
  };
}
