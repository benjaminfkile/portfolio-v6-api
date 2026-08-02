import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Publish pipeline integration tests — TECH_SPEC_V1.md §3.3, §4.1, §4.2, §6.8
 * (task #439 DoD). Exercises the real routers + services against a throwaway
 * Postgres 15 cluster (unix-socket-only, under /tmp, per agent-pre-checks.md).
 *
 * No AWS is touched: the Cognito verifier is mocked so `requireAdmin` passes with
 * a bearer token, and CDN resolution is exercised through the configured
 * `cdn_domain` secret (no S3/CloudFront call is made). The `pg` client is given
 * an explicit `user` because — unlike psql — it does not infer the OS user.
 *
 * Covered: publish → content → 304 flow, empty-state 200, validation refusal,
 * restore rebuilds the working set, and prune-at-50 behavior.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import adminPagesRouter from "../src/routers/adminPagesRouter";
import adminPublishRouter from "../src/routers/adminPublishRouter";
import contentRouter from "../src/routers/contentRouter";
import { failure } from "../src/utils/envelope";

const mockVerify = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55439"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_publish_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task439");
const CDN_DOMAIN = "media-test.benkile.com";

const ADMIN_PAYLOAD = { sub: "admin-sub-439", "cognito:groups": ["admins"] };
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
    cdn_domain: CDN_DOMAIN,
  });
  app.use("/api/content", contentRouter);
  app.use("/api/admin", adminSectionsRouter);
  app.use("/api/admin", adminPagesRouter);
  app.use("/api/admin", adminPublishRouter);
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
  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("page_versions").del();
  await getDb()("media_assets").del();
  await getDb()("pages").del();
});

// ---- helpers ---------------------------------------------------------------

/**
 * v1.1 (§3.10) requires every section to belong to a page. Ensure the single
 * implicit `home` page exists and return its id, so these publish-flow tests can
 * keep creating sections without threading a page through every call.
 */
async function ensureHomePage(): Promise<string> {
  const existing = await getDb()("pages").where({ slug: "home" }).first();
  if (existing) return existing.id as string;
  const [row] = await getDb()("pages")
    .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
    .returning("id");
  return row.id as string;
}

async function createSection(body: Record<string, unknown>) {
  const page_id = body.page_id ?? (await ensureHomePage());
  return request(app)
    .post("/api/admin/sections")
    .set(...AUTH)
    .send({ ...body, page_id });
}

async function createPage(body: Record<string, unknown>) {
  return request(app)
    .post("/api/admin/pages")
    .set(...AUTH)
    .send(body);
}

async function createItem(sectionId: string, data: Record<string, unknown>) {
  return request(app)
    .post(`/api/admin/sections/${sectionId}/items`)
    .set(...AUTH)
    .send({ data });
}

async function insertMedia(id: string, s3Key: string) {
  await getDb()("media_assets").insert({
    id,
    s3_key: s3Key,
    mime: "image/webp",
    bytes: 1234,
    confirmed_at: getDb().fn.now(),
  });
}

// ---- empty state (§4.1) ----------------------------------------------------

describe("GET /api/content — empty state (§4.1)", () => {
  it("returns 200 with an empty pages array when nothing was ever published", async () => {
    const res = await request(app).get("/api/content");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 0,
      published_at: null,
      pages: [],
      media: {},
    });
    expect(res.headers.etag).toBe('W/"v0"');
  });
});

// ---- publish → content → 304 (§3.3, §4.1, §6.8) ----------------------------

