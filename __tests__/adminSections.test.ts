import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Sections & items CRUD / reorder / optimistic-concurrency integration tests —
 * TECH_SPEC_V1.md §4.2, §4.5, §3.9 (task DoD).
 *
 * These run the real router + service against a throwaway Postgres 15 cluster
 * (unix-socket-only, under /tmp, exactly as agent-pre-checks.md documents). No
 * AWS is touched: the Cognito verifier is mocked so `requireAdmin` passes with a
 * bearer token, and the DB is the local ephemeral cluster. The `pg` client is
 * given an explicit `user` because — unlike psql — it does not infer the OS user.
 */

// Mock the Cognito verifier so requireAdmin() authorizes offline (§5.3).
jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import { failure } from "../src/utils/envelope";

const mockVerify = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55438"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_sections_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task438");

const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

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

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", {
    cognito_user_pool_id: "us-east-1_testpool",
    cognito_client_id: "test-client-id",
  });
  app.use("/api/admin", adminSectionsRouter);
  // Same JSON error handler contract as app.ts (§4.4).
  app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(500).json(failure(err.message));
  });
  return app;
}

let app: Express;

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
  app = buildApp();
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

let homePageId: string;

beforeEach(async () => {
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
  // Clean slate between tests — cascade clears section_items via the FK.
  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("pages").del();
  // v1.1 (§3.10): every section belongs to a page. Seed one `home` page the
  // helpers default to, so the section-focused assertions read unchanged.
  homePageId = await createPage("home", "Home");
});

/** Insert a page row directly and return its id (bypasses the pages router). */
async function createPage(slug: string, title: string): Promise<string> {
  const [row] = await getDb()("pages")
    .insert({ slug, title, nav_label: title, nav_position: 0 })
    .returning("id");
  return row.id as string;
}

// Convenience creators returning the created row. Defaults to the seeded `home`
// page unless the caller supplies a page_id (§4.2 v1.1: page_id is required).
async function createSection(body: Record<string, unknown>) {
  const page_id = body.page_id ?? homePageId;
  const res = await request(app)
    .post("/api/admin/sections")
    .set(...AUTH)
    .send({ ...body, page_id });
  return res;
}

describe("auth guard (§4.2)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/admin/sections");
    expect(res.status).toBe(401);
  });
});

describe("CRUD round-trips (§4.2)", () => {
  it("creates, reads (nested working set), patches, and deletes a section", async () => {
    // Create
    const created = await createSection({
      type: "hero",
      data: { title: "Ben Kile", tagline: "builder" },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("ok");
    const section = created.body.data;
    expect(section.type).toBe("hero");
    expect(section.position).toBe(0);
    expect(section.is_hidden).toBe(false);
    expect(section.data).toEqual({ title: "Ben Kile", tagline: "builder" });

    // Read working set — one section, items nested (empty for hero)
    const ws = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws.status).toBe(200);
    expect(ws.body.data.sections).toHaveLength(1);
    expect(ws.body.data.sections[0].id).toBe(section.id);
    expect(ws.body.data.sections[0].items).toEqual([]);

    // Patch data with the correct precondition → new updated_at returned
    const patch = await request(app)
      .patch(`/api/admin/sections/${section.id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: section.updated_at,
        data: { title: "Ben", tagline: "engineer" },
        is_hidden: true,
      });
    expect(patch.status).toBe(200);
    expect(patch.body.data.data).toEqual({ title: "Ben", tagline: "engineer" });
    expect(patch.body.data.is_hidden).toBe(true);
    expect(new Date(patch.body.data.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(section.updated_at).getTime()
    );

    // Delete
    const del = await request(app)
      .delete(`/api/admin/sections/${section.id}`)
      .set(...AUTH);
    expect(del.status).toBe(200);
    const after = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(after.body.data.sections).toHaveLength(0);
  });

  it("creates, patches, and deletes an item under an item-bearing section", async () => {
    const section = (await createSection({ type: "timeline", data: {} })).body.data;

    const created = await request(app)
      .post(`/api/admin/sections/${section.id}/items`)
      .set(...AUTH)
      .send({
        data: { date_range: "2020–2021", title: "Role", description: "did things" },
      });
    expect(created.status).toBe(201);
    const item = created.body.data;
    expect(item.section_id).toBe(section.id);
    expect(item.position).toBe(0);

    // Nested under the section in the working set
    const ws = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws.body.data.sections[0].items).toHaveLength(1);
    expect(ws.body.data.sections[0].items[0].id).toBe(item.id);

    // Patch item
    const patch = await request(app)
      .patch(`/api/admin/items/${item.id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: item.updated_at,
        data: { date_range: "2020–2022", title: "Role", description: "did more" },
      });
    expect(patch.status).toBe(200);
    expect(patch.body.data.data.date_range).toBe("2020–2022");

    // Delete item
    const del = await request(app)
      .delete(`/api/admin/items/${item.id}`)
      .set(...AUTH);
    expect(del.status).toBe(200);
    const ws2 = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws2.body.data.sections[0].items).toHaveLength(0);
  });
});

