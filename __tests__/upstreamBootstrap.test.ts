import { bootstrapUpstream } from "../src/services/upstream";
import { resolveRedisClient } from "../src/services/upstream/redisClient";
import type { Express } from "express";
import type { IAppSecrets } from "../src/interfaces";

/**
 * Bootstrap acceptance tests (task #84).
 *
 * With REDIS_URL unset:
 *   - resolveRedisClient() returns null (ioredis is never loaded).
 *   - bootstrapUpstream() returns an inert handle (`enabled === false`, `stop`
 *     is a no-op).
 * With REDIS_URL set to any string, resolveRedisClient() DOES attempt to
 * construct a client — we only test the guard here, not the real connection.
 */

function fakeApp(secrets: Partial<IAppSecrets>): Express {
  const store: Record<string, unknown> = {};
  return {
    set(key: string, value: unknown) {
      store[key] = value;
    },
    get(key: string) {
      if (key === "secrets") return secrets;
      return store[key];
    },
  } as unknown as Express;
}

describe("resolveRedisClient — Redis-optional guard", () => {
  it("returns null when REDIS_URL is unset (no ioredis loaded)", () => {
    expect(resolveRedisClient(undefined)).toBeNull();
    expect(resolveRedisClient(null)).toBeNull();
    expect(resolveRedisClient("")).toBeNull();
  });
});

describe("bootstrapUpstream — inert without Redis", () => {
  it("returns an inert handle when secrets carry no redis_url", () => {
    const app = fakeApp({
      node_env: "development",
    });
    const originalEnv = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const handle = bootstrapUpstream(app);
      expect(handle.enabled).toBe(false);
      expect(handle.lease).toBeNull();
      expect(handle.redis).toBeNull();
      // Stop is a no-op — should not throw.
      return handle.stop();
    } finally {
      if (originalEnv !== undefined) process.env.REDIS_URL = originalEnv;
    }
  });
});
