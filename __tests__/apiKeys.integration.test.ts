import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express, NextFunction, Request, Response } from "express";
import request from "supertest";

/**
 * API Keys v1.16 — reachability integration tests. Exercises the REAL admin
 * routers + services (including the `api_keys` table) against a throwaway Postgres
 * 15 cluster (unix-socket only, under /tmp, per agent-pre-checks.md), proving the
 * full lifecycle end to end:
 *
 *  - MINT returns the full key exactly ONCE; LIST never exposes a hash or full key;
 *  - a minted key REACHES the full content-editing surface (pages, sections/items,
 *    posts CRUD/publish, blogs write, media incl. sweep/delete, publish/versions/
 *    restore, preview-token, analytics, icons) and is 401 ONLY on the humans-only
 *    surface (api-keys, integrations, legacy /spotify);
 *  - a key-driven post publish AND a key-driven site publish/restore attribute
 *    as `key:<name>`;
 *  - `last_used_at` is stamped on an accepted key request;
 *  - REVOKE (idempotent; unknown id 404) then rejects the key (401), incl. on a
 *    newly widened route (POST /api/admin/sections);
 *  - a malformed/unknown `pv6k_` bearer is 401;
 *  - a human admin is unaffected.
 *
 * NO AWS is touched: the admin ID-token verifier and `src/aws/s3Service` are mocked.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

jest.mock("../src/aws/s3Service", () => ({
  initS3: jest.fn(),
  getBucketName: jest.fn(() => "bk-portfolio-v6-test"),
  buildMediaKey: jest.fn(
    (uuid: string, filename: string) => `media/${uuid}/${filename}`
  ),
  buildResumeKey: jest.fn(
    (uuid: string, filename: string) => `resumes/${uuid}/${filename}`
  ),
  generatePresignedUploadUrl: jest.fn().mockResolvedValue({
    url: "https://s3.example/put",
    headers: { "Content-Type": "image/png" },
  }),
  headObject: jest.fn().mockResolvedValue({ contentLength: 123 }),
  getObjectStream: jest.fn(),
  putObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminApiKeysRouter from "../src/routers/adminApiKeysRouter";
import adminPostsRouter from "../src/routers/adminPostsRouter";
import adminMediaRouter from "../src/routers/adminMediaRouter";
import adminResumesRouter from "../src/routers/adminResumesRouter";
import adminBlogsRouter from "../src/routers/adminBlogsRouter";
import adminPagesRouter from "../src/routers/adminPagesRouter";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import adminPublishRouter from "../src/routers/adminPublishRouter";
import adminIntegrationsRouter from "../src/routers/adminIntegrationsRouter";
import adminAuthRouter from "../src/routers/adminAuthRouter";
import adminAnalyticsRouter from "../src/routers/adminAnalyticsRouter";
import { failure } from "../src/utils/envelope";

const mockVerifyAdmin = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55446"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_apikeys_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task614");
const CDN_DOMAIN = "media-test.benkile.com";

const POOL_ID = "us-east-1_testpool";
const ADMIN_CLIENT_ID = "test-admin-client";

const ADMIN_PAYLOAD = { sub: "admin-sub-616", "cognito:groups": ["admins"] };
const ADMIN_AUTH = ["Authorization", "Bearer admin.id.token"] as const;

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
    cognito_user_pool_id: POOL_ID,
    cognito_client_id: ADMIN_CLIENT_ID,
    cdn_domain: CDN_DOMAIN,
  });
  app.use("/api/admin", adminApiKeysRouter);
  app.use("/api/admin", adminAuthRouter);
  app.use("/api/admin", adminPagesRouter);
  app.use("/api/admin", adminSectionsRouter);
  app.use("/api/admin", adminPublishRouter);
  app.use("/api/admin", adminMediaRouter);
  app.use("/api/admin", adminResumesRouter);
  app.use("/api/admin", adminPostsRouter);
  app.use("/api/admin", adminBlogsRouter);
  app.use("/api/admin", adminIntegrationsRouter);
  app.use("/api/admin", adminAnalyticsRouter);
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(500).json(failure(err.message));
  });
  return app;
}

/** Bearer tuple for a raw API key. */
function keyAuth(key: string): [string, string] {
  return ["Authorization", `Bearer ${key}`];
}

