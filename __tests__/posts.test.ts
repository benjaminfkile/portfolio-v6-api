import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Posts integration tests — TECH_SPEC_V1.md §3.6, §3.7, §4.1, §4.2, §4.5
 * (task #441 DoD). Real routers + services against a throwaway Postgres 15
 * cluster (unix-socket only, under /tmp, per agent-pre-checks.md); the pg client
 * is given an explicit `user` because it does not infer the OS user the way psql
 * does.
 *
 * NO AWS is touched: `src/aws/s3Service` is FULLY MOCKED (the publish route
 * triggers the media GC pass, which HEAD/tags S3), and the Cognito verifier is
 * mocked so `requireAdmin` passes with a bearer token. CDN resolution is
 * exercised through the configured `cdn_domain` secret only.
 *
 * Covered: admin CRUD + wholesale draft_body + 409 concurrency; publish block
 * re-validation refusal; unpublish retains published_body; slug lock after
 * publish; the full public lifecycle (draft invisible → publish → visible → edit
 * draft leaves public unchanged → unpublish → 404); public summaries never leak
 * drafts/bodies; cursor pagination; and the draft-preview route.
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
  generatePresignedUploadUrl: jest.fn(),
  headObject: jest.fn().mockResolvedValue({ contentLength: 1 }),
  putObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminPostsRouter from "../src/routers/adminPostsRouter";
import postsRouter from "../src/routers/postsRouter";
import { failure } from "../src/utils/envelope";
import {
  mintPreviewToken,
  clearPreviewTokens,
} from "../src/services/previewTokenService";

const mockVerify = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55441"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_posts_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task441");
const CDN_DOMAIN = "media-test.benkile.com";

const ADMIN_PAYLOAD = { sub: "admin-sub-441", "cognito:groups": ["admins"] };
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
  app.use("/api/posts", postsRouter);
  app.use("/api/admin", adminPostsRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) return next(err);
      res.status(500).json(failure(err.message));
    }
  );
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
  clearPreviewTokens();
  await getDb()("posts").del();
  await getDb()("media_assets").del();
});

// ---- helpers ---------------------------------------------------------------

async function insertMedia(id: string, s3Key: string) {
  await getDb()("media_assets").insert({
    id,
    s3_key: s3Key,
    mime: "image/webp",
    bytes: 1234,
    confirmed_at: getDb().fn.now(),
  });
}

async function createPost(body: Record<string, unknown>) {
  return request(app).post("/api/admin/posts").set(...AUTH).send(body);
}

async function publish(id: string) {
  return request(app).post(`/api/admin/posts/${id}/publish`).set(...AUTH).send({});
}

const PARA = (text: string) => ({ type: "paragraph", text });

// ---- admin CRUD + concurrency (§4.2 / §4.5) --------------------------------