describe("optimistic concurrency (§4.5)", () => {
  it("409s on a stale expected_updated_at and performs no write", async () => {
    const section = (
      await createSection({ type: "about", data: { body: "v1" } })
    ).body.data;

    const stale = new Date(
      new Date(section.updated_at).getTime() - 60000
    ).toISOString();

    const res = await request(app)
      .patch(`/api/admin/sections/${section.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: stale, data: { body: "v2" } });
    expect(res.status).toBe(409);

    // No write happened — data is still v1.
    const ws = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws.body.data.sections[0].data).toEqual({ body: "v1" });
  });

  it("rejects a PATCH with a missing expected_updated_at (400)", async () => {
    const section = (
      await createSection({ type: "about", data: { body: "v1" } })
    ).body.data;

    const res = await request(app)
      .patch(`/api/admin/sections/${section.id}`)
      .set(...AUTH)
      .send({ data: { body: "v2" } });
    expect(res.status).toBe(400);

    const ws = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws.body.data.sections[0].data).toEqual({ body: "v1" });
  });

  it("also enforces the precondition on item PATCH", async () => {
    const section = (await createSection({ type: "skills", data: {} })).body.data;
    const item = (
      await request(app)
        .post(`/api/admin/sections/${section.id}/items`)
        .set(...AUTH)
        .send({
          data: { title: "TS", description: "typed", icon_source: "x" },
        })
    ).body.data;

    // Missing → 400
    const missing = await request(app)
      .patch(`/api/admin/items/${item.id}`)
      .set(...AUTH)
      .send({ data: { title: "TS", description: "typed", icon_source: "x" } });
    expect(missing.status).toBe(400);

    // Stale → 409
    const stale = new Date(
      new Date(item.updated_at).getTime() - 60000
    ).toISOString();
    const conflict = await request(app)
      .patch(`/api/admin/items/${item.id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: stale,
        data: { title: "TS", description: "typed", icon_source: "x" },
      });
    expect(conflict.status).toBe(409);
  });
});

describe("reorder — full array, transactional, idempotent (§4.2 / §4.5)", () => {
  it("reorders sections by a full id array and is idempotent", async () => {
    const a = (await createSection({ type: "hero", data: { title: "A" } })).body.data;
    const b = (await createSection({ type: "about", data: { body: "B" } })).body.data;
    const c = (await createSection({ type: "contact", data: {} })).body.data;
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);

    const ids = [c.id, a.id, b.id];
    const first = await request(app)
      .put("/api/admin/sections/order")
      .set(...AUTH)
      .send({ page_id: homePageId, ids });
    expect(first.status).toBe(200);
    expect(first.body.data.map((s: { id: string }) => s.id)).toEqual(ids);

    // Idempotent — same array again yields the same order.
    const second = await request(app)
      .put("/api/admin/sections/order")
      .set(...AUTH)
      .send({ page_id: homePageId, ids });
    expect(second.status).toBe(200);
    expect(second.body.data.map((s: { id: string }) => s.id)).toEqual(ids);

    // The working set reflects positions 0,1,2 in the new order.
    const ws = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws.body.data.sections.map((s: { id: string }) => s.id)).toEqual(ids);
    expect(ws.body.data.sections.map((s: { position: number }) => s.position)).toEqual([0, 1, 2]);
  });

  it("rejects a reorder array that is not the exact current id set (400, no partial write)", async () => {
    const a = (await createSection({ type: "hero", data: { title: "A" } })).body.data;
    const b = (await createSection({ type: "about", data: { body: "B" } })).body.data;

    // Missing one id → rejected, positions untouched.
    const res = await request(app)
      .put("/api/admin/sections/order")
      .set(...AUTH)
      .send({ page_id: homePageId, ids: [b.id] });
    expect(res.status).toBe(400);

    const ws = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(ws.body.data.sections.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);
  });

  it("reorders items within a section", async () => {
    const section = (await createSection({ type: "skills", data: {} })).body.data;
    const mk = (title: string) =>
      request(app)
        .post(`/api/admin/sections/${section.id}/items`)
        .set(...AUTH)
        .send({
          data: { title, description: "d", icon_source: "i" },
        });
    const i1 = (await mk("one")).body.data;
    const i2 = (await mk("two")).body.data;
    const i3 = (await mk("three")).body.data;

    const order = [i3.id, i1.id, i2.id];
    const res = await request(app)
      .put(`/api/admin/sections/${section.id}/items/order`)
      .set(...AUTH)
      .send({ order });
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { id: string }) => i.id)).toEqual(order);
  });
});

