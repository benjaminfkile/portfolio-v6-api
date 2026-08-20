/**
 * Redis leader lease (task #84).
 *
 * We run multiple API instances per environment; without coordination each one
 * would independently exercise the shared Spotify credentials (a dealer
 * websocket, or a Web API poll every few seconds), which trips Spotify's per-
 * client rate limits. The lease is a `SET NX PX` on a single Redis key:
 * exactly one instance wins per environment, holds the key for `leaseTtlMs`,
 * and periodically CAS-renews it every `renewIntervalMs`. On renewal failure
 * (Redis outage, or another instance stole the lease after the TTL) the
 * leader-gated work (dealer listener, polling fallback) STOPS immediately;
 * another instance will acquire within one lease TTL.
 *
 * The lease VALUE is a per-process instance id (a UUID minted at boot). Renew
 * and release both compare-and-set on that value, so an instance never extends
 * or releases a lease another instance now owns.
 *
 * A note on process id vs. hostname: some containers reuse hostnames on
 * rolling redeploy, and a bare pid recycles on restart. A random UUID at boot
 * is unique regardless — mistaken renewals become impossible.
 */

import { randomUUID } from "crypto";

import type { RedisClient } from "./redisClient";

/** How the lease is configured — TTL, renewal cadence, and its Redis key. */
export interface LeaderLeaseConfig {
  /**
   * Redis key holding the lease. Must include the environment name so prod and
   * dev never share a lease. Example: `portfolio-v6-api:prod:upstream-leader`.
   */
  key: string;
  /**
   * Lease TTL (ms). Redis expires the key after this window if not renewed. A
   * dead leader is replaced within one TTL — kept short (~15s) so failover is
   * fast without the renewal loop hammering Redis.
   */
  leaseTtlMs: number;
  /**
   * Cadence at which the leader CAS-renews the key. MUST be well under
   * `leaseTtlMs`; a healthy leader renews several times per TTL so a single
   * missed renewal (transient network blip) never drops the lease.
   */
  renewIntervalMs: number;
}

/** Sensible defaults — 15s TTL, renew every 5s. */
export const DEFAULT_LEASE_TTL_MS = 15_000;
export const DEFAULT_RENEW_INTERVAL_MS = 5_000;

/** One process's view of the lease — is it currently leader, and its id. */
export interface LeaderLease {
  /** True while this process currently holds the lease. */
  isLeader(): boolean;
  /** This process's stable identifier (the value stored in the lease key). */
  instanceId: string;
  /**
   * Attempt to acquire the lease. Returns true on success (or if this process
   * already holds it), false when another instance holds it or Redis errored.
   */
  tryAcquire(): Promise<boolean>;
  /**
   * Compare-and-renew the lease. Returns true on success, false when the CAS
   * failed (another instance took over, or the key expired). Callers handle
   * false by stopping polling and dropping to a candidate state.
   */
  tryRenew(): Promise<boolean>;
  /**
   * Release the lease if this process holds it (compare-and-delete). Called on
   * SIGINT/SIGTERM so failover is instant instead of taking a full lease TTL.
   */
  release(): Promise<void>;
  /**
   * Start the background renewal loop. Returns an `unref`-able stop function.
   * Calls the optional `onLostLease` callback on any renewal failure — the poll
   * loop uses this to stop fetching immediately (per the task spec).
   */
  start(opts?: { onLostLease?: () => void }): void;
  /** Stop the renewal loop. Idempotent. */
  stop(): void;
}

/**
 * Build a lease bound to a specific Redis client + key. The returned object is
 * inert until `tryAcquire()`/`start()` are called; construction never touches
 * Redis. The lease value is a UUID minted here so it survives process restarts
 * (a fresh id → the old lease is a stranger, never mistakenly renewed).
 */
export function createLeaderLease(
  client: RedisClient,
  config: LeaderLeaseConfig
): LeaderLease {
  const instanceId = randomUUID();
  let leader = false;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let onLostLeaseCb: (() => void) | null = null;

  async function tryAcquire(): Promise<boolean> {
    try {
      const res = await client.set(config.key, instanceId, {
        pxMs: config.leaseTtlMs,
        mode: "NX",
      });
      leader = res === "OK";
      return leader;
    } catch (err) {
      console.error(
        "[leaderLease] acquire failed:",
        err instanceof Error ? err.message : err
      );
      leader = false;
      return false;
    }
  }

  async function tryRenew(): Promise<boolean> {
    try {
      const n = await client.pExpireIfEquals(
        config.key,
        instanceId,
        config.leaseTtlMs
      );
      const ok = n === 1;
      if (!ok) leader = false;
      return ok;
    } catch (err) {
      console.error(
        "[leaderLease] renew failed:",
        err instanceof Error ? err.message : err
      );
      leader = false;
      return false;
    }
  }

  async function release(): Promise<void> {
    if (!leader) return;
    try {
      await client.delIfEquals(config.key, instanceId);
    } catch (err) {
      console.error(
        "[leaderLease] release failed:",
        err instanceof Error ? err.message : err
      );
    } finally {
      leader = false;
    }
  }

  function stop(): void {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }

  function start(opts?: { onLostLease?: () => void }): void {
    onLostLeaseCb = opts?.onLostLease ?? null;
    if (renewTimer) return;
    renewTimer = setInterval(async () => {
      // If we don't currently hold the lease, try to acquire (silently). On the
      // acquire path we do NOT invoke onLostLease — this loop is the how the
      // non-leader path polls for its next chance without spinning a separate
      // acquire timer. When we DO hold it, a renewal failure is the "we just
      // lost it" signal, so the callback fires.
      if (!leader) {
        await tryAcquire();
        return;
      }
      const ok = await tryRenew();
      if (!ok && onLostLeaseCb) {
        try {
          onLostLeaseCb();
        } catch (err) {
          console.error(
            "[leaderLease] onLostLease callback threw:",
            err instanceof Error ? err.message : err
          );
        }
      }
    }, config.renewIntervalMs);
    // Do not keep the event loop alive just for the renewal timer.
    if (typeof (renewTimer as unknown as { unref?: () => void }).unref === "function") {
      (renewTimer as unknown as { unref: () => void }).unref();
    }
  }

  return {
    instanceId,
    isLeader: () => leader,
    tryAcquire,
    tryRenew,
    release,
    start,
    stop,
  };
}
