import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * Pages v1.1 migration integration test (spec §3.10, task DoD) — runs the real
 * migrations against a throwaway Postgres 15 cluster and proves:
 *
 *  1. up → down → up round-trips cleanly (pages created/dropped, the sections
 *     working-set index swapping between (position) and (page_id, position)).
 *  2. the backfill adopts a pre-existing working set into a single `home` page
 *     and `page_id` is NOT NULL afterwards.
 *  3. the (page_id, position) index exists after migrating up.
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly
 * as agent-pre-checks.md documents. Nothing here touches AWS/RDS. The `pg`
 * client is given an explicit `user` because — unlike psql — it does not infer
 * the OS user. Each test gets its own database so migration batches never
 * interfere.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55443"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task469");

const PAGES_MIGRATION = "20260802000000_create_pages";

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

async function tableExists(db: Knex, table: string): Promise<boolean> {
  const res = await db.raw(
    `SELECT to_regclass(?) IS NOT NULL AS present`,
    [`public.${table}`]
  );
  return res.rows[0].present === true;
}

async function columnExists(
  db: Knex,
  table: string,
  column: string
): Promise<boolean> {
  const res = await db.raw(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return res.rows.length > 0;
}

/** The `indexdef` of a named index, or null if it does not exist. */
async function indexDef(db: Knex, name: string): Promise<string | null> {
  const res = await db.raw(
    `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ?`,
    [name]
  );
  return res.rows.length > 0 ? (res.rows[0].indexdef as string) : null;
}

const dbs: Knex[] = [];
function freshDb(name: string): Knex {
  createDb(name);
  const db = makeKnex(name);
  dbs.push(db);
  return db;
}

/**
 * Migrate every migration BEFORE the pages migration, each as its own batch, so
 * a later `migrate.latest()` runs the pages migration as an isolated batch that
 * `migrate.rollback()` can reverse on its own (a full rollback would otherwise
 * cascade into the initial migration and drop `sections` entirely).
 */
async function migrateUpToBeforePages(db: Knex): Promise<void> {
  for (;;) {
    const [, pending] = await db.migrate.list();
    const next = pending.length ? JSON.stringify(pending[0]) : "";
    if (!pending.length || next.includes(PAGES_MIGRATION)) break;
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

describe("pages v1.1 migration against a throwaway Postgres cluster (§3.10)", () => {
  it("up → down → up round-trips, swapping the sections working-set index", async () => {
    const db = freshDb("portfolio_v6_pages_roundtrip");

    // Everything before pages, as prior batches, so the pages migration below is
    // its own batch and `rollback` reverses only it (not the whole schema).
    await migrateUpToBeforePages(db);

    // up — pages exists, sections.page_id exists, index is (page_id, position).
    await db.migrate.latest();
    expect(await tableExists(db, "pages")).toBe(true);
    expect(await columnExists(db, "sections", "page_id")).toBe(true);
    let def = await indexDef(db, "idx_sections_position");
    expect(def).not.toBeNull();
    expect(def).toMatch(/page_id/);
    expect(def).toMatch(/position/);
    expect(await indexDef(db, "idx_pages_nav")).not.toBeNull();

    // down — pages gone, page_id gone, index restored to (position) only.
    await db.migrate.rollback();
    expect(await tableExists(db, "pages")).toBe(false);
    expect(await columnExists(db, "sections", "page_id")).toBe(false);
    def = await indexDef(db, "idx_sections_position");
    expect(def).not.toBeNull();
    expect(def).not.toMatch(/page_id/);
    expect(await indexDef(db, "idx_pages_nav")).toBeNull();

    // up again — round-trips cleanly.
    await db.migrate.latest();
    expect(await tableExists(db, "pages")).toBe(true);
    expect(await columnExists(db, "sections", "page_id")).toBe(true);
    def = await indexDef(db, "idx_sections_position");
    expect(def).toMatch(/page_id/);
  }, 60000);

  it("backfills a pre-existing working set into a `home` page and enforces NOT NULL", async () => {
    const db = freshDb("portfolio_v6_pages_backfill");

    // Migrate only up to (not including) the pages migration, so `sections`
    // exists but `pages` / `page_id` do not yet.
    await migrateUpToBeforePages(db);
    expect(await tableExists(db, "sections")).toBe(true);
    expect(await tableExists(db, "pages")).toBe(false);

    // A pre-existing working set: two sections whose position order must be
    // preserved by the backfill.
    await db("sections").insert([
      { type: "hero", position: 0, data: {} },
      { type: "about", position: 1, data: {} },
    ]);

    // Run the pages migration — the backfill adopts the sections.
    await db.migrate.latest();

    // A single `home` page was created with the spec's defaults.
    const pages = await db("pages").select("*");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      slug: "home",
      title: "Home",
      nav_label: "Home",
      nav_position: 0,
      is_hidden: false,
    });

    // Every pre-existing section adopted the home page, order preserved.
    const sections = await db("sections").orderBy("position", "asc");
    expect(sections).toHaveLength(2);
    for (const s of sections) {
      expect(s.page_id).toBe(pages[0].id);
    }
    expect(sections.map((s) => s.type)).toEqual(["hero", "about"]);

    // page_id is NOT NULL — an insert without one is rejected.
    await expect(
      db("sections").insert({ type: "hero", position: 2, data: {} })
    ).rejects.toThrow();

    // The FK cascades: deleting the page removes its sections.
    await db("pages").where({ id: pages[0].id }).del();
    expect(await db("sections").count<{ count: string }[]>("* as count")).toEqual(
      [{ count: "0" }]
    );
  }, 60000);

  it("indexes the pages nav column and the (page_id, position) working set", async () => {
    const db = freshDb("portfolio_v6_pages_indexes");
    await db.migrate.latest();

    const navDef = await indexDef(db, "idx_pages_nav");
    expect(navDef).toMatch(/nav_position/);

    const sectionsDef = await indexDef(db, "idx_sections_position");
    // Composite (page_id, position) in that order — `position` is quoted by pg
    // because it is a non-reserved keyword.
    expect(sectionsDef).toMatch(/\(page_id, "?position"?\)/);
  }, 60000);
});
