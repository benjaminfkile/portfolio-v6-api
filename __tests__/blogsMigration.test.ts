import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * Blogs v1.13 migration integration test — runs the real migrations against a
 * throwaway Postgres 15 cluster (unix-socket-only, under /tmp, per
 * agent-pre-checks.md) and proves:
 *
 *  1. up → down → up round-trips cleanly (blogs table + posts.blog_id column +
 *     idx_posts_blog created and dropped).
 *  2. the migration is ADDITIVE: a pre-existing post survives with blog_id NULL.
 *  3. the FK is ON DELETE SET NULL — deleting a blog un-assigns its posts (never
 *     deletes them).
 *
 * The `pg` client is given an explicit `user` because — unlike psql — it does not
 * infer the OS user. Each test gets its own database so migration batches never
 * interfere.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55463"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task599_mig");

const BLOGS_MIGRATION = "20260811000000_create_blogs";

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
  const res = await db.raw(`SELECT to_regclass(?) IS NOT NULL AS present`, [
    `public.${table}`,
  ]);
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
 * Migrate every migration BEFORE the blogs migration, each as its own batch, so
 * a later `migrate.latest()` runs the blogs migration as an isolated batch that
 * `migrate.rollback()` can reverse on its own.
 */
async function migrateUpToBeforeBlogs(db: Knex): Promise<void> {
  for (;;) {
    const [, pending] = await db.migrate.list();
    const next = pending.length ? JSON.stringify(pending[0]) : "";
    if (!pending.length || next.includes(BLOGS_MIGRATION)) break;
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

describe("blogs v1.13 migration against a throwaway Postgres cluster", () => {
  it("up → down → up round-trips the blogs table + posts.blog_id + index", async () => {
    const db = freshDb("portfolio_v6_blogs_roundtrip");

    await migrateUpToBeforeBlogs(db);
    // Before the blogs migration: no blogs table, no blog_id column.
    expect(await tableExists(db, "blogs")).toBe(false);
    expect(await columnExists(db, "posts", "blog_id")).toBe(false);

    // up — blogs table, posts.blog_id, and the index all exist.
    await db.migrate.latest();
    expect(await tableExists(db, "blogs")).toBe(true);
    expect(await columnExists(db, "posts", "blog_id")).toBe(true);
    expect(await indexDef(db, "idx_posts_blog")).toMatch(/blog_id/);

    // down — all three gone.
    await db.migrate.rollback();
    expect(await tableExists(db, "blogs")).toBe(false);
    expect(await columnExists(db, "posts", "blog_id")).toBe(false);
    expect(await indexDef(db, "idx_posts_blog")).toBeNull();

    // up again — round-trips cleanly.
    await db.migrate.latest();
    expect(await tableExists(db, "blogs")).toBe(true);
    expect(await columnExists(db, "posts", "blog_id")).toBe(true);
  }, 60000);

  it("is additive — a pre-existing post survives with blog_id NULL", async () => {
    const db = freshDb("portfolio_v6_blogs_additive");

    await migrateUpToBeforeBlogs(db);
    // A post that predates the blogs feature.
    await db("posts").insert({ slug: "legacy", title: "Legacy" });

    await db.migrate.latest();

    const post = await db("posts").where({ slug: "legacy" }).first();
    expect(post).toBeTruthy();
    expect(post.blog_id).toBeNull();
  }, 60000);

  it("un-assigns posts on blog delete (ON DELETE SET NULL), never deleting them", async () => {
    const db = freshDb("portfolio_v6_blogs_setnull");
    await db.migrate.latest();

    const [blog] = await db("blogs")
      .insert({ slug: "code", name: "Code" })
      .returning("id");
    const blogId = (blog as { id: string }).id;

    await db("posts").insert({ slug: "assigned", title: "Assigned", blog_id: blogId });

    // Deleting the blog nulls the FK rather than cascading the post away.
    await db("blogs").where({ id: blogId }).del();

    const post = await db("posts").where({ slug: "assigned" }).first();
    expect(post).toBeTruthy();
    expect(post.blog_id).toBeNull();
  }, 60000);
});
