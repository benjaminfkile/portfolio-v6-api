import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Pages CRUD / reorder / optimistic-concurrency integration tests —
 * TECH_SPEC_V1.md §3.10, §4.2 (v1.1 pages rows), §4.5 (task DoD).
 *
 * Runs the real router + service against a throwaway Postgres 15 cluster
 * (unix-socket-only, under /tmp, exactly as agent-pre-checks.md documents). No
 * AWS is touched: the Cognito verifier is mocked so `requireAdmin` passes, and
 * the DB is the local ephemeral cluster. The `pg` client is given an explicit
 * `user` because — unlike psql — it does not infer the OS user.
 */

// Mock the Cognito verifier so requireAdmin() authorizes offline (§5.3).
jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminPagesRouter from "../src/routers/adminPagesRouter";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import { RESERVED_PAGE_SLUGS } from "../src/schemas/pages";
import { failure } from "../src/utils/envelope";

const mockVerify = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55445"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_pages_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task470");

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
  app.use("/api/admin", adminPagesRouter);
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

beforeEach(async () => {
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
  // Clean slate — deleting pages cascades away any sections/items.
  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("pages").del();
});

// ---- helpers ---------------------------------------------------------------

async function createPage(body: Record<string, unknown>) {
  return request(app).post("/api/admin/pages").set(...AUTH).send(body);
}

// ---- auth (§4.2 / §5.3) -----------------------------------------------------

describe("auth guard (§4.2)", () => {
  it("401s an unauthenticated request (no bearer)", async () => {
    const res = await request(app).get("/api/admin/pages");
    expect(res.status).toBe(401);
  });

  it("403s a valid token that is not in the admins group", async () => {
    mockVerify.mockResolvedValue({ sub: "x", "cognito:groups": ["users"] });
    const res = await request(app).get("/api/admin/pages").set(...AUTH);
    expect(res.status).toBe(403);
  });
});

// ---- CRUD happy paths (§4.2) ------------------------------------------------