describe("publish → content → 304 flow (§3.3 / §4.1 / §6.8)", () => {
  it("publishes the working set, serves it with resolved media URLs, and 304s on If-None-Match", async () => {
    const MEDIA_ID = "11111111-1111-1111-1111-111111111111";
    await insertMedia(MEDIA_ID, "media/hero.webp");

    const hero = (
      await createSection({
        type: "hero",
        data: { title: "Ben Kile", tagline: "builder", background_media_id: MEDIA_ID },
      })
    ).body.data;
    const portfolio = (await createSection({ type: "portfolio", data: {} })).body.data;
    await createItem(portfolio.id, {
      title: "Proj",
      intro: "i",
      description: "d",
      media_id: MEDIA_ID,
      tech_icons: ["ts"],
      links: [{ type: "repo", label: "code", url: "https://example.com" }],
    });

    // Publish → version 1, attributed to the admin sub.
    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);
    expect(pub.body.data.version).toBe(1);

    // Content reflects the published document, media resolved to CDN URLs (§6.8).
    const content = await request(app).get("/api/content");
    expect(content.status).toBe(200);
    expect(content.body.version).toBe(1);
    // v1.1 pages shape: a single `home` page carrying the two sections (§3.10).
    expect(content.body.pages).toHaveLength(1);
    const homePage = content.body.pages[0];
    expect(homePage.slug).toBe("home");
    expect(homePage.title).toBe("Home");
    expect(homePage.nav_label).toBe("Home");
    expect(homePage.nav_position).toBe(0);
    expect(homePage.sections).toHaveLength(2);
    expect(homePage.sections[0].id).toBe(hero.id);
    expect(homePage.sections[0].type).toBe("hero");
    // Section/item data still references media by id.
    expect(homePage.sections[0].data.background_media_id).toBe(MEDIA_ID);
    expect(homePage.sections[1].items).toHaveLength(1);
    // The media map resolves the id to a MediaRef ({ url, alt }) via resolveMediaMap.
    expect(content.body.media[MEDIA_ID]).toEqual({
      url: `https://${CDN_DOMAIN}/media/hero.webp`,
      alt: null,
    });
    expect(content.headers.etag).toBe('W/"v1"');
    expect(content.headers["cache-control"]).toContain("must-revalidate");

    // 304 on a matching If-None-Match, no body.
    const notModified = await request(app)
      .get("/api/content")
      .set("If-None-Match", 'W/"v1"');
    expect(notModified.status).toBe(304);
    expect(notModified.text).toBeFalsy();

    // A stale validator still gets a full 200.
    const stale = await request(app)
      .get("/api/content")
      .set("If-None-Match", 'W/"v0"');
    expect(stale.status).toBe(200);
    expect(stale.body.version).toBe(1);
  });

  it("excludes hidden sections/items from the published document", async () => {
    const visible = (await createSection({ type: "hero", data: { title: "Shown" } })).body.data;
    const hidden = (await createSection({ type: "about", data: { body: "secret" } })).body.data;
    await request(app)
      .patch(`/api/admin/sections/${hidden.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: hidden.updated_at, is_hidden: true });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);

    const content = await request(app).get("/api/content");
    expect(content.body.pages).toHaveLength(1);
    expect(content.body.pages[0].sections).toHaveLength(1);
    expect(content.body.pages[0].sections[0].id).toBe(visible.id);
  });
});

// ---- validation refusal (§3.9) ---------------------------------------------

describe("publish validation refusal (§3.9)", () => {
  it("refuses to publish when any section in the working set is invalid (400)", async () => {
    // Create a valid hero, then corrupt its data directly in the DB so the row
    // is invalid at publish time (the write path would have rejected it).
    const hero = (await createSection({ type: "hero", data: { title: "ok" } })).body.data;
    await getDb()("sections").where({ id: hero.id }).update({ data: { tagline: "no title" } });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(400);
    expect(pub.body).toMatchObject({ status: "error", error: true });

    // Nothing was published.
    const content = await request(app).get("/api/content");
    expect(content.body.version).toBe(0);
    const count = await getDb()("page_versions").count<{ count: string }[]>("* as count");
    expect(Number(count[0].count)).toBe(0);
  });
});

// ---- pages-level publish validation (§3.10 / §3.9) -------------------------

describe("publish pages validation (§3.10)", () => {
  it("refuses to publish when no page has slug 'home' (400)", async () => {
    // A single non-home page with a valid section — still unpublishable: a site
    // with no home page cannot be published (§3.10).
    const about = (await createPage({ slug: "about", title: "About" })).body.data;
    await createSection({ type: "hero", data: { title: "x" }, page_id: about.id });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(400);
    expect(pub.body).toMatchObject({ status: "error", error: true });
    expect(pub.body.errorMsg).toMatch(/home/i);

    const content = await request(app).get("/api/content");
    expect(content.body.version).toBe(0);
  });

  it("refuses to publish when there is no non-hidden page (400)", async () => {
    // The only page is `home`, but it is hidden — zero non-hidden pages, so the
    // published document would be empty. Refuse (§3.10).
    const home = (
      await createPage({ slug: "home", title: "Home", nav_label: "Home" })
    ).body.data;
    await request(app)
      .patch(`/api/admin/pages/${home.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: home.updated_at, is_hidden: true });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(400);
    expect(pub.body.errorMsg).toMatch(/non-hidden/i);

    const content = await request(app).get("/api/content");
    expect(content.body.version).toBe(0);
  });

  it("excludes a hidden page from the published document", async () => {
    const home = (
      await createPage({ slug: "home", title: "Home", nav_label: "Home" })
    ).body.data;
    await createSection({ type: "hero", data: { title: "Home hero" }, page_id: home.id });

    const secret = (
      await createPage({ slug: "secret", title: "Secret" })
    ).body.data;
    await createSection({ type: "about", data: { body: "hidden page body" }, page_id: secret.id });
    await request(app)
      .patch(`/api/admin/pages/${secret.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: secret.updated_at, is_hidden: true });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);

    // Only the non-hidden `home` page is serialized (§3.10).
    const content = await request(app).get("/api/content");
    expect(content.body.pages).toHaveLength(1);
    expect(content.body.pages[0].slug).toBe("home");
    expect(content.body.pages.map((p: { slug: string }) => p.slug)).not.toContain("secret");
  });

  it("publishes multiple pages → /api/content pages shape with media resolved across all pages", async () => {
    const HOME_MEDIA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const PROJ_MEDIA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await insertMedia(HOME_MEDIA, "media/home-hero.webp");
    await insertMedia(PROJ_MEDIA, "media/proj.webp");

    const home = (
      await createPage({ slug: "home", title: "Ben Kile", nav_label: "Home", nav_position: 0 })
    ).body.data;
    await createSection({
      type: "hero",
      data: { title: "Ben Kile", background_media_id: HOME_MEDIA },
      page_id: home.id,
    });

    const projects = (
      await createPage({
        slug: "projects",
        title: "Projects",
        nav_label: "Projects",
        nav_position: 1,
      })
    ).body.data;
    const portfolio = (
      await createSection({ type: "portfolio", data: {}, page_id: projects.id })
    ).body.data;
    await createItem(portfolio.id, {
      title: "Proj",
      intro: "i",
      description: "d",
      media_id: PROJ_MEDIA,
      tech_icons: ["ts"],
      links: [{ type: "repo", label: "code", url: "https://example.com" }],
    });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);

    const content = await request(app).get("/api/content");
    expect(content.body.version).toBe(1);
    // Two pages, ordered by nav_position (§3.10).
    expect(content.body.pages.map((p: { slug: string }) => p.slug)).toEqual([
      "home",
      "projects",
    ]);
    expect(content.body.pages[0].nav_label).toBe("Home");
    expect(content.body.pages[0].sections[0].type).toBe("hero");
    expect(content.body.pages[1].sections[0].type).toBe("portfolio");
    expect(content.body.pages[1].sections[0].items).toHaveLength(1);

    // Media from BOTH pages is collected and resolved to CDN URLs (§6.8).
    expect(content.body.media[HOME_MEDIA]).toEqual({
      url: `https://${CDN_DOMAIN}/media/home-hero.webp`,
      alt: null,
    });
    expect(content.body.media[PROJ_MEDIA]).toEqual({
      url: `https://${CDN_DOMAIN}/media/proj.webp`,
      alt: null,
    });
  });
});

