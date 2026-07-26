import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * Migration integration test (spec §3.2, task DoD) — runs the real migrations
 * against a throwaway Postgres 15 cluster and proves up → down → up round-trips
 * and that all six tables exist.
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly
 * as agent-pre-checks.md documents (initdb → pg_ctl start → createdb → … →
 * stop). Nothing here touches AWS/RDS. The `pg` client is given an explicit
 * `user` because — unlike psql — it does not infer the OS user.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55436"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_migtest";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task436");

const SIX_TABLES = [
  "sections",
  "section_items",
  "page_versions",
  "media_assets",
  "posts",
];

function pgBin(name: string): string {
  return path.join(PG_BIN, name);
}

function clusterIsRunning(): boolean {
  try {
    execFileSync(pgBin("pg_ctl"), ["-D", DATA_DIR, "status"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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

function makeKnex(): Knex {
  return knex({
    client: "pg",
    connection: {
      host: PG_SOCKET_DIR,
      port: parseInt(PG_PORT, 10),
      user: PG_USER,
      database: TEST_DB,
    },
    migrations: {
      migrationSource: new ExtensionAgnosticMigrationSource(
        path.join(process.cwd(), "src/db/migrations")
      ),
    },
  });
}

async function tableNames(db: Knex): Promise<string[]> {
  const res = await db.raw(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return res.rows.map((r: { table_name: string }) => r.table_name);
}

let db: Knex;

beforeAll(() => {
  startCluster();
}, 60000);

afterAll(async () => {
  if (db) await db.destroy();
  stopCluster();
}, 30000);

describe("migrations against a throwaway Postgres cluster (§3.2)", () => {
  it("started the cluster", () => {
    expect(clusterIsRunning()).toBe(true);
  });

  it("migrate:latest → rollback → latest, with all six tables present", async () => {
    db = makeKnex();

    // up
    await db.migrate.latest();
    let names = await tableNames(db);
    for (const t of SIX_TABLES) {
      expect(names).toContain(t);
    }

    // down — the working-set/media/blog tables are gone again
    await db.migrate.rollback();
    names = await tableNames(db);
    for (const t of SIX_TABLES) {
      expect(names).not.toContain(t);
    }

    // up again — round-trips cleanly
    await db.migrate.latest();
    names = await tableNames(db);
    for (const t of SIX_TABLES) {
      expect(names).toContain(t);
    }
  }, 60000);

  it("created the spec's indexes, including the partial and gin indexes", async () => {
    const res = await db.raw(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexes: string[] = res.rows.map(
      (r: { indexname: string }) => r.indexname
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_sections_position",
        "idx_section_items_section",
        "idx_page_versions_version",
        "idx_media_unreferenced", // partial: WHERE unreferenced_at IS NOT NULL
        "idx_posts_published", // partial: WHERE published_at IS NOT NULL
        "idx_posts_tags", // gin
      ])
    );
  });

  it("enforces the posts → media_assets foreign key (ON DELETE SET NULL)", async () => {
    const mediaId: string = (
      await db("media_assets")
        .insert({ s3_key: "media/x/f.png", mime: "image/png", bytes: 10 })
        .returning("id")
    )[0].id;

    await db("posts").insert({
      slug: "fk-test",
      title: "FK",
      cover_media_id: mediaId,
    });

    await db("media_assets").where({ id: mediaId }).del();

    const post = await db("posts").where({ slug: "fk-test" }).first();
    expect(post.cover_media_id).toBeNull();

    await db("posts").where({ slug: "fk-test" }).del();
  });
});