describe("CRUD round-trips (§4.2)", () => {
  it("creates, lists (nav order), patches, and deletes a page", async () => {
    const created = await createPage({
      slug: "home",
      title: "Ben Kile",
      nav_label: "Home",
      nav_position: 0,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("ok");
    const page = created.body.data;
    expect(page.slug).toBe("home");
    expect(page.title).toBe("Ben Kile");
    expect(page.nav_label).toBe("Home");
    expect(page.nav_position).toBe(0);
    expect(page.is_hidden).toBe(false);

    // A second page appears after in nav order.
    await createPage({ slug: "projects", title: "Projects", nav_label: "Projects", nav_position: 1 });

    const list = await request(app).get("/api/admin/pages").set(...AUTH);
    expect(list.status).toBe(200);
    expect(list.body.data.pages.map((p: { slug: string }) => p.slug)).toEqual([
      "home",
      "projects",
    ]);

    // Patch with the correct precondition → new updated_at.
    const patch = await request(app)
      .patch(`/api/admin/pages/${page.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: page.updated_at, title: "BK", is_hidden: true, nav_label: null });
    expect(patch.status).toBe(200);
    expect(patch.body.data.title).toBe("BK");
    expect(patch.body.data.is_hidden).toBe(true);
    expect(patch.body.data.nav_label).toBeNull();
    expect(new Date(patch.body.data.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(page.updated_at).getTime()
    );

    // Delete.
    const del = await request(app).delete(`/api/admin/pages/${page.id}`).set(...AUTH);
    expect(del.status).toBe(200);
    const after = await request(app).get("/api/admin/pages").set(...AUTH);
    expect(after.body.data.pages.map((p: { slug: string }) => p.slug)).toEqual(["projects"]);
  });

  it("defaults nav_label to null and appends nav_position when omitted", async () => {
    const a = (await createPage({ slug: "home", title: "Home" })).body.data;
    const b = (await createPage({ slug: "extra", title: "Extra" })).body.data;
    expect(a.nav_label).toBeNull();
    expect(a.nav_position).toBe(0);
    // Appended after the max existing nav_position.
    expect(b.nav_position).toBe(1);
  });

  it("404s a PATCH/DELETE for an unknown id", async () => {
    const ghost = "99999999-9999-9999-9999-999999999999";
    const patch = await request(app)
      .patch(`/api/admin/pages/${ghost}`)
      .set(...AUTH)
      .send({ expected_updated_at: new Date().toISOString(), title: "x" });
    expect(patch.status).toBe(404);

    const del = await request(app).delete(`/api/admin/pages/${ghost}`).set(...AUTH);
    expect(del.status).toBe(404);
  });
});

// ---- slug validation (§3.10) ------------------------------------------------

describe("slug validation (§3.10)", () => {
  it("rejects a non-[a-z0-9-] slug (400)", async () => {
    for (const bad of ["Home", "with space", "under_score", "café", ""]) {
      const res = await createPage({ slug: bad, title: "T" });
      expect(res.status).toBe(400);
    }
  });

  it("rejects EVERY reserved slug (400)", async () => {
    expect(RESERVED_PAGE_SLUGS).toEqual(["blog", "api", "admin"]);
    for (const slug of RESERVED_PAGE_SLUGS) {
      const res = await createPage({ slug, title: "T" });
      expect(res.status).toBe(400);
    }
  });

  it("accepts `home` — it is NOT reserved (renders at /)", async () => {
    const res = await createPage({ slug: "home", title: "Home" });
    expect(res.status).toBe(201);
  });

  it("rejects a duplicate slug with a 400 validation failure", async () => {
    const first = await createPage({ slug: "projects", title: "Projects" });
    expect(first.status).toBe(201);
    const dup = await createPage({ slug: "projects", title: "Again" });
    expect(dup.status).toBe(400);
    expect(dup.body).toMatchObject({ status: "error", error: true });
    expect(typeof dup.body.errorMsg).toBe("string");
  });

  it("rejects renaming a page onto another page's slug (400)", async () => {
    await createPage({ slug: "home", title: "Home" });
    const projects = (await createPage({ slug: "projects", title: "Projects" })).body.data;
    const res = await request(app)
      .patch(`/api/admin/pages/${projects.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: projects.updated_at, slug: "home" });
    expect(res.status).toBe(400);
  });

  it("requires slug and title on create (400)", async () => {
    expect((await createPage({ title: "no slug" })).status).toBe(400);
    expect((await createPage({ slug: "no-title" })).status).toBe(400);
  });
});

// ---- optimistic concurrency (§4.5) ------------------------------------------

describe("optimistic concurrency (§4.5)", () => {
  it("409s on a stale expected_updated_at and performs no write", async () => {
    const page = (await createPage({ slug: "home", title: "Home" })).body.data;
    const stale = new Date(new Date(page.updated_at).getTime() - 60000).toISOString();

    const res = await request(app)
      .patch(`/api/admin/pages/${page.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: stale, title: "Changed" });
    expect(res.status).toBe(409);

    const list = await request(app).get("/api/admin/pages").set(...AUTH);
    expect(list.body.data.pages[0].title).toBe("Home");
  });

  it("400s a PATCH missing expected_updated_at (unconditional overwrite is unexpressible)", async () => {
    const page = (await createPage({ slug: "home", title: "Home" })).body.data;
    const res = await request(app)
      .patch(`/api/admin/pages/${page.id}`)
      .set(...AUTH)
      .send({ title: "Changed" });
    expect(res.status).toBe(400);

    const list = await request(app).get("/api/admin/pages").set(...AUTH);
    expect(list.body.data.pages[0].title).toBe("Home");
  });
});

// ---- reorder (§4.2 / §4.5 exemption) ----------------------------------------

describe("nav reorder — full array, idempotent, no precondition (§4.2)", () => {
  it("reorders pages by a full id array and is idempotent", async () => {
    const a = (await createPage({ slug: "home", title: "Home", nav_position: 0 })).body.data;
    const b = (await createPage({ slug: "projects", title: "Projects", nav_position: 1 })).body.data;
    const c = (await createPage({ slug: "about", title: "About", nav_position: 2 })).body.data;

    const ids = [c.id, a.id, b.id];
    const first = await request(app)
      .put("/api/admin/pages/order")
      .set(...AUTH)
      .send({ ids });
    expect(first.status).toBe(200);
    expect(first.body.data.map((p: { id: string }) => p.id)).toEqual(ids);
    expect(first.body.data.map((p: { nav_position: number }) => p.nav_position)).toEqual([0, 1, 2]);

    // Idempotent.
    const second = await request(app)
      .put("/api/admin/pages/order")
      .set(...AUTH)
      .send({ ids });
    expect(second.body.data.map((p: { id: string }) => p.id)).toEqual(ids);
  });

  it("400s a reorder that is not the exact current id set", async () => {
    const a = (await createPage({ slug: "home", title: "Home" })).body.data;
    await createPage({ slug: "projects", title: "Projects" });

    const res = await request(app)
      .put("/api/admin/pages/order")
      .set(...AUTH)
      .send({ ids: [a.id] });
    expect(res.status).toBe(400);
  });
});

// ---- cascade delete (§3.10) -------------------------------------------------

describe("cascade delete (§3.10)", () => {
  it("deleting a page removes its sections and their items", async () => {
    const page = (await createPage({ slug: "home", title: "Home" })).body.data;

    const section = (
      await request(app)
        .post("/api/admin/sections")
        .set(...AUTH)
        .send({ type: "portfolio", data: {}, page_id: page.id })
    ).body.data;
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

    // Sanity: the section + item exist.
    expect(await getDb()("sections").where({ page_id: page.id })).toHaveLength(1);
    expect(await getDb()("section_items").where({ section_id: section.id })).toHaveLength(1);

    const del = await request(app).delete(`/api/admin/pages/${page.id}`).set(...AUTH);
    expect(del.status).toBe(200);

    // FK ON DELETE CASCADE removed sections; section_items cascade transitively.
    expect(await getDb()("sections").where({ page_id: page.id })).toHaveLength(0);
    expect(await getDb()("section_items").where({ section_id: section.id })).toHaveLength(0);
  });
});
