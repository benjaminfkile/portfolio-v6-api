/**
 * Shared upstream-snapshot store, backed by Redis (task #84).
 *
 * The single leader (see `leaderLease`) writes each service's curated payload
 * here; every instance — leader or not — serves `/api/now-playing`, `/api/status`,
 * `/api/duolingo`, `/api/github` from these snapshots when Redis is configured.
 * Reads NEVER 5xx: any Redis failure returns `null` and the router falls back to
 * today's per-instance path.
 *
 * Snapshots are opaque JSON strings — the store does not know each service's
 * payload shape. Callers stringify on write and parse on read; the wrapper adds
 * a `fetched_at` timestamp (ISO 8601) so future clients can reason about
 * staleness without a per-service `updated_at` field.
 *
 * Keys are prefixed with the environment name so prod and dev never share
 * snapshots even when they point at the same Redis (see `SnapshotKeyspace`).
 */

import type { RedisClient } from "./redisClient";

/**
 * Redis key for the "when did any instance last serve GET /api/now-playing"
 * stamp (task #95, viewer-aware Spotify cadence). Every instance stamps this
 * cheaply on the request path (SET with TTL) and the leader reads it each
 * tick to keep the fast cadence alive while polling-fallback viewers are
 * around, even when the realtime presence count is 0.
 */
export function nowPlayingLastRequestKey(env: string): string {
  return `portfolio-v6-api:${env}:now-playing:last-public-request-at`;
}

/**
 * TTL on the last-public-request stamp — one hour, well past the 5-minute
 * "recent activity" window the lane uses. Kept generous so a Redis PX blip
 * doesn't drop the stamp mid-window; the lane's own comparison is what
 * enforces the 5-minute cutoff.
 */
export const NOW_PLAYING_LAST_REQUEST_TTL_MS = 60 * 60 * 1000;

/**
 * Stamp `now` as the most recent time any instance served a public
 * now-playing request. Failure is logged and swallowed — a Redis blip must
 * never fail the public endpoint (§3.5).
 */
