import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * Timeline v1.17 media-strip migration integration test (task DoD) — runs the
 * real migrations against a throwaway Postgres 15 cluster and proves the
 * `20260814000000_remove_timeline_media_id` migration:
 *
 *  1. strips the `media_id` key from every `section_items.data` whose parent
 *     section is a timeline section, and
 *  2. leaves every OTHER key on those rows intact, and
 *  3. is scoped to timeline sections only — a `media_id` on a portfolio item
 *     (where the key is REQUIRED, not removed) must be left untouched, proving
 *     the join/subquery scope.
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly
 * as agent-pre-checks.md documents. Nothing here touches AWS/RDS. The `pg`
 * client is given an explicit `user` because — unlike psql — it does not infer
 * the OS user.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55445"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task81");

const STRIP_MIGRATION = "20260814000000_remove_timeline_media_id";

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
 * a later `migrate.latest()` runs the strip migration as an isolated batch.
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

describe("timeline v1.17 media-strip migration against a throwaway Postgres cluster", () => {
  it("removes media_id only from timeline section_items, preserving other keys and non-timeline rows", async () => {
    const db = freshDb("portfolio_v6_timeline_strip");

    // Migrate up to (not including) the strip migration so the pages/sections/
    // section_items tables exist and can be seeded first.
    await migrateUpToBeforeStrip(db);

    // A page is required — sections.page_id is NOT NULL after the pages migration.
    const [{ id: pageId }] = await db("pages")
      .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
      .returning("id");

    // A timeline section with two items that still carry a legacy `media_id`
    // key, plus a section-level heading on the section's own data.
    const [{ id: timelineSectionId }] = await db("sections")
      .insert({
        type: "timeline",
        position: 0,
        page_id: pageId,
        data: { heading: "Timeline" },
      })
      .returning("id");
    await db("section_items").insert([
      {
        section_id: timelineSectionId,
        position: 0,
        data: {
          date_range: "2020–2022",
          title: "Role",
          description: "did things",
          media_id: "11111111-1111-1111-1111-111111111111",
        },
      },
      {
        section_id: timelineSectionId,
        position: 1,
        data: {
          date_range: "2018–2020",
          title: "Earlier",
          description: "",
          media_id: "22222222-2222-2222-2222-222222222222",
        },
      },
    ]);

    // A portfolio section whose item carries a REQUIRED media_id. The strip is
    // scoped to timeline sections, so this row must be left untouched, proving
    // the join/subquery scope.
    const [{ id: portfolioSectionId }] = await db("sections")
      .insert({
        type: "portfolio",
        position: 1,
        page_id: pageId,
        data: {},
      })
      .returning("id");
    const PORTFOLIO_MEDIA = "33333333-3333-3333-3333-333333333333";
    await db("section_items").insert({
      section_id: portfolioSectionId,
      position: 0,
      data: {
        title: "Project",
        intro: "i",
        description: "d",
        media_id: PORTFOLIO_MEDIA,
        skill_refs: [],
        links: [],
      },
    });

    // Run the strip migration.
    await db.migrate.latest();

    // Timeline items: media_id gone, every other key preserved.
    const timelineItems = await db("section_items")
      .where({ section_id: timelineSectionId })
      .orderBy("position", "asc");
    expect(timelineItems).toHaveLength(2);
    expect(timelineItems[0].data).toEqual({
      date_range: "2020–2022",
      title: "Role",
      description: "did things",
    });
    expect(timelineItems[1].data).toEqual({
      date_range: "2018–2020",
      title: "Earlier",
      description: "",
    });
    for (const item of timelineItems) {
      expect("media_id" in item.data).toBe(false);
    }

    // The timeline section's own data (heading) is untouched — only
    // section_items are rewritten.
    const [timelineSection] = await db("sections").where({ id: timelineSectionId });
    expect(timelineSection.data).toEqual({ heading: "Timeline" });

    // Portfolio item: media_id retained (out of scope, and required by schema).
    const [portfolioItem] = await db("section_items").where({
      section_id: portfolioSectionId,
    });
    expect(portfolioItem.data.media_id).toBe(PORTFOLIO_MEDIA);
  }, 60000);
});
