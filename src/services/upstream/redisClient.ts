/**
 * Slim Redis wrapper for the single-poller / shared-snapshot subsystem (task #84).
 *
 * The subsystem talks to Redis through this narrow interface (`get`, `set`,
 * `del`) rather than a specific client library, so:
 *   - the ioredis dependency is imported ONLY when REDIS_URL is set (production),
 *     keeping `npm test` free of any TCP connect,
 *   - tests inject an in-memory implementation without spinning up a real server,
 *   - swapping clients later is a one-file change.
 *
 * When REDIS_URL is unset, `resolveRedisClient` returns `null` and every caller
 * degrades to the pre-#84 per-instance in-memory path. The `on('error')` handler
 * only logs — a Redis outage never brings the process down (§3.5 spirit: public
 * reads never 5xx because of an infra outage).
 */

/** Narrow contract the leader lease, snapshot store, and poll loop use. */
export interface RedisClient {
  /** Return the string at `key`, or `null` when absent. */
  get(key: string): Promise<string | null>;
  /**
   * SET `key` = `value`. Options:
   *   - `pxMs`      → PX (millisecond TTL).
   *   - `mode: "NX"`→ only set when the key does not exist (lease acquisition).
   * Returns `"OK"` on success, `null` when `NX` refused (someone else holds it).
   */
  set(
    key: string,
    value: string,
    opts?: { pxMs?: number; mode?: "NX" }
  ): Promise<"OK" | null>;
  /**
   * Compare-and-delete: DEL `key` only when its current value equals `value`.
   * Returns 1 on delete, 0 when the value differs / key absent. Used on leader
   * shutdown so an instance never deletes a lease another instance now owns.
   */
  delIfEquals(key: string, value: string): Promise<number>;
  /**
   * Compare-and-renew: PEXPIRE `key` `pxMs` only when its current value equals
   * `value`. Returns 1 on success, 0 when the value differs / key absent. This
   * is the safe renewal primitive — a lease we no longer own is not extended.
   */
  pExpireIfEquals(
    key: string,
    value: string,
    pxMs: number
  ): Promise<number>;
  /**
   * Unconditional DEL. Returns the number of keys removed (0 or 1). Used by the
   * shared-Spotify-suspension path so a leader that transitions out of a
   * suspension can positively clear the record (rather than waiting for TTL).
   */
  del(key: string): Promise<number>;
  /**
   * Atomic INCR - increments the integer counter at `key` by 1 and returns the
   * new value. If the key does not exist, it is treated as 0 and INCR sets it
   * to 1. Used by the Spotify daily-call budget guard (task #120) so multiple
   * processes / concurrent code paths never lose a count under contention.
   */
  incr(key: string): Promise<number>;
  /**
   * Set / update the PX expiry on an existing key without changing its value.
   * Returns 1 on success, 0 when the key is absent. Paired with `incr` so the
   * budget counter's TTL is renewed on every write to cover the natural
   * window rollover with slack.
   */
  pExpire(key: string, pxMs: number): Promise<number>;
  /** Close any underlying connections. Safe to call on a client already shut. */
  quit(): Promise<void>;
}

/**
 * The Lua source for `delIfEquals`. Kept as a top-level constant so the module
 * has no unused-branch warnings when tests inject a fake — the fake never sees
 * it, but the production adapter loads it at construction.
 */
const DEL_IF_EQUALS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`.trim();

/** Same shape for the compare-and-renew primitive. */
const PEXPIRE_IF_EQUALS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`.trim();

/**
 * Build the production ioredis-backed client for `url`. `ioredis` is `require`d
 * inline so the module is never loaded on the test path (which never calls this
 * function) or under IS_LOCAL when REDIS_URL is unset.
 */
function buildIoredisClient(url: string): RedisClient {
  // Lazy require keeps ioredis off the test path. `require` is used (not
  // `import`) because a top-level import would resolve the module at parse time
  // for every test file that transitively touches this module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require("ioredis") as new (url: string, opts?: unknown) => {
    get: (k: string) => Promise<string | null>;
    set: (
      k: string,
      v: string,
      ...args: unknown[]
    ) => Promise<string | null>;
    del: (k: string) => Promise<number>;
    incr: (k: string) => Promise<number>;
    pexpire: (k: string, pxMs: number) => Promise<number>;
    eval: (
      script: string,
      numKeys: number,
      ...args: unknown[]
    ) => Promise<unknown>;
    quit: () => Promise<unknown>;
    on: (event: string, cb: (...a: unknown[]) => void) => void;
    disconnect: () => void;
  };

  // maxRetriesPerRequest = null so a transient Redis outage does not reject the
  // command with a MaxRetriesPerRequestError — the caller (leader lease, snapshot
  // read) already handles rejection by degrading; retrying inside the client is
  // just extra latency on the hot public-read path.
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  // A Redis outage must never crash the process. `on('error')` is required by
  // ioredis; without a listener a socket-level error is treated as unhandled and
  // brings the node down. We log the message only — never any command args.
  client.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[redisClient] Redis error:", msg);
  });

  const wrapped: RedisClient = {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, opts) {
      const args: unknown[] = [];
      if (opts?.pxMs !== undefined) args.push("PX", opts.pxMs);
      if (opts?.mode === "NX") args.push("NX");
      const res = await client.set(key, value, ...args);
      return res === "OK" ? "OK" : null;
    },
    async delIfEquals(key, value) {
      const res = await client.eval(DEL_IF_EQUALS_SCRIPT, 1, key, value);
      return typeof res === "number" ? res : Number(res) || 0;
    },
    async pExpireIfEquals(key, value, pxMs) {
      const res = await client.eval(
        PEXPIRE_IF_EQUALS_SCRIPT,
        1,
        key,
        value,
        String(pxMs)
      );
      return typeof res === "number" ? res : Number(res) || 0;
    },
    async del(key) {
      const res = await client.del(key);
      return typeof res === "number" ? res : Number(res) || 0;
    },
    async incr(key) {
      const res = await client.incr(key);
      return typeof res === "number" ? res : Number(res) || 0;
    },
    async pExpire(key, pxMs) {
      const res = await client.pexpire(key, pxMs);
      return typeof res === "number" ? res : Number(res) || 0;
    },
    async quit() {
      try {
        await client.quit();
      } catch {
        // Force-close if quit() fails (server already gone, socket half-open, …)
        try {
          client.disconnect();
        } catch {
          // nothing else to do
        }
      }
    },
  };
  return wrapped;
}

/**
 * Resolve the process-wide Redis client from configuration. Returns `null` when
 * `REDIS_URL` is empty/unset — the whole subsystem then degrades to today's
 * per-instance in-memory caches, and no ioredis code is loaded.
 */
export function resolveRedisClient(
  redisUrl: string | null | undefined
): RedisClient | null {
  if (!redisUrl) return null;
  return buildIoredisClient(redisUrl);
}
