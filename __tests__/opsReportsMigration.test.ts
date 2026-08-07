import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * Ops Replay v1.7 migration integration test (task DoD) — runs the real
 * migrations against a throwaway Postgres 15 cluster and proves the
 * `20260807000000_create_ops_reports` migration:
 *
 *  1. creates the `ops_reports` table (report_date PK / generated_at / payload),
 *     usable as an insert-once-per-day store, and
 *  2. strips the removed `window_hours` key from every `ops` section's JSONB
 *     `data` (the schema is `.strict()`, so a lingering `window_hours` would fail
 *     admin writes AND publish), while
 *  3. leaving every OTHER key on those rows intact, and
 *  4. being scoped to `ops` sections only — a `window_hours` key on a non-ops
 *     section's data (there is none in the product, but the scope must be
 *     provable) is left untouched.
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly as
 * agent-pre-checks.md documents. Nothing here touches AWS. The `pg` client is
 * given an explicit `user` because — unlike psql — it does not infer the OS user.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55461"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task537_mig");

const CREATE_MIGRATION = "20260807000000_create_ops_reports";

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

function createDb(name: string): void {
  execFileSync(
    pgBin("createdb"),
    ["-h", PG_SOCKET_DIR, "-p", PG_PORT, "-U", PG_USER, name],
    { stdio: "ignore" }
  );
}

function makeKnex(database: string): Knex {
  return knex({
    client: "pg",
    connection: {
      host: PG_SOCKET_DIR,
      port: parseInt(PG_PORT, 10),
      user: PG_USER,
      database,
    },
    migrations: {
      migrationSource: new ExtensionAgnosticMigrationSource(
        path.join(process.cwd(), "src/db/migrations")
      ),
    },
  });
}

const dbs: Knex[] = [];
function freshDb(name: string): Knex {
  createDb(name);
  const db = makeKnex(name);
  dbs.push(db);
  return db;
}

/**
 * Migrate every migration BEFORE the create/strip migration, each as its own
 * batch, so a later `migrate.latest()` runs it as an isolated batch.
 */
async function migrateUpToBeforeCreate(db: Knex): Promise<void> {
  for (;;) {
    const [, pending] = await db.migrate.list();
    const next = pending.length ? JSON.stringify(pending[0]) : "";
    if (!pending.length || next.includes(CREATE_MIGRATION)) break;
    await db.migrate.up();
  }
}

beforeAll(() => {
  startCluster();
}, 60000);

afterAll(async () => {
  for (const db of dbs) await db.destroy();
  stopCluster();
}, 30000);

describe("ops v1.7 migration against a throwaway Postgres cluster", () => {
  it("creates ops_reports and strips window_hours only from ops sections", async () => {
    const db = freshDb("portfolio_v6_ops_migration");

    // Migrate up to (not including) the create/strip migration so the pages /
    // sections tables exist and can be seeded first.
    await migrateUpToBeforeCreate(db);

    // ops_reports must NOT exist yet.
    const before = await db.schema.hasTable("ops_reports");
    expect(before).toBe(false);

    // A page is required — sections.page_id is NOT NULL after the pages migration.
    const [{ id: pageId }] = await db("pages")
      .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
      .returning("id");

    // Two ops sections still carrying the legacy `window_hours` key alongside the
    // header copy that must survive.
    await db("sections").insert([
      {
        type: "ops",
        position: 0,
        page_id: pageId,
        data: { heading: "System health", intro: "Replay.", window_hours: 6 },
      },
      {
        type: "ops",
        position: 1,
        page_id: pageId,
        data: { window_hours: 24 },
      },
    ]);

    // A non-ops (status) section whose data — contrived — also holds a
    // `window_hours` key. The strip is scoped to ops sections, so this row must
    // be left untouched, proving the scope.
    await db("sections").insert({
      type: "status",
      position: 2,
      page_id: pageId,
      data: { services: ["api"], window_hours: 99 },
    });

    // Run the create + strip migration.
    await db.migrate.latest();

    // The table now exists and round-trips one report per UTC day.
    expect(await db.schema.hasTable("ops_reports")).toBe(true);
    await db("ops_reports").insert({
      report_date: "2026-08-03",
      generated_at: new Date("2026-08-04T02:00:00.000Z"),
      payload: JSON.stringify({
        report_date: "2026-08-03",
        generated_at: "2026-08-04T02:00:00.000Z",
        grain_minutes: 5,
        widgets: [],
      }),
    });
    const [{ d }] = await db("ops_reports").select(
      db.raw("to_char(report_date, 'YYYY-MM-DD') AS d")
    );
    expect(d).toBe("2026-08-03");
    // report_date is the PRIMARY KEY — a second row for the same day is rejected.
    await expect(
      db("ops_reports").insert({
        report_date: "2026-08-03",
        generated_at: new Date(),
        payload: JSON.stringify({}),
      })
    ).rejects.toThrow();

    // ops sections: window_hours gone, header copy preserved.
    const opsSections = await db("sections")
      .where({ type: "ops" })
      .orderBy("position", "asc");
    expect(opsSections).toHaveLength(2);
    expect(opsSections[0].data).toEqual({
      heading: "System health",
      intro: "Replay.",
    });
    expect(opsSections[1].data).toEqual({});
    for (const s of opsSections) {
      expect("window_hours" in s.data).toBe(false);
    }

    // Non-ops section: window_hours retained (out of scope).
    const [status] = await db("sections").where({ type: "status" });
    expect(status.data.window_hours).toBe(99);
  }, 60000);
});
