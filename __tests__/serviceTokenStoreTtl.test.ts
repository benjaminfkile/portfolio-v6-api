import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Task #121 - serviceTokenStore stale-cache landmine regression tests.
 *
 * Covers three properties introduced in this task:
 *   1) Every cache entry carries a `SERVICE_TOKEN_CACHE_TTL_MS` TTL, so a
 *      process converges on the DB truth within a minute even when the row
 *      was updated on ANOTHER instance.
 *   2) `invalidateServiceTokenCache(service)` explicitly drops a service's
 *      cached entry so the very next read hits the DB, converging on a
 *      cross-instance credential change immediately rather than up to a TTL
 *      later.
 *   3) A DB read failure is still NOT cached - a transient error must be
 *      retried on the next call, not remembered as "no stored token".
 *
 * Runs against a throwaway Postgres 15 cluster (unix-socket-only, under
 * /tmp, per agent-pre-checks.md). No network is touched.
 */

import { initDb, closeDb, getDb } from "../src/db/db";
import * as db from "../src/db/db";
import {
  SERVICE_TOKEN_CACHE_TTL_MS,
  encryptToken,
  getStoredServiceToken,
  invalidateServiceTokenCache,
  saveServiceToken,
  _resetServiceTokenStoreForTests,
} from "../src/services/serviceTokenStore";

// Any real service key exercises the shared cache identically.
const SERVICE_KEY = "github";

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55465"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_svc_token_ttl";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_svc_token_ttl");

const ENCRYPTION_KEY = "test-encryption-key";

function pgBin(name: string): string {
  return path.join(PG_BIN, name);
}

function startCluster(): void {
  if (fs.existsSync(DATA_DIR)) {
    try {
      execFileSync(pgBin("pg_ctl"), ["-D", DATA_DIR, "stop", "-m", "immediate"], {
        stdio: "ignore",
      });
    } catch {
      /* not running */
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  execFileSync(pgBin("initdb"), ["-D", DATA_DIR, "-U", PG_USER], {
    stdio: "ignore",
  });
  execFileSync(
    pgBin("pg_ctl"),
    [
      "-D",
      DATA_DIR,
      "-o",
      `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c listen_addresses=''`,
      "-w",
      "start",
    ],
    { stdio: "ignore" }
  );
  execFileSync(
    pgBin("createdb"),
    ["-h", PG_SOCKET_DIR, "-p", PG_PORT, "-U", PG_USER, TEST_DB],
    { stdio: "ignore" }
  );
}

function stopCluster(): void {
  try {
    execFileSync(pgBin("pg_ctl"), ["-D", DATA_DIR, "stop", "-m", "immediate"], {
      stdio: "ignore",
    });
  } catch {
    /* already stopped */
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

beforeAll(async () => {
  startCluster();
  await initDb(
    {
      host: PG_SOCKET_DIR,
      port: parseInt(PG_PORT, 10),
      user: PG_USER,
      password: "",
      database: TEST_DB,
      ssl: false,
    },
    { runMigrations: true }
  );
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(async () => {
  _resetServiceTokenStoreForTests();
  await getDb()("service_tokens").del();
  jest.restoreAllMocks();
});

describe("serviceTokenStore TTL (task #121)", () => {
  it("exports a 60 second cache TTL", () => {
    expect(SERVICE_TOKEN_CACHE_TTL_MS).toBe(60 * 1000);
  });

  it("expires a cache entry after the TTL so a cross-instance update converges", async () => {
    // Instance A: seed the store and prime the cache with the original token.
    await saveServiceToken(SERVICE_KEY, ENCRYPTION_KEY, "orig-token");
    const primed = await getStoredServiceToken(
      SERVICE_KEY,
      ENCRYPTION_KEY
    );
    expect(primed?.token).toBe("orig-token");

    // Instance B: rewrite the ciphertext directly (simulating the admin
    // reconnect that landed on a DIFFERENT process). No cache invalidation
    // fires on Instance A - only the row moves.
    await getDb()("service_tokens")
      .where({ service: SERVICE_KEY })
      .update({
        token_ciphertext: encryptToken(ENCRYPTION_KEY, "fresh-token"),
        updated_at: new Date(),
      });

    // Before the TTL elapses, Instance A still sees the stale value - proof
    // the cache is doing what it claims to (a hot-path read does not hit
    // the DB every time).
    const stillCached = await getStoredServiceToken(
      SERVICE_KEY,
      ENCRYPTION_KEY
    );
    expect(stillCached?.token).toBe("orig-token");

    // Fast-forward past the TTL by mocking Date.now so the entry expires;
    // the next read hits the DB and Instance A converges on the fresh
    // value without any explicit invalidation. Date.now is mocked (rather
    // than useFakeTimers) so knex / pg internals that rely on real timers
    // and setImmediate stay intact.
    const spy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + SERVICE_TOKEN_CACHE_TTL_MS + 1);
    try {
      const converged = await getStoredServiceToken(
        SERVICE_KEY,
        ENCRYPTION_KEY
      );
      expect(converged?.token).toBe("fresh-token");
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT cache a DB read failure - the next call retries", async () => {
    // Save real data first so the SUCCESS path has something to return.
    await saveServiceToken(SERVICE_KEY, ENCRYPTION_KEY, "real-token");
    _resetServiceTokenStoreForTests();

    // Fail the very first DB read; the next one goes through unmodified.
    const realGetDb = db.getDb;
    let calls = 0;
    const spy = jest.spyOn(db, "getDb").mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("simulated DB blip");
      }
      return realGetDb();
    });

    const first = await getStoredServiceToken(
      SERVICE_KEY,
      ENCRYPTION_KEY
    );
    expect(first).toBeNull();

    // No cache poisoning - the second call hits the DB again and returns
    // the real value. If the failure had been cached, this would return
    // null without another DB read.
    const second = await getStoredServiceToken(
      SERVICE_KEY,
      ENCRYPTION_KEY
    );
    expect(second?.token).toBe("real-token");
    expect(calls).toBeGreaterThanOrEqual(2);

    spy.mockRestore();
  });
});

describe("invalidateServiceTokenCache (task #121)", () => {
  it("forces a DB re-read for the named service, with zero wall-clock elapsed", async () => {
    // The wedge fix: a cross-instance credential change plus an explicit
    // invalidate must surface the fresh row immediately, not up to a TTL later.
    await saveServiceToken(SERVICE_KEY, ENCRYPTION_KEY, "one");
    const first = await getStoredServiceToken(
      SERVICE_KEY,
      ENCRYPTION_KEY
    );
    expect(first?.token).toBe("one");

    await getDb()("service_tokens")
      .where({ service: SERVICE_KEY })
      .update({
        token_ciphertext: encryptToken(ENCRYPTION_KEY, "two"),
        updated_at: new Date(),
      });

    invalidateServiceTokenCache(SERVICE_KEY);
    const afterInvalidate = await getStoredServiceToken(
      SERVICE_KEY,
      ENCRYPTION_KEY
    );
    expect(afterInvalidate?.token).toBe("two");
  });
});