// ---- legacy (pre-v1.1) restore back-compat (§3.10) -------------------------

describe("restore of a legacy flat document (§3.10 back-compat)", () => {
  it("wraps a hand-inserted legacy `sections` document into a `home` page and emits the v1.1 shape", async () => {
    const LEGACY_SECTION_ID = "33333333-3333-3333-3333-333333333333";
    const legacyDoc = {
      version: 1,
      published_at: "2026-01-01T00:00:00.000Z",
      // Pre-v1.1 flat shape: a top-level `sections` array, no `pages`.
      sections: [
        { id: LEGACY_SECTION_ID, type: "hero", data: { title: "Legacy" }, items: [] },
      ],
      media: {},
    };
    await getDb()("page_versions").insert({
      version: 1,
      document: legacyDoc as never,
      published_at: legacyDoc.published_at,
      published_by: "seed",
    });

    // Restore the legacy version → new version 2, emitted in the v1.1 pages shape.
    const restore = await request(app)
      .post("/api/admin/versions/1/restore")
      .set(...AUTH)
      .send({});
    expect(restore.status).toBe(201);
    expect(restore.body.data.version).toBe(2);
    const doc = restore.body.data.document;
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].slug).toBe("home");
    expect(doc.pages[0].title).toBe("Home");
    expect(doc.pages[0].nav_label).toBe("Home");
    expect(doc.pages[0].nav_position).toBe(0);
    expect(doc.pages[0].sections).toHaveLength(1);
    expect(doc.pages[0].sections[0].id).toBe(LEGACY_SECTION_ID);
    expect(doc.pages[0].sections[0].data.title).toBe("Legacy");

    // The working set was rebuilt: a single `home` page owns the wrapped sections.
    const pagesList = (
      await request(app).get("/api/admin/pages").set(...AUTH)
    ).body.data.pages;
    expect(pagesList).toHaveLength(1);
    expect(pagesList[0].slug).toBe("home");

    const ws = (
      await request(app).get("/api/admin/sections").set(...AUTH)
    ).body.data.sections;
    expect(ws).toHaveLength(1);
    expect(ws[0].id).toBe(LEGACY_SECTION_ID);
    expect(ws[0].page_id).toBe(pagesList[0].id);
    expect(ws[0].data).toEqual({ title: "Legacy" });

    // /api/content now serves the v1.1 pages shape, never the legacy flat shape.
    const content = await request(app).get("/api/content");
    expect(content.body.version).toBe(2);
    expect(content.body).not.toHaveProperty("sections");
    expect(content.body.pages[0].slug).toBe("home");
    expect(content.body.pages[0].sections[0].data.title).toBe("Legacy");
  });
});

