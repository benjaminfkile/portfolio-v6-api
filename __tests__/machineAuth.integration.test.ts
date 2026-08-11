import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express, NextFunction, Request, Response } from "express";
import request from "supertest";

/**
 * Machine Auth v1.15 — reachability integration tests (task #601 DoD). Exercises
 * the REAL admin routers + services against a throwaway Postgres 15 cluster
 * (unix-socket only, under /tmp, per agent-pre-checks.md), proving the actual
 * middleware wiring: a machine client-credentials ACCESS token reaches ONLY the
 * narrow surface (posts CRUD/publish, the post-image media routes, GET
 * /api/admin/blogs) and is blocked 403 everywhere else, while a human admin is
 * unaffected.
 *
 * NO AWS is touched: both Cognito verifiers and `src/aws/s3Service` are mocked.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
  verifyMachineAccessToken: jest.fn(),
}));

jest.mock("../src/aws/s3Service", () => ({
  initS3: jest.fn(),
  getBucketName: jest.fn(() => "bk-portfolio-v6-test"),
  buildMediaKey: jest.fn(
    (uuid: string, filename: string) => `media/${uuid}/${filename}`
  ),
  generatePresignedUploadUrl: jest.fn().mockResolvedValue({
    url: "https://s3.example/put",
    headers: { "Content-Type": "image/png" },
  }),
  headObject: jest.fn().mockResolvedValue({ contentLength: 123 }),
  putObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

import {
  verifyAdminIdToken,
  verifyMachineAccessToken,
} from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminPostsRouter from "../src/routers/adminPostsRouter";
import adminMediaRouter from "../src/routers/adminMediaRouter";
import adminBlogsRouter from "../src/routers/adminBlogsRouter";
import adminPagesRouter from "../src/routers/adminPagesRouter";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import adminPublishRouter from "../src/routers/adminPublishRouter";
import adminIntegrationsRouter from "../src/routers/adminIntegrationsRouter";
import { failure } from "../src/utils/envelope";

const mockVerifyAdmin = verifyAdminIdToken as jest.Mock;
const mockVerifyMachine = verifyMachineAccessToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55445"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_machine_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task601");
const CDN_DOMAIN = "media-test.benkile.com";

const POOL_ID = "us-east-1_testpool";
const ADMIN_CLIENT_ID = "test-admin-client";
const MACHINE_CLIENT_ID = "test-machine-client";
const MACHINE_SCOPE = "portfolio-api/machine";

const ADMIN_PAYLOAD = { sub: "admin-sub-601", "cognito:groups": ["admins"] };
const ADMIN_AUTH = ["Authorization", "Bearer admin.id.token"] as const;
const MACHINE_AUTH = ["Authorization", "Bearer machine.access.token"] as const;

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

/** `machineOn` toggles the feature: when false, machine_client_id is unset. */
function buildApp(machineOn: boolean): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", {
    cognito_user_pool_id: POOL_ID,
    cognito_client_id: ADMIN_CLIENT_ID,
    cdn_domain: CDN_DOMAIN,
    machine_client_id: machineOn ? MACHINE_CLIENT_ID : undefined,
    machine_scope: MACHINE_SCOPE,
  });
  app.use("/api/admin", adminPagesRouter);
  app.use("/api/admin", adminSectionsRouter);
  app.use("/api/admin", adminPublishRouter);
  app.use("/api/admin", adminMediaRouter);
  app.use("/api/admin", adminPostsRouter);
  app.use("/api/admin", adminBlogsRouter);
  app.use("/api/admin", adminIntegrationsRouter);
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(500).json(failure(err.message));
  });
  return app;
}

let app: Express; // feature ON
let appOff: Express; // feature OFF

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
  app = buildApp(true);
  appOff = buildApp(false);
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(async () => {
  // A machine access token: admin ID-token verify rejects it (wrong token_use /
  // client), the machine access-token verify accepts it with the scope.
  mockVerifyAdmin.mockReset();
  mockVerifyMachine.mockReset();
  mockVerifyAdmin.mockImplementation(async (token: string) => {
    if (token === "admin.id.token") return ADMIN_PAYLOAD;
    throw new Error("not an admin id token");
  });
  mockVerifyMachine.mockImplementation(async (token: string) => {
    if (token === "machine.access.token") {
      return {
        sub: MACHINE_CLIENT_ID,
        client_id: MACHINE_CLIENT_ID,
        scope: `openid ${MACHINE_SCOPE}`,
      };
    }
    throw new Error("not a machine access token");
  });
});

afterEach(async () => {
  const db = getDb();
  await db("posts").del();
  await db("media_assets").del();
  await db("blogs").del();
});

