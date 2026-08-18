import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Knex } from "knex";

import type * as PreviewTokenService from "../src/services/previewTokenService";
import type * as DbModule from "../src/db/db";

/**
 * Preview token store — task #105. Preview tokens used to live in a per-container
 * in-memory Map: once the gateway fleet went multi-instance (2026-08-17) the
 * mint on one instance was invisible to the other, so ~50% of preview iframe
 * fetches 401ed. This suite proves the fix — a shared Postgres table (§7) — by
 * running the service against a real throwaway Postgres 15 cluster
 * (unix-socket-only, under /tmp, per agent-pre-checks.md):
 *
 *  1. mint-on-A / validate-on-B: two fully independent module loads share ONE
 *     database and validate each other's tokens (the multi-instance regression
 *     that used to break).
 *  2. RAW TOKENS ARE NEVER PERSISTED — only the sha256 hex hash.
 *  3. expired rows are cleaned up opportunistically (mint AND failed lookup),
 *     with no background timer.
 *
 * NO AWS is touched: the crypto and DB access are the only real dependencies.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55446"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_preview_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task105_store");

const CONNECTION = {
  host: PG_SOCKET_DIR,
  port: parseInt(PG_PORT, 10),
  user: PG_USER,
  password: "",
  database: TEST_DB,
  ssl: false,
};

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

/**
 * Load `previewTokenService` in an isolated module registry so its `db` import
 * is a fresh singleton — the same shape a second Node process would have.
 * `initDb` connects to the SHARED `TEST_DB` so both instances hit one Postgres.
 */
async function loadIsolatedInstance(runMigrations: boolean): Promise<{
  service: typeof PreviewTokenService;
  db: Knex;
  close: () => Promise<void>;
}> {
  let service!: typeof PreviewTokenService;
  let dbModule!: typeof DbModule;
  await jest.isolateModulesAsync(async () => {
    dbModule = await import("../src/db/db");
    service = await import("../src/services/previewTokenService");
    await dbModule.initDb(CONNECTION, { runMigrations });
  });
  return {
    service,
    db: dbModule.getDb(),
    close: () => dbModule.closeDb(),
  };
}

let instanceA: Awaited<ReturnType<typeof loadIsolatedInstance>>;
let instanceB: Awaited<ReturnType<typeof loadIsolatedInstance>>;

beforeAll(async () => {
  startCluster();
  // Instance A runs migrations; Instance B just connects to the same DB.
  instanceA = await loadIsolatedInstance(true);
  instanceB = await loadIsolatedInstance(false);
}, 60000);

afterAll(async () => {
  await instanceA?.close();
  await instanceB?.close();
  stopCluster();
}, 30000);

beforeEach(async () => {
  await instanceA.db("preview_tokens").del();
});

describe("preview_tokens migration + shared store", () => {
  it("migration created the preview_tokens table with the expected columns", async () => {
    const cols = await instanceA.db.raw(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'preview_tokens'
         ORDER BY column_name`
    );
    const names = (cols.rows as { column_name: string }[]).map((r) => r.column_name);
    expect(names.sort()).toEqual(["created_at", "expires_at", "token_hash"]);
  });

  it("MULTI-INSTANCE REGRESSION: a token minted on instance A validates on instance B", async () => {
    const { token } = await instanceA.service.mintPreviewToken();

    // The in-memory Map that used to hold this token lived on ONE instance only;
    // now the row lives in the shared DB and instance B — a different module load
    // with its own knex pool — must be able to validate the same token.
    await expect(instanceB.service.isValidPreviewToken(token)).resolves.toBe(true);

    // Symmetric: mint on B, validate on A.
    const minted = await instanceB.service.mintPreviewToken();
    await expect(instanceA.service.isValidPreviewToken(minted.token)).resolves.toBe(
      true
    );
  });

  it("stores ONLY the sha256 hash at rest — the raw token is never persisted", async () => {
    const { token } = await instanceA.service.mintPreviewToken();

    const rows = await instanceA.db("preview_tokens").select("*");
    expect(rows).toHaveLength(1);
    const [row] = rows;

    // The stored value is the sha256 hex of the raw token, and the raw token
    // does not appear anywhere in the row.
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(row.token_hash).toBe(expectedHash);
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("cleans expired rows opportunistically on mint — no background timer", async () => {
    const t0 = Date.parse("2026-08-18T00:00:00.000Z");

    // Mint a token dated to `t0` so it is provably expired by the time we mint
    // the next one 20 minutes later (TTL is 15 minutes).
    await instanceA.service.mintPreviewToken(t0);
    expect(await instanceA.db("preview_tokens").count("*").first()).toEqual({
      count: "1",
    });

    // Minting again well past the first token's expiry sweeps it away.
    await instanceA.service.mintPreviewToken(t0 + 20 * 60 * 1000);
    const surviving = await instanceA
      .db("preview_tokens")
      .select("expires_at");
    expect(surviving).toHaveLength(1);
    // The surviving row is the fresh mint, not the expired one.
    expect(new Date(surviving[0].expires_at).getTime()).toBeGreaterThan(
      t0 + 20 * 60 * 1000
    );
  });

  it("cleans an expired row on a failed lookup — no background timer", async () => {
    const t0 = Date.parse("2026-08-18T00:00:00.000Z");
    const { token } = await instanceA.service.mintPreviewToken(t0);
    expect(await instanceA.db("preview_tokens").count("*").first()).toEqual({
      count: "1",
    });

    // Validating past the expiry window returns false AND deletes the row.
    await expect(
      instanceB.service.isValidPreviewToken(token, t0 + 20 * 60 * 1000)
    ).resolves.toBe(false);
    expect(await instanceA.db("preview_tokens").count("*").first()).toEqual({
      count: "0",
    });
  });
});
