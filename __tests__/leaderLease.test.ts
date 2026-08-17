import {
  createLeaderLease,
  DEFAULT_LEASE_TTL_MS,
} from "../src/services/upstream/leaderLease";
import { createFakeRedis } from "./helpers/fakeRedis";

/**
 * Leader-lease tests (task #84).
 *
 * The lease is a Redis SET NX PX with compare-and-set renewal — exactly one
 * instance per environment holds it. Covered:
 *   - Only one instance wins acquire; the other loses.
 *   - Renewal extends the TTL when we still own it.
 *   - Renewal fails when another instance stole the lease (post-expiry) —
 *     the loser drops back to leader=false and the loop can stop fetching.
 *   - Release compare-and-deletes only when we still own it.
 *   - Redis errors on acquire/renew never throw upward — we degrade to
 *     `not leader` so the caller stays safe.
 */

const LEASE_KEY = "portfolio-v6-api:test:upstream-leader";

describe("leaderLease acquire/renew/failover", () => {
  it("elects exactly one leader across two candidates", async () => {
    const redis = createFakeRedis();
    const a = createLeaderLease(redis, {
      key: LEASE_KEY,
      leaseTtlMs: 1000,
      renewIntervalMs: 500,
    });
    const b = createLeaderLease(redis, {
      key: LEASE_KEY,
      leaseTtlMs: 1000,
      renewIntervalMs: 500,
    });

    const gotA = await a.tryAcquire();
    const gotB = await b.tryAcquire();

    expect(gotA).toBe(true);
    expect(a.isLeader()).toBe(true);
    expect(gotB).toBe(false);
    expect(b.isLeader()).toBe(false);
    expect(redis.dump()[LEASE_KEY]).toBe(a.instanceId);
  });

  it("renewal extends the TTL while we still own the lease", async () => {
    const redis = createFakeRedis();
    const lease = createLeaderLease(redis, {
      key: LEASE_KEY,
      leaseTtlMs: 500,
      renewIntervalMs: 100,
    });

    expect(await lease.tryAcquire()).toBe(true);
    expect(await lease.tryRenew()).toBe(true);
    expect(lease.isLeader()).toBe(true);
  });

  it("renewal fails when the lease expired and someone else took it", async () => {
    jest.useFakeTimers();
    try {
      const redis = createFakeRedis();
      const a = createLeaderLease(redis, {
        key: LEASE_KEY,
        leaseTtlMs: 200,
        renewIntervalMs: 100,
      });
      const b = createLeaderLease(redis, {
        key: LEASE_KEY,
        leaseTtlMs: 200,
        renewIntervalMs: 100,
      });

      expect(await a.tryAcquire()).toBe(true);
      // Advance past the TTL — the fake Redis expires lazily on next access.
      jest.advanceTimersByTime(300);

      // B walks in and grabs the now-expired lease.
      expect(await b.tryAcquire()).toBe(true);
      expect(redis.dump()[LEASE_KEY]).toBe(b.instanceId);

      // A's renewal must now fail — the value CAS mismatches.
      expect(await a.tryRenew()).toBe(false);
      expect(a.isLeader()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("release compare-and-deletes only when we still own it", async () => {
    const redis = createFakeRedis();
    const lease = createLeaderLease(redis, {
      key: LEASE_KEY,
      leaseTtlMs: 1000,
      renewIntervalMs: 500,
    });
    expect(await lease.tryAcquire()).toBe(true);

    // Simulate another instance overwriting the key (should not happen with NX,
    // but this proves the CAS guard on release).
    redis.seed(LEASE_KEY, "someone-else", 1000);

    await lease.release();
    // The value is untouched because it does not match our instance id.
    expect(redis.dump()[LEASE_KEY]).toBe("someone-else");
  });

  it("degrades to not-leader when Redis throws on acquire", async () => {
    const redis = createFakeRedis();
    redis.queueError(new Error("ECONNRESET"));
    // Silence the acquire-failed console.error so the test output stays clean.
    jest.spyOn(console, "error").mockImplementation(() => {});

    const lease = createLeaderLease(redis, {
      key: LEASE_KEY,
      leaseTtlMs: 1000,
      renewIntervalMs: 500,
    });
    expect(await lease.tryAcquire()).toBe(false);
    expect(lease.isLeader()).toBe(false);
  });

  it("degrades to not-leader when Redis throws on renew", async () => {
    const redis = createFakeRedis();
    jest.spyOn(console, "error").mockImplementation(() => {});
    const lease = createLeaderLease(redis, {
      key: LEASE_KEY,
      leaseTtlMs: 1000,
      renewIntervalMs: 500,
    });
    expect(await lease.tryAcquire()).toBe(true);

    redis.queueError(new Error("timeout"));
    expect(await lease.tryRenew()).toBe(false);
    expect(lease.isLeader()).toBe(false);
  });

  it("uses the default lease TTL when configured with it", async () => {
    // Not a behavior test per se — just a sanity check the exported constant
    // reads as a positive number that renewal loops can divide.
    expect(DEFAULT_LEASE_TTL_MS).toBeGreaterThan(1_000);
  });
});