describe("admin post CRUD + optimistic concurrency (§4.2 / §4.5)", () => {
  it("creates, reads with draft_body, updates wholesale draft_body, and deletes", async () => {
    const created = await createPost({
      slug: "hello-world",
      title: "Hello World",
      excerpt: "an intro",
      tags: ["intro", "meta"],
      draft_body: [PARA("first"), { type: "divider" }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.slug).toBe("hello-world");
    expect(created.body.data.published_at).toBeNull();

    // GET one returns the draft body.
    const one = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    expect(one.status).toBe(200);
    expect(one.body.data.draft_body).toHaveLength(2);
    expect(one.body.data.draft_body[0]).toEqual({ type: "paragraph", text: "first" });

    // PATCH a wholesale new draft_body under the precondition.
    const patch = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: one.body.data.updated_at,
        draft_body: [PARA("rewritten")],
        title: "Hello (edited)",
      });
    expect(patch.status).toBe(200);
    expect(patch.body.data.draft_body).toEqual([{ type: "paragraph", text: "rewritten" }]);
    expect(patch.body.data.title).toBe("Hello (edited)");

    // DELETE.
    const del = await request(app).delete(`/api/admin/posts/${id}`).set(...AUTH);
    expect(del.status).toBe(200);
    const gone = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    expect(gone.status).toBe(404);
  });

  it("requires expected_updated_at on PATCH (400 when missing)", async () => {
    const created = await createPost({ slug: "no-precond", title: "T" });
    const res = await request(app)
      .patch(`/api/admin/posts/${created.body.data.id}`)
      .set(...AUTH)
      .send({ title: "new" });
    expect(res.status).toBe(400);
  });

  it("returns 409 on a stale expected_updated_at, without writing", async () => {
    const created = await createPost({ slug: "concurrent", title: "T" });
    const id = created.body.data.id;
    const res = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: "2000-01-01T00:00:00.000Z",
        title: "should not stick",
      });
    expect(res.status).toBe(409);
    const check = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    expect(check.body.data.title).toBe("T");
  });

  it("rejects an invalid slug and a duplicate slug", async () => {
    const bad = await createPost({ slug: "Not A Slug", title: "T" });
    expect(bad.status).toBe(400);

    await createPost({ slug: "taken", title: "One" });
    const dup = await createPost({ slug: "taken", title: "Two" });
    expect(dup.status).toBe(409);
  });

  it("refuses an invalid draft_body block on write (400)", async () => {
    const res = await createPost({
      slug: "bad-body",
      title: "T",
      draft_body: [{ type: "heading", level: 5, text: "too deep" }],
    });
    expect(res.status).toBe(400);
  });

  it("lists all posts including drafts, newest-first", async () => {
    await createPost({ slug: "one", title: "One" });
    await createPost({ slug: "two", title: "Two" });
    const res = await request(app).get("/api/admin/posts").set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toHaveLength(2);
    expect(res.body.data.posts[0].slug).toBe("two");
  });

  it("rejects unauthenticated admin access with 401", async () => {
    const res = await request(app).get("/api/admin/posts");
    expect(res.status).toBe(401);
  });
});

// ---- publish / unpublish (§3.6 / §3.9) -------------------------------------

describe("publish + unpublish lifecycle (§3.6 / §3.9)", () => {
  it("re-validates the draft body and refuses to publish an invalid one (400)", async () => {
    const created = await createPost({ slug: "will-corrupt", title: "T", draft_body: [PARA("ok")] });
    const id = created.body.data.id;
    // Corrupt draft_body directly so it is invalid at publish time (the write
    // path would have rejected it).
    await getDb()("posts")
      .where({ id })
      .update({ draft_body: JSON.stringify([{ type: "heading", level: 9 }]) });

    const res = await publish(id);
    expect(res.status).toBe(400);
    const row = await getDb()("posts").where({ id }).first();
    expect(row.published_at).toBeNull();
    expect(row.published_body).toBeNull();
  });

  it("publishes (published_body := draft_body) and unpublish retains published_body", async () => {
    const created = await createPost({ slug: "lifecycle", title: "T", draft_body: [PARA("v1")] });
    const id = created.body.data.id;

    const pub = await publish(id);
    expect(pub.status).toBe(200);
    expect(pub.body.data.published_at).not.toBeNull();
    expect(pub.body.data.published_body).toEqual([{ type: "paragraph", text: "v1" }]);

    const unpub = await request(app)
      .post(`/api/admin/posts/${id}/unpublish`)
      .set(...AUTH)
      .send({});
    expect(unpub.status).toBe(200);
    expect(unpub.body.data.published_at).toBeNull();
    // published_body is retained.
    expect(unpub.body.data.published_body).toEqual([{ type: "paragraph", text: "v1" }]);
  });
});

// ---- slug immutability after first publish (§3.6) --------------------------

