/**
 * In-memory `RedisClient` implementation for tests (task #84).
 *
 * Supports the exact contract the leader lease + snapshot store depend on:
 *   - GET / SET (with PX and NX)
 *   - compare-and-delete (`delIfEquals`)
 *   - compare-and-renew (`pExpireIfEquals`)
 *
 * TTL is enforced lazily on read/write — Jest's fake-timer support isn't
 * required. Each entry stores its absolute `expiresAt`; access after that point
 * treats the key as absent (matching Redis's own PX behavior).
 *
 * A `queueError` helper lets tests simulate a transient Redis outage without
 * shutting the whole fake down: the next call throws, then normal behavior
 * resumes. That mirrors the acceptance criterion "public reads never 5xx
 * because of Redis" — the router / snapshot store swallow the error.
 */

import type { RedisClient } from "../../src/services/upstream/redisClient";

interface Entry {
  value: string;
  expiresAt: number | null;
}

export interface FakeRedis extends RedisClient {
  /** Snapshot of currently-live keys (for assertions). */
  dump(): Record<string, string>;
  /** Force-inject a value (used by tests to prime a snapshot). */
  seed(key: string, value: string, pxMs?: number): void;
  /** Manually expire everything (mimics a full flush). */
  flushAll(): void;
  /** Queue a one-shot error for the next command of any kind. */
  queueError(err: Error): void;
  /** Return every command the client has received (for assertions). */
  history(): string[];
}

export function createFakeRedis(): FakeRedis {
  const map = new Map<string, Entry>();
  const errQueue: Error[] = [];
  const cmdHistory: string[] = [];

  function now(): number {
    return Date.now();
  }

  function alive(key: string): Entry | null {
    const e = map.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= now()) {
      map.delete(key);
      return null;
    }
    return e;
  }

  function maybeThrow(): void {
    const err = errQueue.shift();
    if (err) throw err;
  }

  return {
    async get(key) {
      cmdHistory.push(`GET ${key}`);
      maybeThrow();
      const e = alive(key);
      return e ? e.value : null;
    },
    async set(key, value, opts) {
      cmdHistory.push(
        `SET ${key} ${opts?.pxMs ?? ""} ${opts?.mode ?? ""}`.trim()
      );
      maybeThrow();
      if (opts?.mode === "NX" && alive(key)) return null;
      const expiresAt = opts?.pxMs ? now() + opts.pxMs : null;
      map.set(key, { value, expiresAt });
      return "OK";
    },
    async delIfEquals(key, value) {
      cmdHistory.push(`DELIFEQ ${key}`);
      maybeThrow();
      const e = alive(key);
      if (!e || e.value !== value) return 0;
      map.delete(key);
      return 1;
    },
    async pExpireIfEquals(key, value, pxMs) {
      cmdHistory.push(`PEXPIREIFEQ ${key} ${pxMs}`);
      maybeThrow();
      const e = alive(key);
      if (!e || e.value !== value) return 0;
      e.expiresAt = now() + pxMs;
      return 1;
    },
    async del(key) {
      cmdHistory.push(`DEL ${key}`);
      maybeThrow();
      const existed = alive(key) !== null;
      map.delete(key);
      return existed ? 1 : 0;
    },
    async quit() {
      cmdHistory.push("QUIT");
      map.clear();
    },
    dump() {
      const out: Record<string, string> = {};
      for (const [k] of map) {
        const e = alive(k);
        if (e) out[k] = e.value;
      }
      return out;
    },
    seed(key, value, pxMs) {
      map.set(key, {
        value,
        expiresAt: pxMs ? now() + pxMs : null,
      });
    },
    flushAll() {
      map.clear();
    },
    queueError(err) {
      errQueue.push(err);
    },
    history() {
      return cmdHistory.slice();
    },
  };
}
