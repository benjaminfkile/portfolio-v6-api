import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Media service integration tests — TECH_SPEC_V1.md §6.7, §6.8, §6.9 (task #440
 * DoD). Real routers + services + a throwaway Postgres 15 cluster (unix-socket
 * only, under /tmp, per agent-pre-checks.md); the pg client is given an explicit
 * `user` because it does not infer the OS user the way psql does.
 *
 * NO AWS is touched: `src/aws/s3Service` is FULLY MOCKED (hard rule) so the
 * presign/head/tag/delete calls are asserted against, and the Cognito verifier is
 * mocked so `requireAdmin` passes with a bearer token.
 *
 * Covered: upload-url pins Cache-Control/Content-Type/Tagging into the signature;
 * pending→confirm records size, untags, stamps confirmed_at; the GC reference
 * scan across all four sources (working set, versions, post draft/published body,
 * post cover); rescue; row reaping on HEAD 404; and GC running after publish.
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
  headObject: jest.fn(),
  putObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import * as s3 from "../src/aws/s3Service";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminSectionsRouter from "../src/routers/adminSectionsRouter";
import adminPublishRouter from "../src/routers/adminPublishRouter";
import adminMediaRouter from "../src/routers/adminMediaRouter";
import { failure } from "../src/utils/envelope";
import {
  MEDIA_CACHE_CONTROL,
  PENDING_TAGGING,
  UPLOAD_URL_TTL_SECONDS,
} from "../src/config/media";
import { ensureHomePage } from "./helpers/pages";

const mockVerify = verifyAdminIdToken as jest.Mock;
const mockPresign = s3.generatePresignedUploadUrl as jest.Mock;
const mockHead = s3.headObject as jest.Mock;
const mockPutTags = s3.putObjectTags as jest.Mock;
const mockDeleteTags = s3.deleteObjectTags as jest.Mock;
const mockDeleteObject = s3.deleteObject as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55440"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_media_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task440");

const ADMIN_PAYLOAD = { sub: "admin-sub-440", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

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
    cdn_domain: "media-test.benkile.com",
  });
  app.use("/api/admin", adminSectionsRouter);
  app.use("/api/admin", adminPublishRouter);
  app.use("/api/admin", adminMediaRouter);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
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
  mockPresign.mockReset();
  mockPresign.mockImplementation(async (p: { tagging: string; contentType: string; cacheControl: string }) => ({
    url: "https://bk-portfolio-v6-test.s3.amazonaws.com/put-signed",
    headers: {
      "Content-Type": p.contentType,
      "Cache-Control": p.cacheControl,
      "x-amz-tagging": p.tagging,
    },
  }));
  mockHead.mockReset();
  mockPutTags.mockClear();
  mockDeleteTags.mockClear();
  mockDeleteObject.mockClear();

  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("page_versions").del();
  await getDb()("posts").del();
  await getDb()("media_assets").del();
});

// ---- helpers ---------------------------------------------------------------

