import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import knex, { Knex } from "knex";
import { ExtensionAgnosticMigrationSource } from "../src/db/migrationSource";
import { up as skillRefsUp } from "../src/db/migrations/20260809000000_portfolio_skill_refs";

/**
 * Skill Refs v1.8 migration integration test (task DoD) — runs the real
 * migrations against a throwaway Postgres 15 cluster and proves the
 * `20260809000000_portfolio_skill_refs` migration converts every portfolio
 * item's legacy `data.tech_icons` URL list into a `data.skill_refs` id list that
 * references the matching skills items.
 *
 * Fixture coverage (per task): jsdelivr and media-CDN URLs, a `-wordmark`
 * variant, `css3`, `csharp` (alias-mapped), an unmatchable URL (dropped),
 * duplicate URLs (deduped, first-seen order preserved), and a portfolio item
 * with no `tech_icons` (left untouched).
 *
 * The cluster is a local, unix-socket-only Postgres started under /tmp exactly
 * as agent-pre-checks.md documents. Nothing here touches AWS/RDS. The `pg`
 * client is given an explicit `user` because — unlike psql — it does not infer
 * the OS user.
 */

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55447"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task574");

const SKILL_REFS_MIGRATION = "20260809000000_portfolio_skill_refs";

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
 * Migrate every migration BEFORE the skill-refs migration, each as its own batch,
 * so a later `migrate.latest()` runs the skill-refs migration as an isolated
 * batch against seeded data.
 */
async function migrateUpToBeforeSkillRefs(db: Knex): Promise<void> {
  for (;;) {
    const [, pending] = await db.migrate.list();
    const next = pending.length ? JSON.stringify(pending[0]) : "";
    if (!pending.length || next.includes(SKILL_REFS_MIGRATION)) break;
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

describe("skill-refs v1.8 tech_icons→skill_refs migration against a throwaway Postgres cluster", () => {
  it("converts legacy tech_icons URLs into ordered, deduped skill_refs and drops unmatched", async () => {
    const db = freshDb("portfolio_v6_skill_refs");

    await migrateUpToBeforeSkillRefs(db);

    // A page is required — sections.page_id is NOT NULL after the pages migration.
    const [{ id: pageId }] = await db("pages")
      .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
      .returning("id");

    // A skills section carrying the items the portfolio URLs will resolve to.
    const [{ id: skillsSectionId }] = await db("sections")
      .insert({ type: "skills", position: 0, page_id: pageId, data: { heading: "Skills" } })
      .returning("id");

    // Insert skills with a mix of jsdelivr, media-CDN, and alias-needing icons.
    const skillInserts = [
      {
        section_id: skillsSectionId,
        position: 0,
        data: {
          title: "React",
          description: "",
          icon_source:
            "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg",
        },
      },
      {
        section_id: skillsSectionId,
        position: 1,
        data: {
          title: "Express",
          description: "",
          // media-CDN (imported + tinted) icon, not a raw jsdelivr URL.
          icon_source: "https://media-test.benkile.com/icons/express-original.svg",
        },
      },
      {
        section_id: skillsSectionId,
        position: 2,
        // Title "C#" normalizes to "c"; its icon stem is "csharp". The legacy
        // csharp URL resolves via the alias map.
        data: { title: "C#", description: "", icon_source: "csharp-original.svg" },
      },
      {
        section_id: skillsSectionId,
        position: 3,
        // Title "CSS" normalizes to "css"; legacy css3 URL resolves via alias.
        data: { title: "CSS", description: "", icon_source: "css3-original.svg" },
      },
    ];
    const skillRows = await db("section_items")
      .insert(skillInserts)
      .returning(["id", "position"]);
    const skillId = (position: number): string =>
      skillRows.find((r) => r.position === position)!.id as string;
    const reactId = skillId(0);
    const expressId = skillId(1);
    const csharpSkillId = skillId(2);
    const cssId = skillId(3);

    // A portfolio section with two items.
    const [{ id: portfolioSectionId }] = await db("sections")
      .insert({ type: "portfolio", position: 1, page_id: pageId, data: {} })
      .returning("id");

    // Item 1 carries a legacy tech_icons list exercising every fixture case.
    const [{ id: convertedItemId }] = await db("section_items")
      .insert({
        section_id: portfolioSectionId,
        position: 0,
        data: {
          title: "Converted",
          intro: "",
          description: "",
          media_id: "11111111-1111-1111-1111-111111111111",
          links: [],
          tech_icons: [
            // jsdelivr react → React
            "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg",
            // media-CDN express → Express
            "https://media-test.benkile.com/icons/express-original.svg",
            // -wordmark variant of react → React again (deduped)
            "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original-wordmark.svg",
            // css3 → CSS (alias)
            "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/css3/css3-plain.svg",
            // csharp → C# (alias)
            "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/csharp/csharp-original.svg",
            // unmatchable → dropped
            "https://example.com/icons/nonexistent-original.svg",
            // exact duplicate of the first react URL → deduped
            "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg",
          ],
        },
      })
      .returning("id");

    // Item 2 has NO tech_icons — must be left byte-for-byte untouched.
    const untouchedData = {
      title: "No icons",
      intro: "",
      description: "",
      media_id: "22222222-2222-2222-2222-222222222222",
      links: [],
    };
    const [{ id: untouchedItemId }] = await db("section_items")
      .insert({ section_id: portfolioSectionId, position: 1, data: untouchedData })
      .returning("id");

    // Run the skill-refs migration.
    await db.migrate.latest();

    // The converted item: tech_icons gone, skill_refs is the ordered, deduped id
    // list [React, Express, CSS, C#] (the -wordmark react and duplicate react are
    // deduped; the unmatchable URL is dropped).
    const [converted] = await db("section_items").where({ id: convertedItemId });
    expect("tech_icons" in converted.data).toBe(false);
    expect(converted.data.skill_refs).toEqual([reactId, expressId, cssId, csharpSkillId]);
    // Other keys are preserved.
    expect(converted.data.title).toBe("Converted");
    expect(converted.data.media_id).toBe("11111111-1111-1111-1111-111111111111");

    // The no-tech_icons item is completely untouched — no skill_refs added.
    const [untouched] = await db("section_items").where({ id: untouchedItemId });
    expect(untouched.data).toEqual(untouchedData);
    expect("skill_refs" in untouched.data).toBe(false);

    // Idempotent: invoking up() again (already-converted rows carry skill_refs,
    // not tech_icons) leaves both items exactly as they are.
    await skillRefsUp(db);
    const [convertedAgain] = await db("section_items").where({ id: convertedItemId });
    expect(convertedAgain.data.skill_refs).toEqual([reactId, expressId, cssId, csharpSkillId]);
    expect("tech_icons" in convertedAgain.data).toBe(false);
    const [untouchedAgain] = await db("section_items").where({ id: untouchedItemId });
    expect(untouchedAgain.data).toEqual(untouchedData);
  }, 60000);
});
