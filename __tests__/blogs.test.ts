import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Blogs v1.13 integration tests — named blogs table, admin CRUD, post
 * assignment, public `?blog=` filtering, and publish-time section validation.
 * Real routers + services against a throwaway Postgres 15 cluster (unix-socket
 * only, under /tmp, per agent-pre-checks.md); the pg client is given an explicit
 * `user` because it does not infer the OS user the way psql does.
 *
 * NO AWS is touched: `src/aws/s3Service` is FULLY MOCKED (publish triggers the
 * media GC pass, which HEAD/tags S3) and the Cognito verifier is mocked so
 * `requireAdmin` passes with a bearer token.
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
import adminBlogsRouter from "../src/routers/adminBlogsRouter";
import adminPostsRouter from "../src/routers/adminPostsRouter";
import postsRouter from "../src/routers/postsRouter";
import adminPagesRouter from "../src/routers/adminPagesRouter";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import adminPublishRouter from "../src/routers/adminPublishRouter";
import { failure } from "../src/utils/envelope";

const mockVerify = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55464"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_blogs_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task599");
const CDN_DOMAIN = "media-test.benkile.com";

const ADMIN_PAYLOAD = { sub: "admin-sub-599", "cognito:groups": ["admins"] };
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
  app.use("/api/admin", adminBlogsRouter);
  app.use("/api/admin", adminPostsRouter);
  app.use("/api/admin", adminPagesRouter);
  app.use("/api/admin", adminSectionsRouter);
  app.use("/api/admin", adminPublishRouter);
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
  // Clean slate. Deleting pages cascades to sections/items; posts + blogs
  // are independent tables.
  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("pages").del();
  await getDb()("posts").del();
  await getDb()("blogs").del();
});

// ---- helpers ---------------------------------------------------------------

async function createBlog(body: Record<string, unknown>) {
  return request(app).post("/api/admin/blogs").set(...AUTH).send(body);
}

async function createPost(body: Record<string, unknown>) {
  return request(app).post("/api/admin/posts").set(...AUTH).send(body);
}

async function publishPost(id: string) {
  return request(app).post(`/api/admin/posts/${id}/publish`).set(...AUTH).send({});
}

// ---- auth (§4.2 / §5.3) -----------------------------------------------------

describe("auth guard", () => {
  it("401s an unauthenticated request", async () => {
    expect((await request(app).get("/api/admin/blogs")).status).toBe(401);
  });

  it("403s a valid token not in the admins group", async () => {
    mockVerify.mockResolvedValue({ sub: "x", "cognito:groups": ["users"] });
    expect((await request(app).get("/api/admin/blogs").set(...AUTH)).status).toBe(403);
  });
});

// ---- admin CRUD + envelope --------------------------------------------------