async function insertAsset(overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await getDb()("media_assets")
    .insert({
      s3_key: `media/${overrides.key ?? Math.random().toString(36).slice(2)}/f.webp`,
      mime: "image/webp",
      bytes: 1000,
      confirmed_at: getDb().fn.now(),
      ...(overrides.s3_key ? { s3_key: overrides.s3_key } : {}),
      ...(overrides.confirmed_at !== undefined
        ? { confirmed_at: overrides.confirmed_at }
        : {}),
      ...(overrides.unreferenced_at !== undefined
        ? { unreferenced_at: overrides.unreferenced_at }
        : {}),
      ...(overrides.created_at !== undefined
        ? { created_at: overrides.created_at }
        : {}),
    })
    .returning(["id"]);
  return row.id;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

// ---- upload-url (§6.7, acceptance 1401) ------------------------------------

describe("POST /api/admin/media/upload-url (§6.7)", () => {
  it("pins Cache-Control/Content-Type/Tagging into the signature and inserts a pending row", async () => {
    const res = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...AUTH)
      .send({ filename: "hero shot.webp", mime: "image/webp", size: 12345 });

    expect(res.status).toBe(201);
    expect(res.body.data.upload_url).toContain("put-signed");
    expect(res.body.data.expires_in).toBe(UPLOAD_URL_TTL_SECONDS);
    // The exact header the client must echo byte-for-byte (§6.7 gotcha).
    expect(res.body.data.upload_headers["x-amz-tagging"]).toBe(PENDING_TAGGING);
    expect(res.body.data.upload_headers["Cache-Control"]).toBe(MEDIA_CACHE_CONTROL);
    expect(res.body.data.upload_headers["Content-Type"]).toBe("image/webp");

    // The presign call pinned all three into the signature.
    expect(mockPresign).toHaveBeenCalledTimes(1);
    const presignArgs = mockPresign.mock.calls[0][0];
    expect(presignArgs).toMatchObject({
      contentType: "image/webp",
      cacheControl: MEDIA_CACHE_CONTROL,
      tagging: PENDING_TAGGING,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    // Key is media/{uuid}/{filename} with directory components stripped.
    expect(presignArgs.key).toMatch(/^media\/[0-9a-f-]{36}\/hero shot\.webp$/);

    // A pending row (confirmed_at null) was inserted with the same key.
    const row = await getDb()("media_assets").where({ id: res.body.data.id }).first();
    expect(row.confirmed_at).toBeNull();
    expect(row.s3_key).toBe(presignArgs.key);
    expect(Number(row.bytes)).toBe(12345);
  });

  it("rejects a disallowed mime (400) and never mints a URL", async () => {
    const res = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...AUTH)
      .send({ filename: "x.exe", mime: "application/x-msdownload", size: 10 });
    expect(res.status).toBe(400);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("rejects an over-cap size (400)", async () => {
    const res = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...AUTH)
      .send({ filename: "big.mp4", mime: "video/mp4", size: 5_000_000_000 });
    expect(res.status).toBe(400);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("requires an admin token (401)", async () => {
    const res = await request(app)
      .post("/api/admin/media/upload-url")
      .send({ filename: "a.webp", mime: "image/webp", size: 10 });
    expect(res.status).toBe(401);
  });
});

// ---- confirm (§6.7, acceptance 1402) ---------------------------------------

describe("POST /api/admin/media/:id/confirm (§6.7)", () => {
  it("HEADs the object, records the true size, untags, and stamps confirmed_at", async () => {
    const created = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...AUTH)
      .send({ filename: "a.webp", mime: "image/webp", size: 999 });
    const { id, s3_key } = created.body.data;

    mockHead.mockResolvedValueOnce({ contentLength: 8080, contentType: "image/webp" });

    const res = await request(app)
      .post(`/api/admin/media/${id}/confirm`)
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.confirmed_at).not.toBeNull();
    expect(res.body.data.bytes).toBe(8080); // true size, not the declared 999
    expect(res.body.data.orphaned).toBe(false);

    // HEADed and untagged the exact key.
    expect(mockHead).toHaveBeenCalledWith(s3_key);
    expect(mockDeleteTags).toHaveBeenCalledWith(s3_key);

    const row = await getDb()("media_assets").where({ id }).first();
    expect(row.confirmed_at).not.toBeNull();
    expect(Number(row.bytes)).toBe(8080);
  });

  it("returns 404 when the object never landed (HEAD 404)", async () => {
    const created = await request(app)
      .post("/api/admin/media/upload-url")
      .set(...AUTH)
      .send({ filename: "a.webp", mime: "image/webp", size: 999 });
    const { id } = created.body.data;

    mockHead.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/admin/media/${id}/confirm`)
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(404);
    expect(mockDeleteTags).not.toHaveBeenCalled();

    // Row stays pending so the client can retry.
    const row = await getDb()("media_assets").where({ id }).first();
    expect(row.confirmed_at).toBeNull();
  });
});

// ---- GC reference scan across all four sources (§6.9, acceptance 1403) ------

describe("POST /api/admin/media/sweep — reference scan (§6.9)", () => {
  it("keeps media referenced by any of the four sources and orphans only the truly unreferenced", async () => {
    const OLD = daysAgo(40); // past the 30-day grace so age is never the reason kept

    // Distinct assets, one per reference source, all old + confirmed.
    const wsId = await insertAsset({ s3_key: "media/ws/f.webp", created_at: OLD });
    const itemId = await insertAsset({ s3_key: "media/item/f.webp", created_at: OLD });
    const versionId = await insertAsset({ s3_key: "media/ver/f.webp", created_at: OLD });
    const draftId = await insertAsset({ s3_key: "media/draft/f.webp", created_at: OLD });
    const publishedId = await insertAsset({ s3_key: "media/pub/f.webp", created_at: OLD });
    const coverId = await insertAsset({ s3_key: "media/cover/f.webp", created_at: OLD });
    // The only unreferenced, old, confirmed asset → the one that must be orphaned.
    const orphanId = await insertAsset({ s3_key: "media/orphan/f.webp", created_at: OLD });

    // 1. Working set: a section + an item, each referencing an asset.
    const pageId = await ensureHomePage(getDb());
    const [section] = await getDb()("sections")
      .insert({
        type: "hero",
        position: 0,
        data: { title: "H", background_media_id: wsId },
        page_id: pageId,
      })
      .returning(["id"]);
    await getDb()("section_items").insert({
      section_id: section.id,
      position: 0,
      data: { media_id: itemId },
    });

    // 2. A retained published version whose document references an asset.
    await getDb()("page_versions").insert({
      version: 1,
      document: { version: 1, sections: [{ data: { media_id: versionId } }], media: {} },
      published_by: "admin",
    });

    // 3 + 4. A post: draft body + published body media blocks, and a cover.
    await getDb()("posts").insert({
      slug: "p",
      title: "P",
      cover_media_id: coverId,
      draft_body: JSON.stringify([{ type: "media", media_id: draftId }]),
      published_body: JSON.stringify([{ type: "media", media_id: publishedId }]),
    });

    const res = await request(app).post("/api/admin/media/sweep").set(...AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.orphaned).toEqual([orphanId]);
    expect(res.body.data.rescued).toEqual([]);
    expect(res.body.data.deleted).toEqual([]);

    // Only the orphan was tagged, and with state=orphaned on its key.
    expect(mockPutTags).toHaveBeenCalledTimes(1);
    expect(mockPutTags).toHaveBeenCalledWith("media/orphan/f.webp", { state: "orphaned" });

    // DB: every referenced asset stays clean; the orphan is stamped.
    for (const id of [wsId, itemId, versionId, draftId, publishedId, coverId]) {
      const row = await getDb()("media_assets").where({ id }).first();
      expect(row.unreferenced_at).toBeNull();
    }
    const orphan = await getDb()("media_assets").where({ id: orphanId }).first();
    expect(orphan.unreferenced_at).not.toBeNull();

    // Listing surfaces orphan status + a scheduled deletion date 7 days out.
    const list = await request(app).get("/api/admin/media").set(...AUTH);
    const listedOrphan = list.body.data.assets.find((a: { id: string }) => a.id === orphanId);
    expect(listedOrphan.orphaned).toBe(true);
    expect(new Date(listedOrphan.scheduled_deletion_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not orphan an unreferenced asset that is still inside the 30-day grace", async () => {
    await insertAsset({ s3_key: "media/young/f.webp", created_at: daysAgo(5) });
    const res = await request(app).post("/api/admin/media/sweep").set(...AUTH).send({});
    expect(res.body.data.orphaned).toEqual([]);
    expect(mockPutTags).not.toHaveBeenCalled();
  });

  it("never orphans a pending (unconfirmed) asset — that is S3's job", async () => {
    await insertAsset({
      s3_key: "media/pending/f.webp",
      confirmed_at: null,
      created_at: daysAgo(40),
    });
    const res = await request(app).post("/api/admin/media/sweep").set(...AUTH).send({});
    expect(res.body.data.orphaned).toEqual([]);
  });
});

// ---- rescue + reap (§6.9, acceptance 1404) ---------------------------------

describe("POST /api/admin/media/sweep — rescue & reap (§6.9)", () => {
  it("rescues a re-referenced orphan: clears the column and drops the tag", async () => {
    const rescuedId = await insertAsset({
      s3_key: "media/rescue/f.webp",
      created_at: daysAgo(40),
      unreferenced_at: daysAgo(2),
    });
    // Re-reference it from the working set.
    await getDb()("sections").insert({
      type: "hero",
      position: 0,
      data: { title: "H", background_media_id: rescuedId },
      page_id: await ensureHomePage(getDb()),
    });

    const res = await request(app).post("/api/admin/media/sweep").set(...AUTH).send({});
    expect(res.body.data.rescued).toEqual([rescuedId]);
    expect(mockDeleteTags).toHaveBeenCalledWith("media/rescue/f.webp");

    const row = await getDb()("media_assets").where({ id: rescuedId }).first();
    expect(row.unreferenced_at).toBeNull();
  });

  it("reaps a row whose orphaned object has lifecycle-expired (HEAD 404)", async () => {
    const goneId = await insertAsset({
      s3_key: "media/gone/f.webp",
      created_at: daysAgo(40),
      unreferenced_at: daysAgo(10),
    });
    mockHead.mockResolvedValueOnce(null); // S3 already expired the object

    const res = await request(app).post("/api/admin/media/sweep").set(...AUTH).send({});
    expect(res.body.data.deleted).toEqual([goneId]);
    expect(mockHead).toHaveBeenCalledWith("media/gone/f.webp");

    const row = await getDb()("media_assets").where({ id: goneId }).first();
    expect(row).toBeUndefined();
  });

  it("keeps an orphaned row whose object still exists (HEAD 200)", async () => {
    const stillId = await insertAsset({
      s3_key: "media/still/f.webp",
      created_at: daysAgo(40),
      unreferenced_at: daysAgo(1),
    });
    mockHead.mockResolvedValueOnce({ contentLength: 10, contentType: "image/webp" });

    const res = await request(app).post("/api/admin/media/sweep").set(...AUTH).send({});
    expect(res.body.data.deleted).toEqual([]);
    const row = await getDb()("media_assets").where({ id: stillId }).first();
    expect(row).toBeDefined();
  });
});

// ---- GC runs after publish (§6.9, acceptance 1404) -------------------------

describe("GC runs after a successful page publish (§6.9)", () => {
  it("orphans an old unreferenced asset as part of the publish request", async () => {
    const orphanId = await insertAsset({
      s3_key: "media/postpub/f.webp",
      created_at: daysAgo(40),
    });
    // A valid working set that does NOT reference the asset.
    await request(app)
      .post("/api/admin/sections")
      .set(...AUTH)
      .send({ type: "hero", data: { title: "Hello" } });

    const pub = await request(app).post("/api/admin/publish").set(...AUTH).send({});
    expect(pub.status).toBe(201);

    // The post-publish sweep tagged and stamped the orphan.
    expect(mockPutTags).toHaveBeenCalledWith("media/postpub/f.webp", { state: "orphaned" });
    const row = await getDb()("media_assets").where({ id: orphanId }).first();
    expect(row.unreferenced_at).not.toBeNull();
  });
});

// ---- delete (§4.2) ---------------------------------------------------------

describe("DELETE /api/admin/media/:id (§4.2)", () => {
  it("removes the S3 object and the row", async () => {
    const id = await insertAsset({ s3_key: "media/del/f.webp" });
    const res = await request(app).delete(`/api/admin/media/${id}`).set(...AUTH);
    expect(res.status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("media/del/f.webp");
    const row = await getDb()("media_assets").where({ id }).first();
    expect(row).toBeUndefined();
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .delete("/api/admin/media/99999999-9999-9999-9999-999999999999")
      .set(...AUTH);
    expect(res.status).toBe(404);
  });
});