// ---- restore rewrites the working set (§4.2) -------------------------------

describe("restore (§4.2)", () => {
  it("re-publishes an old version and rebuilds the working set from it", async () => {
    // Version 1: a hero titled "First".
    const hero = (await createSection({ type: "hero", data: { title: "First" } })).body.data;
    const v1 = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(v1.body.data.version).toBe(1);

    // Edit the draft, add a section, publish version 2.
    await request(app)
      .patch(`/api/admin/sections/${hero.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: hero.updated_at, data: { title: "Second" } });
    await createSection({ type: "contact", data: {} });
    const v2 = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(v2.body.data.version).toBe(2);

    // Working set currently has 2 sections with title "Second".
    let ws = (await request(app).get("/api/admin/sections").set(...AUTH)).body.data.sections;
    expect(ws).toHaveLength(2);

    // Restore version 1 → new version 3, working set rebuilt from v1's document.
    const restore = await request(app)
      .post("/api/admin/versions/1/restore")
      .set(...AUTH)
      .send({});
    expect(restore.status).toBe(201);
    expect(restore.body.data.version).toBe(3);

    // Content is now version 3, whose document equals version 1's sections.
    const content = await request(app).get("/api/content");
    expect(content.body.version).toBe(3);
    expect(content.body.pages).toHaveLength(1);
    expect(content.body.pages[0].sections).toHaveLength(1);
    expect(content.body.pages[0].sections[0].data.title).toBe("First");

    // The working set was rebuilt to match the restored document.
    ws = (await request(app).get("/api/admin/sections").set(...AUTH)).body.data.sections;
    expect(ws).toHaveLength(1);
    expect(ws[0].id).toBe(hero.id);
    expect(ws[0].type).toBe("hero");
    expect(ws[0].data).toEqual({ title: "First" });
    expect(ws[0].position).toBe(0);

    // A publish immediately after restore snapshots the restored working set,
    // not the discarded draft — proving the rebuild is authoritative.
    const v4 = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(v4.body.data.version).toBe(4);
    expect(v4.body.data.document.pages).toHaveLength(1);
    expect(v4.body.data.document.pages[0].sections).toHaveLength(1);
    expect(v4.body.data.document.pages[0].sections[0].data.title).toBe("First");
  });

  it("returns 404 restoring a version that does not exist", async () => {
    const res = await request(app)
      .post("/api/admin/versions/99/restore")
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ---- version history & prune-at-50 (§3.3, §4.2) ----------------------------

describe("versions & prune-at-50 (§3.3 / §4.2)", () => {
  it("lists version history newest-first", async () => {
    await createSection({ type: "hero", data: { title: "H" } });
    await request(app).post("/api/admin/publish").set(...AUTH).send({});
    await request(app).post("/api/admin/publish").set(...AUTH).send({});

    const res = await request(app).get("/api/admin/versions").set(...AUTH);
    expect(res.status).toBe(200);
    const versions = res.body.data.versions;
    expect(versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect(versions[0].published_by).toBe(ADMIN_PAYLOAD.sub);
  });

  it("retains only the most recent 50 versions", async () => {
    await createSection({ type: "hero", data: { title: "H" } });
    // Publish 55 times; a portfolio page never does this, but retention must hold.
    for (let i = 0; i < 55; i++) {
      const res = await request(app).post("/api/admin/publish").set(...AUTH).send({});
      expect(res.status).toBe(201);
    }

    const rows = await getDb()("page_versions")
      .select("version")
      .orderBy("version", "asc");
    expect(rows).toHaveLength(50);
    // The oldest surviving version is 6 (versions 1–5 pruned), newest is 55.
    expect(rows[0].version).toBe(6);
    expect(rows[rows.length - 1].version).toBe(55);
  });
});

// ---- draft preview (§4.2 †, §7) --------------------------------------------

describe("GET /api/admin/preview — draft serialization (§4.2 / §7)", () => {
  it("serializes the draft in exactly the /api/content shape", async () => {
    const MEDIA_ID = "22222222-2222-2222-2222-222222222222";
    await insertMedia(MEDIA_ID, "media/draft.webp");
    await createSection({
      type: "hero",
      data: { title: "Draft", background_media_id: MEDIA_ID },
    });

    // Nothing published yet — preview still serves the draft.
    const preview = await request(app).get("/api/admin/preview").set(...AUTH);
    expect(preview.status).toBe(200);
    const draft = preview.body;
    expect(draft.version).toBeNull();
    expect(draft.published_at).toBeNull();
    // v1.1 pages shape: the draft's single `home` page carrying the hero (§3.10).
    expect(draft.pages).toHaveLength(1);
    expect(draft.pages[0].slug).toBe("home");
    expect(draft.pages[0].sections).toHaveLength(1);
    expect(draft.pages[0].sections[0].type).toBe("hero");
    expect(draft.pages[0].sections[0]).toHaveProperty("id");
    expect(draft.pages[0].sections[0]).toHaveProperty("items");
    expect(draft.media[MEDIA_ID]).toEqual({
      url: `https://${CDN_DOMAIN}/media/draft.webp`,
      alt: null,
    });

    // Same key set as a published /api/content document (shape parity, §4.1).
    await request(app).post("/api/admin/publish").set(...AUTH).send({});
    const content = await request(app).get("/api/content");
    expect(Object.keys(draft).sort()).toEqual(Object.keys(content.body).sort());
  });

  it("rejects an unauthenticated preview with 401", async () => {
    const res = await request(app).get("/api/admin/preview");
    expect(res.status).toBe(401);
  });
});