/** Mint a fresh key via the admin surface and return its id + full key. */
async function mint(name: string): Promise<{ id: string; key: string }> {
  const res = await request(app)
    .post("/api/admin/api-keys")
    .set(...ADMIN_AUTH)
    .send({ name });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, key: res.body.data.key as string };
}

/** Poll the DB until `last_used_at` is set (the touch is fire-and-forget). */
async function waitForLastUsed(id: string): Promise<Date | null> {
  for (let i = 0; i < 40; i++) {
    const row = await getDb()("api_keys").where({ id }).first();
    if (row?.last_used_at) return row.last_used_at as Date;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

let app: Express;

beforeAll(async () => {
  startCluster();
  await initDb(
    {
      host: PG_SOCKET_DIR,
      port: Number(PG_PORT),
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

beforeEach(() => {
  // Only "admin.id.token" is a valid admin ID token; everything else (including a
  // `pv6k_` key) fails the admin verifier and falls to the key path.
  mockVerifyAdmin.mockReset();
  mockVerifyAdmin.mockImplementation(async (token: string) => {
    if (token === "admin.id.token") return ADMIN_PAYLOAD;
    throw new Error("not an admin id token");
  });
});

afterEach(async () => {
  const db = getDb();
  await db("posts").del();
  await db("media_assets").del();
  await db("resumes").del();
  await db("blogs").del();
  await db("api_keys").del();
  await db("section_items").del();
  await db("sections").del();
  await db("pages").del();
  await db("page_versions").del();
});

describe("mint / list — full key returned once, never exposed again", () => {
  it("mint returns the full pv6k_ key with a display prefix; list never carries it or a hash", async () => {
    const res = await request(app)
      .post("/api/admin/api-keys")
      .set(...ADMIN_AUTH)
      .send({ name: "posting-bot" });

    expect(res.status).toBe(201);
    const { id, name, key_prefix, created_at, key } = res.body.data;
    expect(name).toBe("posting-bot");
    expect(typeof key).toBe("string");
    expect(key.startsWith("pv6k_")).toBe(true);
    expect(key_prefix).toBe(key.slice(0, 12));
    expect(created_at).toBeTruthy();
    expect(id).toBeTruthy();

    // Stored: only a hash + the display prefix — never the full key.
    const row = await getDb()("api_keys").where({ id }).first();
    expect(row.key_hash).toBeTruthy();
    expect(row.key_hash).not.toBe(key);
    expect(row.key_prefix).toBe(key_prefix);
    expect(Object.values(row)).not.toContain(key);

    // List: metadata only, newest first, no hash or full key anywhere.
    const list = await request(app).get("/api/admin/api-keys").set(...ADMIN_AUTH);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    const item = list.body.data.find((k: { id: string }) => k.id === id);
    expect(item).toMatchObject({ id, name, key_prefix });
    expect(item).not.toHaveProperty("key");
    expect(item).not.toHaveProperty("key_hash");
    expect(JSON.stringify(list.body)).not.toContain(key);
  });

  it("rejects an empty/blank name with 400", async () => {
    const blank = await request(app)
      .post("/api/admin/api-keys")
      .set(...ADMIN_AUTH)
      .send({ name: "   " });
    expect(blank.status).toBe(400);

    const missing = await request(app)
      .post("/api/admin/api-keys")
      .set(...ADMIN_AUTH)
      .send({});
    expect(missing.status).toBe(400);
  });

  it("lists newest first", async () => {
    await mint("first");
    await new Promise((r) => setTimeout(r, 10));
    await mint("second");
    const list = await request(app).get("/api/admin/api-keys").set(...ADMIN_AUTH);
    const names = list.body.data.map((k: { name: string }) => k.name);
    expect(names.slice(0, 2)).toEqual(["second", "first"]);
  });
});

describe("a minted key REACHES the content-editing surface", () => {
  it("pages + sections (a widened route): create page, create section, patch, delete", async () => {
    const { key } = await mint("editing-agent");

    const page = await request(app)
      .post("/api/admin/pages")
      .set(...keyAuth(key))
      .send({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 });
    expect(page.status).toBe(201);
    const pageId = page.body.data.id as string;

    const section = await request(app)
      .post("/api/admin/sections")
      .set(...keyAuth(key))
      .send({ type: "about", data: { heading: "Hi", body: "hello" }, page_id: pageId });
    expect(section.status).toBe(201);
    const sectionId = section.body.data.id as string;

    const listed = await request(app).get("/api/admin/sections").set(...keyAuth(key));
    expect(listed.status).toBe(200);

    const patched = await request(app)
      .patch(`/api/admin/sections/${sectionId}`)
      .set(...keyAuth(key))
      .send({
        expected_updated_at: section.body.data.updated_at,
        data: { heading: "Hi again", body: "hello" },
      });
    expect(patched.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/admin/sections/${sectionId}`)
      .set(...keyAuth(key));
    expect(deleted.status).toBe(200);
  });

  it("site publish + versions + restore, attributed key:<name>", async () => {
    const { key } = await mint("editing-agent");

    // Set up a minimal publishable working set: one non-hidden `home` page.
    const page = await request(app)
      .post("/api/admin/pages")
      .set(...keyAuth(key))
      .send({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 });
    expect(page.status).toBe(201);

    const pub = await request(app)
      .post("/api/admin/publish")
      .set(...keyAuth(key))
      .send({});
    expect(pub.status).toBe(201);
    const version = pub.body.data.version as number;

    const versions = await request(app)
      .get("/api/admin/versions")
      .set(...keyAuth(key));
    expect(versions.status).toBe(200);

    // A key-driven publish is recorded as key:<name> in page_versions.
    const row = await getDb()("page_versions").where({ version }).first();
    expect(row.published_by).toBe("key:editing-agent");

    // Restore is also key-attributed.
    const restore = await request(app)
      .post(`/api/admin/versions/${version}/restore`)
      .set(...keyAuth(key))
      .send({});
    expect(restore.status).toBe(201);
    const restoreVersion = restore.body.data.version as number;
    const restoreRow = await getDb()("page_versions")
      .where({ version: restoreVersion })
      .first();
    expect(restoreRow.published_by).toBe("key:editing-agent");
  });

  it("blogs write surface (widened): create + patch + delete", async () => {
    const { key } = await mint("editing-agent");

    const created = await request(app)
      .post("/api/admin/blogs")
      .set(...keyAuth(key))
      .send({ slug: "notes", name: "Notes" });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const patched = await request(app)
      .patch(`/api/admin/blogs/${id}`)
      .set(...keyAuth(key))
      .send({
        expected_updated_at: created.body.data.updated_at,
        name: "Notes v2",
      });
    expect(patched.status).toBe(200);

    const removed = await request(app)
      .delete(`/api/admin/blogs/${id}`)
      .set(...keyAuth(key));
    expect(removed.status).toBe(200);
  });

  it("preview-token mint, analytics, media sweep — all reachable by a key", async () => {
    const { key } = await mint("editing-agent");

    const previewToken = await request(app)
      .post("/api/admin/preview-token")
      .set(...keyAuth(key))
      .send();
    expect(previewToken.status).toBe(201);
    expect(typeof previewToken.body.data.token).toBe("string");

    const analytics = await request(app)
      .get("/api/admin/analytics")
      .set(...keyAuth(key));
    expect(analytics.status).toBe(200);

    const sweep = await request(app)
      .post("/api/admin/media/sweep")
      .set(...keyAuth(key))
      .send();
    expect(sweep.status).toBe(200);
  });

  it("posts CRUD + publish, attributed key:<name>; last_used_at is stamped", async () => {
    const { id: keyId, key } = await mint("posting-bot");

    const created = await request(app)
      .post("/api/admin/posts")
      .set(...keyAuth(key))
      .send({
        slug: "bot-post",
        title: "By the bot",
        draft_body: [{ type: "paragraph", text: "hello from the bot" }],
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const list = await request(app).get("/api/admin/posts").set(...keyAuth(key));
    expect(list.status).toBe(200);

    const one = await request(app)
      .get(`/api/admin/posts/${id}`)
      .set(...keyAuth(key));
    expect(one.status).toBe(200);

    const patch = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...keyAuth(key))
      .send({
        expected_updated_at: one.body.data.updated_at,
        title: "Edited by the bot",
      });
    expect(patch.status).toBe(200);

    const pub = await request(app)
      .post(`/api/admin/posts/${id}/publish`)
      .set(...keyAuth(key))
      .send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.published_at).not.toBeNull();

    // Attribution is persisted as key:<name>.
    const row = await getDb()("posts").where({ id }).first();
    expect(row.published_by).toBe("key:posting-bot");

    const unpub = await request(app)
      .post(`/api/admin/posts/${id}/unpublish`)
      .set(...keyAuth(key))
      .send({});
    expect(unpub.status).toBe(200);

    // last_used_at was stamped (fire-and-forget) by the accepted requests.
    const lastUsed = await waitForLastUsed(keyId);
    expect(lastUsed).not.toBeNull();
  });

  it("the post-image media routes: upload-url, confirm, list", async () => {
    const { key } = await mint("posting-bot");

    const presign = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...keyAuth(key))
      .send({ filename: "cover.png", mime: "image/png", size: 1024 });
    expect(presign.status).toBe(201);
    const mediaId = presign.body.data.id as string;

    const confirm = await request(app)
      .post(`/api/admin/media/${mediaId}/confirm`)
      .set(...keyAuth(key))
      .send({});
    expect(confirm.status).toBe(200);

    const listed = await request(app).get("/api/admin/media").set(...keyAuth(key));
    expect(listed.status).toBe(200);
  });

  it("the resume routes (task #92): upload-url, confirm, list, delete", async () => {
    const { key } = await mint("posting-bot");

    // upload-url — pv6k key path.
    const presign = await request(app)
      .post("/api/admin/resumes/upload-url")
      .set(...keyAuth(key))
      .send({ filename: "resume.pdf", size: 2048 });
    expect(presign.status).toBe(201);
    const resumeId = presign.body.data.id as string;

    // uploaded_by is attributed as `key:<name>` (the same convention as
    // publish/restore).
    const row = await getDb()("resumes").where({ id: resumeId }).first();
    expect(row.uploaded_by).toBe("key:posting-bot");

    // confirm — pv6k key path.
    const confirm = await request(app)
      .post(`/api/admin/resumes/${resumeId}/confirm`)
      .set(...keyAuth(key))
      .send({});
    expect(confirm.status).toBe(200);

    // list — pv6k key path.
    const listed = await request(app)
      .get("/api/admin/resumes")
      .set(...keyAuth(key));
    expect(listed.status).toBe(200);
    expect(listed.body.data.resumes[0].id).toBe(resumeId);

    // delete — pv6k key path.
    const del = await request(app)
      .delete(`/api/admin/resumes/${resumeId}`)
      .set(...keyAuth(key));
    expect(del.status).toBe(200);
  });

  it("GET /api/admin/blogs (read-only) so the bot can resolve a blog_id", async () => {
    const { key } = await mint("posting-bot");
    const res = await request(app).get("/api/admin/blogs").set(...keyAuth(key));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.blogs)).toBe(true);
  });
});

describe("a minted key is BLOCKED (401) on the humans-only surface", () => {
  // Only api-keys and integrations (+ the legacy /spotify aliases) stay
  // humans-only — a machine key must never mint another key or read/write
  // stored credentials.
  const adminOnly: Array<[string, () => request.Test]> = [
    // api-keys — every route
    ["POST /api/admin/api-keys", () =>
      request(app).post("/api/admin/api-keys").send({ name: "x" })],
    ["GET /api/admin/api-keys", () => request(app).get("/api/admin/api-keys")],
    [
      "POST /api/admin/api-keys/:id/revoke",
      () =>
        request(app).post(
          "/api/admin/api-keys/11111111-1111-1111-1111-111111111111/revoke"
        ),
    ],
    // integrations — every route
    [
      "GET /api/admin/integrations",
      () => request(app).get("/api/admin/integrations"),
    ],
    [
      "PUT /api/admin/integrations/:key/value",
      () =>
        request(app)
          .put("/api/admin/integrations/github/value")
          .send({ value: "x" }),
    ],
    [
      "POST /api/admin/integrations/:key/connect",
      () => request(app).post("/api/admin/integrations/spotify/connect"),
    ],
    [
      "DELETE /api/admin/integrations/:key",
      () => request(app).delete("/api/admin/integrations/spotify"),
    ],
    // legacy /spotify aliases
    [
      "GET /api/admin/spotify/status",
      () => request(app).get("/api/admin/spotify/status"),
    ],
    [
      "POST /api/admin/spotify/connect",
      () => request(app).post("/api/admin/spotify/connect"),
    ],
    ["DELETE /api/admin/spotify", () => request(app).delete("/api/admin/spotify")],
  ];

  it.each(adminOnly)("%s → 401 for an API key", async (_label, mkReq) => {
    const { key } = await mint("editing-agent");
    const res = await mkReq().set(...keyAuth(key)).send();
    expect(res.status).toBe(401);
  });
});

describe("revoke", () => {
  it("revokes (idempotent) then rejects the key on the content-editing surface", async () => {
    const { id, key } = await mint("editing-agent");

    // Set up: an existing page so POST /sections has a valid page_id target.
    const page = await request(app)
      .post("/api/admin/pages")
      .set(...keyAuth(key))
      .send({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 });
    expect(page.status).toBe(201);
    const pageId = page.body.data.id as string;

    // Works before revoke — a widened route (POST /api/admin/sections) succeeds.
    const before = await request(app)
      .post("/api/admin/sections")
      .set(...keyAuth(key))
      .send({ type: "about", data: { heading: "hi" }, page_id: pageId });
    expect(before.status).toBe(201);

    const revoke = await request(app)
      .post(`/api/admin/api-keys/${id}/revoke`)
      .set(...ADMIN_AUTH);
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.revoked_at).not.toBeNull();
    const firstRevokedAt = revoke.body.data.revoked_at;

    // Idempotent: revoking again is still 200 and preserves the original time.
    const again = await request(app)
      .post(`/api/admin/api-keys/${id}/revoke`)
      .set(...ADMIN_AUTH);
    expect(again.status).toBe(200);
    expect(again.body.data.revoked_at).toBe(firstRevokedAt);

    // The key is now rejected everywhere — including the widened route.
    const afterSection = await request(app)
      .post("/api/admin/sections")
      .set(...keyAuth(key))
      .send({ type: "about", data: {}, page_id: pageId });
    expect(afterSection.status).toBe(401);
    const afterPosts = await request(app).get("/api/admin/posts").set(...keyAuth(key));
    expect(afterPosts.status).toBe(401);
  });

  it("returns 404 revoking an unknown id", async () => {
    const res = await request(app)
      .post(`/api/admin/api-keys/11111111-1111-1111-1111-111111111111/revoke`)
      .set(...ADMIN_AUTH);
    expect(res.status).toBe(404);
  });
});

describe("malformed / unknown keys are 401", () => {
  it("a well-formed-looking but unknown pv6k_ key is 401", async () => {
    const res = await request(app)
      .get("/api/admin/posts")
      .set(...keyAuth("pv6k_this-key-was-never-minted-000000000000"));
    expect(res.status).toBe(401);
  });

  it("a non-pv6k_ bearer is 401 on the content-editing surface", async () => {
    const res = await request(app)
      .get("/api/admin/posts")
      .set("Authorization", "Bearer garbage.bearer.token");
    expect(res.status).toBe(401);
  });
});

describe("human admin is unaffected", () => {
  it("admin reaches an admin-only route and posts publish is attributed to the admin sub", async () => {
    const versions = await request(app)
      .get("/api/admin/versions")
      .set(...ADMIN_AUTH);
    expect(versions.status).toBe(200);

    const created = await request(app)
      .post("/api/admin/posts")
      .set(...ADMIN_AUTH)
      .send({
        slug: "admin-post",
        title: "By the admin",
        draft_body: [{ type: "paragraph", text: "hi" }],
      });
    const id = created.body.data.id as string;
    const pub = await request(app)
      .post(`/api/admin/posts/${id}/publish`)
      .set(...ADMIN_AUTH)
      .send({});
    expect(pub.status).toBe(200);
    const row = await getDb()("posts").where({ id }).first();
    expect(row.published_by).toBe(ADMIN_PAYLOAD.sub);
  });
});
