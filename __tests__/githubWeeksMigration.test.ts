import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * GitHub Explorer v1.10 migration integration test (task DoD) — runs the real
 * migrations against a throwaway Postgres 15 cluster and proves the
 * `20260810000000_strip_github_weeks` data-only migration:
 *
 *  1. strips the removed `weeks` key from every `github` section's JSONB `data`
 *     (the schema is now `{ heading?, intro? }` and `.strict()`, so a lingering
 *     `weeks` would fail admin writes AND publish), while
 *  2. leaving every OTHER key on those rows intact, and
 *  3. being scoped to `github` sections only — a `weeks` key on a non-github
 *     section's data (there is none in the product, but the scope must be
 *     provable) is left untouched.
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly as
 * agent-pre-checks.md documents. Nothing here touches AWS. The `pg` client is
 * given an explicit `user` because — unlike psql — it does not infer the OS user.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55462"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task580_mig");

const STRIP_MIGRATION = "20260810000000_strip_github_weeks";

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
 * Migrate every migration BEFORE the strip migration, each as its own batch, so
 * a later `migrate.latest()` runs the strip as an isolated batch.
 */
async function migrateUpToBeforeStrip(db: Knex): Promise<void> {
  for (;;) {
    const [, pending] = await db.migrate.list();
    const next = pending.length ? JSON.stringify(pending[0]) : "";
    if (!pending.length || next.includes(STRIP_MIGRATION)) break;
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

describe("github v1.10 migration against a throwaway Postgres cluster", () => {
  it("strips weeks only from github sections, preserving other keys", async () => {
    const db = freshDb("portfolio_v6_github_migration");

    // Migrate up to (not including) the strip migration so the pages / sections
    // tables exist and can be seeded first.
    await migrateUpToBeforeStrip(db);

    // A page is required — sections.page_id is NOT NULL after the pages migration.
    const [{ id: pageId }] = await db("pages")
      .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
      .returning("id");

    // Two github sections still carrying the legacy `weeks` key alongside header
    // copy that must survive.
    await db("sections").insert([
      {
        type: "github",
        position: 0,
        page_id: pageId,
        data: { heading: "Contributions", intro: "A year.", weeks: 52 },
      },
      {
        type: "github",
        position: 1,
        page_id: pageId,
        data: { weeks: 12 },
      },
    ]);

    // A non-github (status) section whose data — contrived — also holds a `weeks`
    // key. The strip is scoped to github sections, so this row must be left
    // untouched, proving the scope.
    await db("sections").insert({
      type: "status",
      position: 2,
      page_id: pageId,
      data: { services: ["api"], weeks: 99 },
    });

    // Run the strip migration.
    await db.migrate.latest();

    // github sections: weeks gone, header copy preserved.
    const githubSections = await db("sections")
      .where({ type: "github" })
      .orderBy("position", "asc");
    expect(githubSections).toHaveLength(2);
    expect(githubSections[0].data).toEqual({
      heading: "Contributions",
      intro: "A year.",
    });
    expect(githubSections[1].data).toEqual({});
    for (const s of githubSections) {
      expect("weeks" in s.data).toBe(false);
    }

    // Non-github section: weeks retained (out of scope).
    const [status] = await db("sections").where({ type: "status" });
    expect(status.data.weeks).toBe(99);
  }, 60000);
});