describe("slug lock after first publish (§3.6)", () => {
  it("permits slug edits before publish, blocks them after (400)", async () => {
    const created = await createPost({ slug: "before", title: "T" });
    const id = created.body.data.id;

    // Editable before publish.
    let cur = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    const rename = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({ expected_updated_at: cur.body.data.updated_at, slug: "renamed" });
    expect(rename.status).toBe(200);
    expect(rename.body.data.slug).toBe("renamed");

    // Publish, then a slug change is refused.
    await publish(id);
    cur = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    const locked = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({ expected_updated_at: cur.body.data.updated_at, slug: "too-late" });
    expect(locked.status).toBe(400);

    // Re-sending the SAME slug after publish is a no-op, not a 400.
    cur = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    const same = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: cur.body.data.updated_at,
        slug: "renamed",
        title: "still editable",
      });
    expect(same.status).toBe(200);
    expect(same.body.data.title).toBe("still editable");
  });
});

// ---- public lifecycle (§4.1 / §3.6) ----------------------------------------

describe("public post lifecycle (§4.1 / §3.6)", () => {
  it("draft invisible → publish → visible → edit draft (public unchanged) → unpublish → 404", async () => {
    const created = await createPost({
      slug: "journey",
      title: "Journey",
      excerpt: "the excerpt",
      draft_body: [PARA("published body")],
    });
    const id = created.body.data.id;

    // Draft is invisible publicly.
    expect((await request(app).get("/api/posts/journey")).status).toBe(404);
    expect((await request(app).get("/api/posts")).body.posts).toHaveLength(0);

    // Publish → visible with published_body only.
    await publish(id);
    const pubView = await request(app).get("/api/posts/journey");
    expect(pubView.status).toBe(200);
    expect(pubView.body.slug).toBe("journey");
    expect(pubView.body.body).toEqual([{ type: "paragraph", text: "published body" }]);
    expect(pubView.body).not.toHaveProperty("draft_body");
    expect(pubView.body).not.toHaveProperty("published_body");
    expect((await request(app).get("/api/posts")).body.posts).toHaveLength(1);

    // Edit the draft body → public copy is UNCHANGED until re-publish (§3.6).
    let cur = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({
        expected_updated_at: cur.body.data.updated_at,
        draft_body: [PARA("secret draft edit")],
      });
    const stillOld = await request(app).get("/api/posts/journey");
    expect(stillOld.body.body).toEqual([{ type: "paragraph", text: "published body" }]);

    // Re-publish → public now reflects the edit.
    await publish(id);
    const republished = await request(app).get("/api/posts/journey");
    expect(republished.body.body).toEqual([{ type: "paragraph", text: "secret draft edit" }]);

    // Unpublish → 404 again.
    await request(app).post(`/api/admin/posts/${id}/unpublish`).set(...AUTH).send({});
    expect((await request(app).get("/api/posts/journey")).status).toBe(404);
    expect((await request(app).get("/api/posts")).body.posts).toHaveLength(0);
  });

  it("resolves cover + in-body media to CDN URLs and supports ETag/304", async () => {
    const COVER = "11111111-1111-1111-1111-111111111111";
    const INLINE = "22222222-2222-2222-2222-222222222222";
    await insertMedia(COVER, "media/cover.webp");
    await insertMedia(INLINE, "media/inline.webp");

    const created = await createPost({
      slug: "with-media",
      title: "With Media",
      cover_media_id: COVER,
      tags: ["photo"],
      draft_body: [{ type: "media", media_id: INLINE, caption: "a pic" }],
    });
    const id = created.body.data.id;
    await publish(id);

    const res = await request(app).get("/api/posts/with-media");
    expect(res.status).toBe(200);
    expect(res.body.cover).toEqual({
      url: `https://${CDN_DOMAIN}/media/cover.webp`,
      alt: null,
    });
    expect(res.body.media[INLINE]).toEqual({
      url: `https://${CDN_DOMAIN}/media/inline.webp`,
      alt: null,
    });
    expect(res.headers.etag).toBeTruthy();

    // 304 on a matching If-None-Match.
    const notModified = await request(app)
      .get("/api/posts/with-media")
      .set("If-None-Match", res.headers.etag);
    expect(notModified.status).toBe(304);
    expect(notModified.text).toBeFalsy();

    // Summaries carry the resolved cover + tags, never a body.
    const summaries = await request(app).get("/api/posts");
    const summary = summaries.body.posts[0];
    expect(summary.cover).toEqual({
      url: `https://${CDN_DOMAIN}/media/cover.webp`,
      alt: null,
    });
    expect(summary.tags).toEqual(["photo"]);
    expect(summary).not.toHaveProperty("body");
    expect(summary).not.toHaveProperty("draft_body");
    expect(summary).not.toHaveProperty("published_body");
  });
});