describe("admin blogs CRUD (envelope, post_count, name order)", () => {
  it("creates, lists (by name with post_count), patches, and deletes", async () => {
    const code = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const food = (await createBlog({ slug: "food", name: "Food" })).body.data;
    expect(code.slug).toBe("code");
    expect(code.name).toBe("Code");

    // Two posts on Code, none on Food.
    await createPost({ slug: "p1", title: "P1", blog_id: code.id });
    await createPost({ slug: "p2", title: "P2", blog_id: code.id });

    const list = await request(app).get("/api/admin/blogs").set(...AUTH);
    expect(list.status).toBe(200);
    expect(list.body.status).toBe("ok");
    const blogs = list.body.data.blogs;
    // Ordered by name: Code, Food.
    expect(blogs.map((b: { slug: string }) => b.slug)).toEqual(["code", "food"]);
    expect(blogs[0]).toMatchObject({ slug: "code", name: "Code", post_count: 2 });
    expect(blogs[1]).toMatchObject({ slug: "food", name: "Food", post_count: 0 });

    // Patch under the precondition.
    const patch = await request(app)
      .patch(`/api/admin/blogs/${food.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: food.updated_at, name: "Food & Drink", slug: "food-drink" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.name).toBe("Food & Drink");
    expect(patch.body.data.slug).toBe("food-drink");

    // Delete.
    const del = await request(app).delete(`/api/admin/blogs/${food.id}`).set(...AUTH);
    expect(del.status).toBe(200);
    const after = await request(app).get("/api/admin/blogs").set(...AUTH);
    expect(after.body.data.blogs.map((b: { slug: string }) => b.slug)).toEqual(["code"]);
  });

  it("rejects an invalid slug (400) and a duplicate slug (409)", async () => {
    for (const bad of ["Code", "with space", "under_score", ""]) {
      expect((await createBlog({ slug: bad, name: "X" })).status).toBe(400);
    }
    expect((await createBlog({ slug: "code" })).status).toBe(400); // missing name

    expect((await createBlog({ slug: "code", name: "Code" })).status).toBe(201);
    const dup = await createBlog({ slug: "code", name: "Again" });
    expect(dup.status).toBe(409);
  });

  it("404s a PATCH/DELETE for an unknown id", async () => {
    const ghost = "99999999-9999-9999-9999-999999999999";
    const patch = await request(app)
      .patch(`/api/admin/blogs/${ghost}`)
      .set(...AUTH)
      .send({ expected_updated_at: new Date().toISOString(), name: "x" });
    expect(patch.status).toBe(404);
    expect((await request(app).delete(`/api/admin/blogs/${ghost}`).set(...AUTH)).status).toBe(404);
  });
});

// ---- optimistic concurrency (§4.5, identical to pages) ----------------------

describe("optimistic concurrency (§4.5)", () => {
  it("409s on a stale expected_updated_at and performs no write", async () => {
    const blog = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const stale = new Date(new Date(blog.updated_at).getTime() - 60000).toISOString();
    const res = await request(app)
      .patch(`/api/admin/blogs/${blog.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: stale, name: "Changed" });
    expect(res.status).toBe(409);
    const list = await request(app).get("/api/admin/blogs").set(...AUTH);
    expect(list.body.data.blogs[0].name).toBe("Code");
  });

  it("400s a PATCH missing expected_updated_at", async () => {
    const blog = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const res = await request(app)
      .patch(`/api/admin/blogs/${blog.id}`)
      .set(...AUTH)
      .send({ name: "Changed" });
    expect(res.status).toBe(400);
  });

  it("409s renaming a blog onto another blog's slug", async () => {
    await createBlog({ slug: "code", name: "Code" });
    const food = (await createBlog({ slug: "food", name: "Food" })).body.data;
    const res = await request(app)
      .patch(`/api/admin/blogs/${food.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: food.updated_at, slug: "code" });
    expect(res.status).toBe(409);
  });
});

// ---- delete unassigns posts -------------------------------------------------

describe("delete unassigns posts (never deletes them)", () => {
  it("nulls blog_id on assigned posts when the blog is deleted", async () => {
    const code = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const post = (await createPost({ slug: "keep-me", title: "Keep", blog_id: code.id })).body.data;
    expect(post.blog_id).toBe(code.id);

    const del = await request(app).delete(`/api/admin/blogs/${code.id}`).set(...AUTH);
    expect(del.status).toBe(200);

    // The post still exists, now unassigned.
    const one = await request(app).get(`/api/admin/posts/${post.id}`).set(...AUTH);
    expect(one.status).toBe(200);
    expect(one.body.data.blog_id).toBeNull();
    expect(one.body.data.blog).toBeNull();
  });
});

// ---- post blog assignment ---------------------------------------------------

describe("post blog assignment (admin)", () => {
  it("assigns on create, resolves blog on GET list + GET one", async () => {
    const code = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const created = await createPost({ slug: "hello", title: "Hello", blog_id: code.id });
    expect(created.status).toBe(201);
    expect(created.body.data.blog_id).toBe(code.id);

    const list = await request(app).get("/api/admin/posts").set(...AUTH);
    const item = list.body.data.posts.find((p: { slug: string }) => p.slug === "hello");
    expect(item.blog_id).toBe(code.id);
    expect(item.blog).toEqual({ slug: "code", name: "Code" });

    const one = await request(app).get(`/api/admin/posts/${created.body.data.id}`).set(...AUTH);
    expect(one.body.data.blog).toEqual({ slug: "code", name: "Code" });
  });

  it("400s a blog_id that references no blog (create and patch)", async () => {
    const ghost = "99999999-9999-9999-9999-999999999999";
    const bad = await createPost({ slug: "bad", title: "Bad", blog_id: ghost });
    expect(bad.status).toBe(400);

    const created = await createPost({ slug: "ok", title: "OK" });
    const cur = await request(app).get(`/api/admin/posts/${created.body.data.id}`).set(...AUTH);
    const patch = await request(app)
      .patch(`/api/admin/posts/${created.body.data.id}`)
      .set(...AUTH)
      .send({ expected_updated_at: cur.body.data.updated_at, blog_id: ghost });
    expect(patch.status).toBe(400);
  });

  it("re-assigns and un-assigns via PATCH (blog_id: null)", async () => {
    const code = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const created = await createPost({ slug: "movable", title: "Movable" });
    const id = created.body.data.id;
    expect(created.body.data.blog_id).toBeNull();

    let cur = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    const assign = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({ expected_updated_at: cur.body.data.updated_at, blog_id: code.id });
    expect(assign.status).toBe(200);
    expect(assign.body.data.blog_id).toBe(code.id);

    cur = await request(app).get(`/api/admin/posts/${id}`).set(...AUTH);
    const unassign = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...AUTH)
      .send({ expected_updated_at: cur.body.data.updated_at, blog_id: null });
    expect(unassign.status).toBe(200);
    expect(unassign.body.data.blog_id).toBeNull();
  });
});

// ---- public ?blog= filter + blog on summaries/single ------------------------

describe("public ?blog= filter (§4.1)", () => {
  async function publishInBlog(slug: string, blogId: string | null) {
    const created = await createPost({ slug, title: slug, blog_id: blogId ?? undefined });
    await publishPost(created.body.data.id);
    return created.body.data.id;
  }

  it("filters by blog slug, composes with tag, and carries blog on summaries + single", async () => {
    const code = (await createBlog({ slug: "code", name: "Code" })).body.data;
    const food = (await createBlog({ slug: "food", name: "Food" })).body.data;

    // Two Code posts (one tagged), one Food post, one unassigned.
    const c1 = await createPost({ slug: "c1", title: "C1", blog_id: code.id, tags: ["ts"] });
    await publishPost(c1.body.data.id);
    await publishInBlog("c2", code.id);
    await publishInBlog("f1", food.id);
    await publishInBlog("u1", null);

    // ?blog=code → only Code posts.
    const codeList = await request(app).get("/api/posts?blog=code");
    expect(codeList.status).toBe(200);
    expect(codeList.body.posts.map((p: { slug: string }) => p.slug).sort()).toEqual(["c1", "c2"]);
    for (const p of codeList.body.posts) {
      expect(p.blog).toEqual({ slug: "code", name: "Code" });
    }

    // ?blog=code&tag=ts composes.
    const composed = await request(app).get("/api/posts?blog=code&tag=ts");
    expect(composed.body.posts.map((p: { slug: string }) => p.slug)).toEqual(["c1"]);

    // Unassigned post carries blog: null.
    const all = await request(app).get("/api/posts");
    const unassigned = all.body.posts.find((p: { slug: string }) => p.slug === "u1");
    expect(unassigned.blog).toBeNull();

    // Single published post carries its blog.
    const single = await request(app).get("/api/posts/f1");
    expect(single.status).toBe(200);
    expect(single.body.blog).toEqual({ slug: "food", name: "Food" });
    const singleU = await request(app).get("/api/posts/u1");
    expect(singleU.body.blog).toBeNull();
  });

  it("returns an empty page (not an error) for an unknown blog slug", async () => {
    await publishInBlog("solo", null);
    const res = await request(app).get("/api/posts?blog=does-not-exist");
    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });
});

// ---- publish-time section blog validation -----------------------------------

describe("publish-time blog section validation (ref_validation → 422)", () => {
  async function seedHomeWithBlogSection(blogSlug: string | undefined) {
    const page = (
      await request(app)
        .post("/api/admin/pages")
        .set(...AUTH)
        .send({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
    ).body.data;
    const data: Record<string, unknown> = { limit: 5 };
    if (blogSlug !== undefined) data.blog = blogSlug;
    await request(app)
      .post("/api/admin/sections")
      .set(...AUTH)
      .send({ type: "blog", data, page_id: page.id });
    return page;
  }

  it("draft-lenient: a blog section can HOLD an unknown slug (write succeeds)", async () => {
    // The section write accepts any string for `blog` (§3.9); only publish gates it.
    const page = (
      await request(app)
        .post("/api/admin/pages")
        .set(...AUTH)
        .send({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
    ).body.data;
    const write = await request(app)
      .post("/api/admin/sections")
      .set(...AUTH)
      .send({ type: "blog", data: { limit: 5, blog: "not-a-real-blog" }, page_id: page.id });
    expect(write.status).toBe(201);
  });

  it("422s publish when a blog section references a non-existent blog", async () => {
    await seedHomeWithBlogSection("ghost-blog");
    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(422);
    expect(pub.body.errorMsg).toMatch(/ghost-blog/);
  });

  it("publishes when the blog section's slug matches an existing blog", async () => {
    await createBlog({ slug: "code", name: "Code" });
    await seedHomeWithBlogSection("code");
    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);
  });

  it("publishes when the blog section pins no blog (blog unset)", async () => {
    await seedHomeWithBlogSection(undefined);
    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);
  });
});