describe("cascade delete (§3.2)", () => {
  it("deleting a section removes its items", async () => {
    const section = (await createSection({ type: "portfolio", data: {} })).body.data;
    await request(app)
      .post(`/api/admin/sections/${section.id}/items`)
      .set(...AUTH)
      .send({
        data: {
          title: "P",
          intro: "i",
          description: "d",
          media_id: "11111111-1111-1111-1111-111111111111",
          skill_refs: [],
          links: [],
        },
      });

    // Sanity: one item row exists.
    const before = await getDb()("section_items").where({ section_id: section.id });
    expect(before).toHaveLength(1);

    const del = await request(app)
      .delete(`/api/admin/sections/${section.id}`)
      .set(...AUTH);
    expect(del.status).toBe(200);

    // The FK ON DELETE CASCADE removed the child rows.
    const after = await getDb()("section_items").where({ section_id: section.id });
    expect(after).toHaveLength(0);
  });
});

describe("Zod validation on writes (§3.9)", () => {
  it("accepts an INCOMPLETE draft (missing required fields) — drafts are lenient (§3.9)", async () => {
    // hero's canonical schema requires `title`, but draft writes only require
    // provided fields to be well-typed; completeness is enforced at publish.
    const res = await createSection({ type: "hero", data: { tagline: "no title yet" } });
    expect(res.status).toBe(201);

    const empty = await createSection({ type: "hero", data: {} });
    expect(empty.status).toBe(201);

    // The admin create flow sends empty strings for untouched text fields —
    // draft validation strips them rather than failing min-length (§3.9).
    const emptyStrings = await createSection({
      type: "hero",
      data: { title: "", tagline: "" },
    });
    expect(emptyStrings.status).toBe(201);
  });

  it("rejects a WRONG-TYPED field with a 400 envelope even on a draft (§3.9)", async () => {
    const res = await createSection({ type: "hero", data: { title: 123 } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: "error", error: true });
    expect(typeof res.body.errorMsg).toBe("string");
  });

  it("rejects an unknown data key with a 400 (schemas stay strict on drafts)", async () => {
    const res = await createSection({ type: "hero", data: { totally_unknown: "x" } });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown section type with a 400", async () => {
    const res = await createSection({ type: "not_a_real_type", data: {} });
    expect(res.status).toBe(400);
  });

  it("carries a compact, human-readable path:message in the 400 envelope (§Icons v1.6)", async () => {
    // sphere_detail is capped at 4 (§3.4 v1.5). A 400 must read like a human
    // sentence, not the raw serialized Zod issue array.
    const res = await createSection({
      type: "skills",
      data: { sphere_detail: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.errorMsg).toContain(
      'Invalid data for section type "skills": sphere_detail: '
    );
    // Not the raw JSON issue dump.
    expect(res.body.errorMsg).not.toContain('"code"');
    expect(res.body.errorMsg).not.toContain("[\n");
  });

  it("renders a compact path:message for a bad ITEM too (§Icons v1.6)", async () => {
    const section = (await createSection({ type: "skills", data: {} })).body.data;
    const res = await request(app)
      .post(`/api/admin/sections/${section.id}/items`)
      .set(...AUTH)
      // icon_source must be a string; a number fails with a readable message.
      .send({ data: { title: "x", icon_source: 123 } });
    expect(res.status).toBe(400);
    expect(res.body.errorMsg).toContain(
      "Invalid data for skills item: icon_source: "
    );
    expect(res.body.errorMsg).not.toContain('"code"');
  });

  it("rejects invalid item data with a 400", async () => {
    const section = (await createSection({ type: "skills", data: {} })).body.data;
    const res = await request(app)
      .post(`/api/admin/sections/${section.id}/items`)
      .set(...AUTH)
      // proficiency was removed in v1.5 — a strict schema rejects the leftover key.
      .send({ data: { title: "x", description: "d", icon_source: "i", proficiency: 500 } });
    expect(res.status).toBe(400);
  });

  it("rejects items on a section type that does not bear items (400)", async () => {
    const section = (await createSection({ type: "about", data: { body: "x" } })).body.data;
    const res = await request(app)
      .post(`/api/admin/sections/${section.id}/items`)
      .set(...AUTH)
      .send({ data: { anything: true } });
    expect(res.status).toBe(400);
  });

  it("rejects a data-invalid PATCH even with a correct precondition (400)", async () => {
    const section = (
      await createSection({ type: "status", data: { services: ["gateway"] } })
    ).body.data;
    const res = await request(app)
      .patch(`/api/admin/sections/${section.id}`)
      .set(...AUTH)
      // `services` must be an array of strings.
      .send({ expected_updated_at: section.updated_at, data: { services: "gateway" } });
    expect(res.status).toBe(400);
  });

  it("accepts a contact section PATCH with mailto: and tel: links (§3.4)", async () => {
    const section = (await createSection({ type: "contact", data: {} })).body.data;
    const links = [
      { type: "other", label: "Email", url: "mailto:someone@example.com" },
      { type: "other", label: "Phone", url: "tel:+14065551234" },
    ];
    const res = await request(app)
      .patch(`/api/admin/sections/${section.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: section.updated_at, data: { links } });
    expect(res.status).toBe(200);
    expect(res.body.data.data.links).toEqual(links);

    // Confirm persistence via a follow-up read of the working set.
    const ws = await request(app)
      .get(`/api/admin/sections?page_id=${homePageId}`)
      .set(...AUTH);
    const persisted = ws.body.data.sections.find(
      (s: { id: string }) => s.id === section.id
    );
    expect(persisted.data.links).toEqual(links);
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,x"],
    ["file:///etc/passwd"],
  ])(
    "rejects a contact link whose url uses the still-forbidden protocol %s",
    async (url) => {
      const section = (await createSection({ type: "contact", data: {} })).body.data;
      const res = await request(app)
        .patch(`/api/admin/sections/${section.id}`)
        .set(...AUTH)
        .send({
          expected_updated_at: section.updated_at,
          data: { links: [{ type: "other", label: "x", url }] },
        });
      expect(res.status).toBe(400);
    }
  );
});

// ---- v1.1 page scope (§3.10, §4.2 v1.1) -------------------------------------

describe("page scope — create requires page_id (§4.2 v1.1)", () => {
  it("400s a create with no page_id", async () => {
    const res = await request(app)
      .post("/api/admin/sections")
      .set(...AUTH)
      .send({ type: "hero", data: { title: "x" } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: "error", error: true });
  });

  it("400s a create whose page_id references no page", async () => {
    const ghost = "99999999-9999-9999-9999-999999999999";
    const res = await request(app)
      .post("/api/admin/sections")
      .set(...AUTH)
      .send({ type: "hero", data: { title: "x" }, page_id: ghost });
    expect(res.status).toBe(400);
  });

  it("carries page_id on created sections and honours the ?page_id= filter", async () => {
    const other = await createPage("projects", "Projects");
    const home1 = (await createSection({ type: "hero", data: { title: "H" } })).body.data;
    const home2 = (await createSection({ type: "about", data: { body: "b" } })).body.data;
    const proj = (
      await createSection({ type: "contact", data: {}, page_id: other })
    ).body.data;

    expect(home1.page_id).toBe(homePageId);
    expect(proj.page_id).toBe(other);
    // Positions are per-page: `projects` starts its own 0.
    expect(proj.position).toBe(0);

    const all = await request(app).get("/api/admin/sections").set(...AUTH);
    expect(all.body.data.sections).toHaveLength(3);

    const onlyHome = await request(app)
      .get(`/api/admin/sections?page_id=${homePageId}`)
      .set(...AUTH);
    expect(onlyHome.body.data.sections.map((s: { id: string }) => s.id).sort()).toEqual(
      [home1.id, home2.id].sort()
    );

    const onlyProj = await request(app)
      .get(`/api/admin/sections?page_id=${other}`)
      .set(...AUTH);
    expect(onlyProj.body.data.sections.map((s: { id: string }) => s.id)).toEqual([proj.id]);
  });
});

describe("page scope — move a section between pages (§4.2 v1.1)", () => {
  it("appends at the target page's end and closes the gap in the source page", async () => {
    const other = await createPage("projects", "Projects");
    const a = (await createSection({ type: "hero", data: { title: "A" } })).body.data;
    const b = (await createSection({ type: "about", data: { body: "B" } })).body.data;
    const c = (await createSection({ type: "contact", data: {} })).body.data;
    const t = (
      await createSection({ type: "hero", data: { title: "T" }, page_id: other })
    ).body.data;
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);

    // Move the MIDDLE home section (b) to the projects page.
    const moved = await request(app)
      .patch(`/api/admin/sections/${b.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: b.updated_at, page_id: other });
    expect(moved.status).toBe(200);
    expect(moved.body.data.page_id).toBe(other);
    // Appended after the existing projects section (position 0) → position 1.
    expect(moved.body.data.position).toBe(1);

    // Source page's gap is closed: a→0, c→1 (contiguous, order preserved).
    const home = await request(app)
      .get(`/api/admin/sections?page_id=${homePageId}`)
      .set(...AUTH);
    expect(home.body.data.sections.map((s: { id: string }) => s.id)).toEqual([a.id, c.id]);
    expect(home.body.data.sections.map((s: { position: number }) => s.position)).toEqual([0, 1]);

    // Target page now has both, ordered.
    const proj = await request(app)
      .get(`/api/admin/sections?page_id=${other}`)
      .set(...AUTH);
    expect(proj.body.data.sections.map((s: { id: string }) => s.id)).toEqual([t.id, b.id]);
  });

  it("400s a move to a nonexistent page and writes nothing", async () => {
    const a = (await createSection({ type: "hero", data: { title: "A" } })).body.data;
    const ghost = "99999999-9999-9999-9999-999999999999";
    const res = await request(app)
      .patch(`/api/admin/sections/${a.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: a.updated_at, page_id: ghost });
    expect(res.status).toBe(400);

    const ws = await request(app)
      .get(`/api/admin/sections?page_id=${homePageId}`)
      .set(...AUTH);
    expect(ws.body.data.sections[0].page_id).toBe(homePageId);
  });
});

describe("page scope — per-page reorder (§4.2 v1.1)", () => {
  it("reorders only the named page's sections", async () => {
    const other = await createPage("projects", "Projects");
    const a = (await createSection({ type: "hero", data: { title: "A" } })).body.data;
    const b = (await createSection({ type: "about", data: { body: "B" } })).body.data;
    const p1 = (
      await createSection({ type: "hero", data: { title: "P1" }, page_id: other })
    ).body.data;
    const p2 = (
      await createSection({ type: "about", data: { body: "P2" }, page_id: other })
    ).body.data;

    const res = await request(app)
      .put("/api/admin/sections/order")
      .set(...AUTH)
      .send({ page_id: other, ids: [p2.id, p1.id] });
    expect(res.status).toBe(200);
    // Response covers only the reordered page.
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([p2.id, p1.id]);

    // The home page's order is untouched.
    const home = await request(app)
      .get(`/api/admin/sections?page_id=${homePageId}`)
      .set(...AUTH);
    expect(home.body.data.sections.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);
  });

  it("400s when the ids do not exactly cover that page's sections", async () => {
    const other = await createPage("projects", "Projects");
    const a = (await createSection({ type: "hero", data: { title: "A" } })).body.data;
    const p1 = (
      await createSection({ type: "hero", data: { title: "P1" }, page_id: other })
    ).body.data;

    // Passing a home-page id under the projects page → not that page's set.
    const res = await request(app)
      .put("/api/admin/sections/order")
      .set(...AUTH)
      .send({ page_id: other, ids: [p1.id, a.id] });
    expect(res.status).toBe(400);

    // 400 without a page_id at all.
    const noPage = await request(app)
      .put("/api/admin/sections/order")
      .set(...AUTH)
      .send({ ids: [p1.id] });
    expect(noPage.status).toBe(400);
  });
});
