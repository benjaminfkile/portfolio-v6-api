import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";

/**
 * Skills Sphere v1.5 migration integration test (task DoD) — runs the real
 * migrations against a throwaway Postgres 15 cluster and proves the
 * `20260806000000_remove_skills_proficiency` migration:
 *
 *  1. strips the `proficiency` key from every `section_items.data` whose parent
 *     section is a skills section, and
 *  2. leaves every OTHER key on those rows intact, and
 *  3. is scoped to skills sections only — a `proficiency` key on a non-skills
 *     section's item (there is none in the product, but the scope must be
 *     provable) is left untouched.
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly
 * as agent-pre-checks.md documents. Nothing here touches AWS/RDS. The `pg`
 * client is given an explicit `user` because — unlike psql — it does not infer
 * the OS user.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55444"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task526");

const STRIP_MIGRATION = "20260806000000_remove_skills_proficiency";

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

describe("skills v1.5 proficiency-strip migration against a throwaway Postgres cluster", () => {
  it("removes proficiency only from skills section_items, preserving other keys and non-skills rows", async () => {
    const db = freshDb("portfolio_v6_skills_strip");

    // Migrate up to (not including) the strip migration so the pages/sections/
    // section_items tables exist and can be seeded first.
    await migrateUpToBeforeStrip(db);

    // A page is required — sections.page_id is NOT NULL after the pages migration.
    const [{ id: pageId }] = await db("pages")
      .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
      .returning("id");

    // A skills section with two items that still carry a legacy `proficiency`
    // key, plus a section-level sphere_detail on the section's own data.
    const [{ id: skillsSectionId }] = await db("sections")
      .insert({
        type: "skills",
        position: 0,
        page_id: pageId,
        data: { heading: "Skills", sphere_detail: 2 },
      })
      .returning("id");
    await db("section_items").insert([
      {
        section_id: skillsSectionId,
        position: 0,
        data: {
          title: "TypeScript",
          description: "strong",
          icon_source: "devicon:typescript",
          proficiency: 90,
        },
      },
      {
        section_id: skillsSectionId,
        position: 1,
        data: {
          title: "React",
          description: "",
          icon_source: "devicon:react",
          proficiency: 75,
        },
      },
    ]);

    // A non-skills (timeline) section whose item — contrived — also holds a
    // `proficiency` key. The strip is scoped to skills sections, so this row
    // must be left untouched, proving the join/subquery scope.
    const [{ id: timelineSectionId }] = await db("sections")
      .insert({
        type: "timeline",
        position: 1,
        page_id: pageId,
        data: {},
      })
      .returning("id");
    await db("section_items").insert({
      section_id: timelineSectionId,
      position: 0,
      data: {
        date_range: "2020",
        title: "Role",
        description: "did things",
        proficiency: 999,
      },
    });

    // Run the strip migration.
    await db.migrate.latest();

    // Skills items: proficiency gone, every other key preserved.
    const skillsItems = await db("section_items")
      .where({ section_id: skillsSectionId })
      .orderBy("position", "asc");
    expect(skillsItems).toHaveLength(2);
    expect(skillsItems[0].data).toEqual({
      title: "TypeScript",
      description: "strong",
      icon_source: "devicon:typescript",
    });
    expect(skillsItems[1].data).toEqual({
      title: "React",
      description: "",
      icon_source: "devicon:react",
    });
    for (const item of skillsItems) {
      expect("proficiency" in item.data).toBe(false);
    }

    // The skills section's own data (sphere_detail) is untouched — only
    // section_items are rewritten.
    const [skillsSection] = await db("sections").where({ id: skillsSectionId });
    expect(skillsSection.data).toEqual({ heading: "Skills", sphere_detail: 2 });

    // Non-skills item: proficiency retained (out of scope).
    const [timelineItem] = await db("section_items").where({
      section_id: timelineSectionId,
    });
    expect(timelineItem.data.proficiency).toBe(999);
  }, 60000);
});