describe("machine token REACHES the narrow surface", () => {
  it("posts CRUD + publish, with publish attributed as machine:<client_id>", async () => {
    // Create (POST /posts)
    const created = await request(app)
      .post("/api/admin/posts")
      .set(...MACHINE_AUTH)
      .send({
        slug: "bot-post",
        title: "By the bot",
        draft_body: [{ type: "paragraph", text: "hello from the bot" }],
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    // List (GET /posts)
    const list = await request(app).get("/api/admin/posts").set(...MACHINE_AUTH);
    expect(list.status).toBe(200);

    // Read one (GET /posts/:id)
    const one = await request(app)
      .get(`/api/admin/posts/${id}`)
      .set(...MACHINE_AUTH);
    expect(one.status).toBe(200);

    // Update (PATCH /posts/:id) — precondition required
    const patch = await request(app)
      .patch(`/api/admin/posts/${id}`)
      .set(...MACHINE_AUTH)
      .send({
        expected_updated_at: one.body.data.updated_at,
        title: "Edited by the bot",
      });
    expect(patch.status).toBe(200);

    // Publish (POST /posts/:id/publish)
    const pub = await request(app)
      .post(`/api/admin/posts/${id}/publish`)
      .set(...MACHINE_AUTH)
      .send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.published_at).not.toBeNull();

    // Attribution is persisted as machine:<client_id>.
    const row = await getDb()("posts").where({ id }).first();
    expect(row.published_by).toBe(`machine:${MACHINE_CLIENT_ID}`);

    // Unpublish (POST /posts/:id/unpublish) is reachable too.
    const unpub = await request(app)
      .post(`/api/admin/posts/${id}/unpublish`)
      .set(...MACHINE_AUTH)
      .send({});
    expect(unpub.status).toBe(200);
  });

  it("the post-image media routes: upload-url, confirm, list", async () => {
    const presign = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...MACHINE_AUTH)
      .send({ filename: "cover.png", mime: "image/png", size: 1024 });
    expect(presign.status).toBe(201);
    const mediaId = presign.body.data.id as string;

    const confirm = await request(app)
      .post(`/api/admin/media/${mediaId}/confirm`)
      .set(...MACHINE_AUTH)
      .send({});
    expect(confirm.status).toBe(200);

    const listed = await request(app)
      .get("/api/admin/media")
      .set(...MACHINE_AUTH);
    expect(listed.status).toBe(200);
  });

  it("GET /api/admin/blogs (read-only) so the bot can resolve a blog_id", async () => {
    const res = await request(app).get("/api/admin/blogs").set(...MACHINE_AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.blogs)).toBe(true);
  });
});

describe("machine token is BLOCKED (403) everywhere else", () => {
  const cases: Array<[string, () => request.Test]> = [
    ["GET /api/admin/pages", () => request(app).get("/api/admin/pages")],
    ["GET /api/admin/sections", () => request(app).get("/api/admin/sections")],
    [
      "GET /api/admin/integrations",
      () => request(app).get("/api/admin/integrations"),
    ],
    ["POST /api/admin/publish (site)", () => request(app).post("/api/admin/publish")],
    ["GET /api/admin/versions", () => request(app).get("/api/admin/versions")],
    ["POST /api/admin/media/sweep", () => request(app).post("/api/admin/media/sweep")],
    [
      "POST /api/admin/blogs (write)",
      () =>
        request(app)
          .post("/api/admin/blogs")
          .send({ slug: "b", name: "B" }),
    ],
  ];

  it.each(cases)("%s → 403 for a machine token", async (_label, mkReq) => {
    const res = await mkReq().set(...MACHINE_AUTH).send();
    expect(res.status).toBe(403);
  });
});

describe("human admin is unaffected", () => {
  it("admin reaches an admin-only route (site publish) and posts publish is attributed to the admin sub", async () => {
    // Admin-only route still works for a real admin.
    const versions = await request(app)
      .get("/api/admin/versions")
      .set(...ADMIN_AUTH);
    expect(versions.status).toBe(200);

    // Admin publish records the admin's Cognito sub, not a machine id.
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

describe("feature OFF (machine_client_id unset) — zero behavior change", () => {
  it("a machine token is rejected on the posts surface exactly as before (401)", async () => {
    const res = await request(appOff)
      .post("/api/admin/posts")
      .set(...MACHINE_AUTH)
      .send({ slug: "x", title: "x", draft_body: [] });
    expect(res.status).toBe(401);
    // With the feature off the machine verifier is never consulted at all.
    expect(mockVerifyMachine).not.toHaveBeenCalled();
  });

  it("an admin still works on the posts surface with the feature off", async () => {
    const res = await request(appOff)
      .get("/api/admin/posts")
      .set(...ADMIN_AUTH);
    expect(res.status).toBe(200);
  });
});