// ---- cursor pagination (§4.1) ----------------------------------------------

describe("cursor pagination (§4.1)", () => {
  it("paginates published posts newest-first via opaque cursor", async () => {
    // Publish five posts with strictly increasing published_at.
    const slugs = ["p1", "p2", "p3", "p4", "p5"];
    for (let i = 0; i < slugs.length; i++) {
      const created = await createPost({ slug: slugs[i], title: slugs[i] });
      await getDb()("posts")
        .where({ id: created.body.data.id })
        .update({
          published_body: JSON.stringify([]),
          published_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        });
    }

    // Page 1: two newest (p5, p4).
    const page1 = await request(app).get("/api/posts?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.posts.map((p: { slug: string }) => p.slug)).toEqual(["p5", "p4"]);
    expect(page1.body.next_cursor).toBeTruthy();

    // Page 2: next two (p3, p2).
    const page2 = await request(app).get(
      `/api/posts?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`
    );
    expect(page2.body.posts.map((p: { slug: string }) => p.slug)).toEqual(["p3", "p2"]);

    // Page 3: last one (p1), no further cursor.
    const page3 = await request(app).get(
      `/api/posts?limit=2&cursor=${encodeURIComponent(page2.body.next_cursor)}`
    );
    expect(page3.body.posts.map((p: { slug: string }) => p.slug)).toEqual(["p1"]);
    expect(page3.body.next_cursor).toBeNull();
  });

  it("filters by tag and rejects an invalid cursor (400)", async () => {
    const a = await createPost({ slug: "tagged", title: "A", tags: ["ts"] });
    const b = await createPost({ slug: "untagged", title: "B", tags: ["go"] });
    await publish(a.body.data.id);
    await publish(b.body.data.id);

    const res = await request(app).get("/api/posts?tag=ts");
    expect(res.body.posts.map((p: { slug: string }) => p.slug)).toEqual(["tagged"]);

    expect((await request(app).get("/api/posts?cursor=%%%not-base64%%%")).status).toBe(400);
  });
});

// ---- draft preview (§4.2 † / §7) -------------------------------------------

describe("GET /api/admin/preview/posts/:id — draft serialization (§4.2 / §7)", () => {
  it("serializes the DRAFT body with resolved media for an admin and a preview token", async () => {
    const INLINE = "33333333-3333-3333-3333-333333333333";
    await insertMedia(INLINE, "media/draft-inline.webp");
    const created = await createPost({
      slug: "preview-me",
      title: "Preview",
      draft_body: [{ type: "media", media_id: INLINE }, PARA("draft only")],
    });
    const id = created.body.data.id;

    // Admin bearer path.
    const asAdmin = await request(app)
      .get(`/api/admin/preview/posts/${id}`)
      .set(...AUTH);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.body).toHaveLength(2);
    expect(asAdmin.body.media[INLINE]).toEqual({
      url: `https://${CDN_DOMAIN}/media/draft-inline.webp`,
      alt: null,
    });

    // Preview-token path (no admin bearer).
    const token = mintPreviewToken().token;
    const asPreview = await request(app).get(
      `/api/admin/preview/posts/${id}?preview=${token}`
    );
    expect(asPreview.status).toBe(200);
    expect(asPreview.body.body[1]).toEqual({ type: "paragraph", text: "draft only" });

    // No token at all → 401.
    expect((await request(app).get(`/api/admin/preview/posts/${id}`)).status).toBe(401);
  });
});