export async function stampNowPlayingLastRequest(
  client: RedisClient,
  env: string,
  when: Date = new Date()
): Promise<void> {
  const key = nowPlayingLastRequestKey(env);
  try {
    await client.set(key, when.toISOString(), {
      pxMs: NOW_PLAYING_LAST_REQUEST_TTL_MS,
    });
  } catch (err) {
    console.error(
      `[snapshotStore] last-public-request stamp failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Read the most recent public now-playing request timestamp, or `null` when
 * absent (nobody's asked recently) or on Redis error (treated as "no recent
 * activity" — the presence check is what keeps the feature alive on its own).
 */
export async function readNowPlayingLastRequest(
  client: RedisClient,
  env: string
): Promise<Date | null> {
  const key = nowPlayingLastRequestKey(env);
  let raw: string | null = null;
  try {
    raw = await client.get(key);
  } catch (err) {
    console.error(
      `[snapshotStore] last-public-request read failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
  if (raw == null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** One curated snapshot as stored in Redis, plus when it was written. */
export interface Snapshot<T> {
  payload: T;
  /** ISO 8601 timestamp — when the leader wrote this snapshot. */
  fetched_at: string;
}

/**
 * Which upstream a snapshot belongs to. Kept as a discriminated string union so
 * `snapshotKey(env, "now-playing")` produces one canonical key per service.
 */
export type SnapshotService =
  | "now-playing"
  | "status"
  | "duolingo"
  | "github";

/**
 * Build a Redis key for `service` in `env`. Prod and dev keys never collide.
 * Duolingo/GitHub snapshots vary by query parameter (language, year) — the
 * caller passes those as `variant`.
 */
export function snapshotKey(
  env: string,
  service: SnapshotService,
  variant?: string
): string {
  const base = `portfolio-v6-api:${env}:snapshot:${service}`;
  return variant ? `${base}:${variant}` : base;
}

/**
 * TTL after which Redis drops the snapshot. Kept generous (10 minutes) so a
 * brief poll-loop pause on the leader does not empty the cache for readers —
 * the leader refreshes every fast-lane tick anyway, so a stale entry is
 * replaced far before TTL. Slow-lane services (Duolingo/GitHub) have their own
 * ~1h refresh cadence and keep the same 10-minute Redis TTL: the leader re-
 * writes them well before Redis expires them.
 */
export const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/**
 * Write a curated payload for `service`. Failure is logged and swallowed — the
 * leader must never crash because Redis is temporarily unavailable.
 */
export async function writeSnapshot<T>(
  client: RedisClient,
  env: string,
  service: SnapshotService,
  payload: T,
  variant?: string
): Promise<void> {
  const key = snapshotKey(env, service, variant);
  const snapshot: Snapshot<T> = {
    payload,
    fetched_at: new Date().toISOString(),
  };
  try {
    await client.set(key, JSON.stringify(snapshot), {
      pxMs: SNAPSHOT_TTL_MS,
    });
  } catch (err) {
    console.error(
      `[snapshotStore] write failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Read the curated payload for `service`, or `null` when the snapshot is absent
 * (leader has not written yet), when Redis errors, or when the stored JSON does
 * not parse. Callers degrade to their per-instance path on `null`.
 */
export async function readSnapshot<T>(
  client: RedisClient,
  env: string,
  service: SnapshotService,
  variant?: string
): Promise<Snapshot<T> | null> {
  const raw = await readSnapshotRaw<T>(client, env, service, variant);
  if (raw.status !== "ok") return null;
  return raw.snapshot;
}

/**
 * Same as `readSnapshot` but returns a discriminated result so callers can
 * distinguish "Redis errored" (must fall back to legacy path) from "Redis
 * healthy but no snapshot written yet" (task #96 invariant: serve degraded).
 */
export type ReadSnapshotResult<T> =
  | { status: "ok"; snapshot: Snapshot<T> }
  | { status: "missing" }
  | { status: "error" };

export async function readSnapshotRaw<T>(
  client: RedisClient,
  env: string,
  service: SnapshotService,
  variant?: string
): Promise<ReadSnapshotResult<T>> {
  const key = snapshotKey(env, service, variant);
  let raw: string | null = null;
  try {
    raw = await client.get(key);
  } catch (err) {
    console.error(
      `[snapshotStore] read failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return { status: "error" };
  }
  if (raw == null) return { status: "missing" };
  try {
    const parsed = JSON.parse(raw) as Snapshot<T>;
    if (parsed && typeof parsed === "object" && "payload" in parsed) {
      return { status: "ok", snapshot: parsed };
    }
    return { status: "missing" };
  } catch {
    return { status: "missing" };
  }
}

// ============================================================================
// Shared Spotify suspension state (task #96)
// ============================================================================

/**
 * Redis key holding the SHARED Spotify suspension state — the record any
 * newly-elected leader honors so it does NOT re-trip Spotify to rediscover a
 * known suspension. Deleting this key is the documented operator override to
 * force an immediate retry on the next tick.
 */
export function spotifySuspensionKey(env: string): string {
  return `portfolio-v6-api:${env}:snapshot:now-playing:suspension`;
}

/**
 * A persisted Spotify suspension. `suspended_until` is the wall-clock (ISO
 * 8601) that Spotify traffic can resume; every entry carries this deadline so
 * recovery is automatic even when nobody deletes the key. `reason` is a short
 * machine-friendly tag (`"auth"` for invalid_grant / missing credentials,
 * `"429"` for rate-limit backoff); `detail` is a human-readable elaboration
 * kept for logs and admin dashboards. `captured_token_updated_at` snapshots
 * `service_tokens.updated_at` at the moment the auth suspension was recorded,
 * so any leader (including a fresh one that never observed the trip) can
 * detect an admin reconnect by comparing its DB read against that value.
 */
export interface SpotifySuspensionRecord {
  suspended_until: string;
  reason: "auth" | "429";
  detail?: string;
  captured_token_updated_at?: string | null;
}

/**
 * TTL floor on the suspension record. Redis expiry is a safety net for a
 * situation where the leader dies and nothing rewrites the record; the leader
 * itself refreshes the record every tick while the local state remains
 * suspended. Kept longer than the leader lease TTL (15s) so a brief
 * leader-failover window never surfaces a false "not suspended" read.
 */
export const SPOTIFY_SUSPENSION_MIN_TTL_MS = 60 * 1000;

/**
 * Write / overwrite the shared suspension record. TTL is derived from the
 * deadline (`suspended_until - now`), floored at `SPOTIFY_SUSPENSION_MIN_TTL_MS`
 * so a very-soon deadline does not race the write's own PX round-trip.
 * Failures are logged and swallowed — Redis being unavailable must never crash
 * the poll loop.
 */
export async function writeSpotifySuspension(
  client: RedisClient,
  env: string,
  record: SpotifySuspensionRecord
): Promise<void> {
  const key = spotifySuspensionKey(env);
  const deadline = Date.parse(record.suspended_until);
  const now = Date.now();
  const ttl = Number.isFinite(deadline)
    ? Math.max(SPOTIFY_SUSPENSION_MIN_TTL_MS, deadline - now + 5_000)
    : SPOTIFY_SUSPENSION_MIN_TTL_MS;
  try {
    await client.set(key, JSON.stringify(record), { pxMs: ttl });
  } catch (err) {
    console.error(
      `[snapshotStore] suspension write failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Read the shared suspension record, or `null` when absent / on Redis error /
 * when the stored JSON does not parse. A read error is treated as "no
 * suspension" so a Redis blip never leaves the leader stuck skipping.
 */
export async function readSpotifySuspension(
  client: RedisClient,
  env: string
): Promise<SpotifySuspensionRecord | null> {
  const key = spotifySuspensionKey(env);
  let raw: string | null = null;
  try {
    raw = await client.get(key);
  } catch (err) {
    console.error(
      `[snapshotStore] suspension read failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as SpotifySuspensionRecord;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.suspended_until === "string" &&
      (parsed.reason === "auth" || parsed.reason === "429")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete the shared suspension record. Called when the leader positively
 * observes Spotify is answering again (successful fetch after a suspension) or
 * when the admin reconnects — the operator override path (`redis-cli DEL ...`)
 * relies on the same key. Failure is logged and swallowed.
 */
export async function deleteSpotifySuspension(
  client: RedisClient,
  env: string
): Promise<void> {
  const key = spotifySuspensionKey(env);
  try {
    await client.del(key);
  } catch (err) {
    console.error(
      `[snapshotStore] suspension delete failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
  }
}
