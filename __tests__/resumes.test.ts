import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough, Readable } from "stream";
import express, { Express } from "express";
import request from "supertest";

/**
 * Resume versions integration tests (task #92 DoD). Real routers + services +
 * a throwaway Postgres 15 cluster (unix-socket only, under /tmp, per
 * agent-pre-checks.md); the `pg` client is given an explicit `user` because it
 * does not infer the OS user the way psql does.
 *
 * NO AWS is touched: `src/aws/s3Service` is FULLY MOCKED (hard rule / §7 of
 * pre-checks) so the presign/head/get/delete calls are asserted against, and
 * the Cognito verifier is mocked so `requireAdmin` passes with a bearer token.
 *
 * Covered:
 *  - upload-url validation (non-pdf rejected, size cap, admin auth)
 *  - confirm flow (HEAD → record true size → stamp confirmed_at)
 *  - newest-confirmed selection (unconfirmed and pending are ignored; the newest
 *    confirmed row wins even when a fresher unconfirmed row exists)
 *  - delete promotes the next-newest (no "promotion" step required)
 *  - admin list shows all versions newest-first with per-version url + confirmed
 *  - public GET /api/resume raw shapes (available true/false) + Cache-Control
 *  - GET /api/resume/download attachment header + streams PDF from S3
 *  - GET /api/resume never 5xxes on unexpected error (degrade)
 *  - the media orphan sweep is provably unaffected by resume objects/rows
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
  generatePresignedUploadUrl: jest.fn(),
  headObject: jest.fn(),
  getObjectStream: jest.fn(),
  putObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import * as s3 from "../src/aws/s3Service";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminMediaRouter from "../src/routers/adminMediaRouter";
import adminResumesRouter from "../src/routers/adminResumesRouter";
import resumeRouter from "../src/routers/resumeRouter";
import { failure } from "../src/utils/envelope";
import {
  RESUME_CACHE_CONTROL,
  RESUME_MAX_BYTES,
  RESUME_MIME,
  RESUME_UPLOAD_URL_TTL_SECONDS,
} from "../src/config/resumes";

const mockVerify = verifyAdminIdToken as jest.Mock;
const mockPresign = s3.generatePresignedUploadUrl as jest.Mock;
const mockHead = s3.headObject as jest.Mock;
const mockGetStream = s3.getObjectStream as jest.Mock;
const mockPutTags = s3.putObjectTags as jest.Mock;
const mockDeleteObject = s3.deleteObject as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55492"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_resumes_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task92");

const ADMIN_PAYLOAD = { sub: "admin-sub-92", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;
const CDN_DOMAIN = "media-test.benkile.com";

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
  app.use("/api/admin", adminResumesRouter);
  app.use("/api/admin", adminMediaRouter);
  app.use("/api/resume", resumeRouter);
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
  mockPresign.mockReset();
  mockPresign.mockImplementation(
    async (p: {
      key: string;
      contentType: string;
      cacheControl: string;
      tagging?: string;
    }) => {
      const headers: Record<string, string> = {
        "Content-Type": p.contentType,
        "Cache-Control": p.cacheControl,
      };
      if (p.tagging) headers["x-amz-tagging"] = p.tagging;
      return {
        url: `https://bk-portfolio-v6-test.s3.amazonaws.com/${encodeURIComponent(p.key)}?sig`,
        headers,
      };
    }
  );
  mockHead.mockReset();
  mockGetStream.mockReset();
  mockPutTags.mockClear();
  mockDeleteObject.mockClear();

  await getDb()("resumes").del();
  // The media suite's tables — cleared so the orphan-sweep test starts empty.
  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("page_versions").del();
  await getDb()("posts").del();
  await getDb()("media_assets").del();
});

// ---- helpers --------------------------------------------------------------

async function uploadUrl(body: Record<string, unknown>): Promise<request.Response> {
  return request(app)
    .post("/api/admin/resumes/upload-url")
    .set(...AUTH)
    .send(body);
}

async function insertResume(overrides: {
  s3_key?: string;
  filename?: string;
  bytes?: number;
  confirmed_at?: string | null;
  created_at?: string;
  uploaded_by?: string;
} = {}): Promise<string> {
  // Passing `confirmed_at: null` explicitly must leave the column NULL — use
  // `in` rather than `??` so an intentional null is not clobbered by the
  // default.
  const confirmedAt = "confirmed_at" in overrides
    ? overrides.confirmed_at
    : new Date().toISOString();
  const [row] = await getDb()("resumes")
    .insert({
      s3_key:
        overrides.s3_key ??
        `resumes/${Math.random().toString(36).slice(2)}/resume.pdf`,
      filename: overrides.filename ?? "resume.pdf",
      bytes: overrides.bytes ?? 12_345,
      confirmed_at: confirmedAt,
      created_at: overrides.created_at ?? new Date().toISOString(),
      uploaded_by: overrides.uploaded_by ?? "admin-sub-92",
    })
    .returning(["id"]);
  return row.id;
}

// ---- upload-url (task #92 §6.7 mirror, DoD 349) ----------------------------

describe("POST /api/admin/resumes/upload-url", () => {
  it("pins Content-Type application/pdf + Cache-Control into the signature, inserts a pending row", async () => {
    const res = await uploadUrl({
      filename: "Ben Kile.pdf",
      size: 100_000,
    });

    expect(res.status).toBe(201);
    // The mock encodes the key when embedding it in the URL, so match the
    // encoded prefix rather than a literal slash.
    expect(res.body.data.upload_url).toContain("resumes");
    expect(res.body.data.expires_in).toBe(RESUME_UPLOAD_URL_TTL_SECONDS);
    expect(res.body.data.upload_headers["Content-Type"]).toBe(RESUME_MIME);
    expect(res.body.data.upload_headers["Cache-Control"]).toBe(
      RESUME_CACHE_CONTROL
    );
    // Resumes have no lifecycle rule → no x-amz-tagging pinned into the sig.
    expect(res.body.data.upload_headers["x-amz-tagging"]).toBeUndefined();

    expect(mockPresign).toHaveBeenCalledTimes(1);
    const presignArgs = mockPresign.mock.calls[0][0];
    expect(presignArgs).toMatchObject({
      contentType: RESUME_MIME,
      cacheControl: RESUME_CACHE_CONTROL,
      expiresInSeconds: RESUME_UPLOAD_URL_TTL_SECONDS,
    });
    // resumes/{uuid}/{safe-filename} — directory components stripped, filename
    // preserved (including spaces).
    expect(presignArgs.key).toMatch(/^resumes\/[0-9a-f-]{36}\/Ben Kile\.pdf$/);
    // Not tagged as pending: the tagging option must be absent/empty.
    expect(presignArgs.tagging ?? "").toBe("");

    const row = await getDb()("resumes").where({ id: res.body.data.id }).first();
    expect(row.confirmed_at).toBeNull();
    expect(row.s3_key).toBe(presignArgs.key);
    expect(row.filename).toBe("Ben Kile.pdf");
    expect(Number(row.bytes)).toBe(100_000);
    expect(row.uploaded_by).toBe("admin-sub-92");
  });

  it("rejects a non-PDF filename (400) and never mints a URL", async () => {
    for (const filename of ["resume.doc", "resume.pdf.jpg", "resume", "resume.PDf"]) {
      mockPresign.mockClear();
      const res = await uploadUrl({ filename, size: 100 });
      if (filename.toLowerCase().endsWith(".pdf")) {
        // "resume.PDf" — case-insensitive .pdf check accepts this one.
        expect(res.status).toBe(201);
      } else {
        expect(res.status).toBe(400);
        expect(mockPresign).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects an over-cap size (400) — > 10 MB is refused", async () => {
    const res = await uploadUrl({
      filename: "big.pdf",
      size: RESUME_MAX_BYTES + 1,
    });
    expect(res.status).toBe(400);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("accepts a size exactly at the 10 MB cap", async () => {
    const res = await uploadUrl({
      filename: "cap.pdf",
      size: RESUME_MAX_BYTES,
    });
    expect(res.status).toBe(201);
  });

  it("rejects a missing / non-positive size (400)", async () => {
    for (const size of [undefined, 0, -1, "not-a-number"]) {
      mockPresign.mockClear();
      const res = await uploadUrl({ filename: "x.pdf", size });
      expect(res.status).toBe(400);
      expect(mockPresign).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing filename (400)", async () => {
    const res = await uploadUrl({ size: 100 });
    expect(res.status).toBe(400);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("requires an admin token (401)", async () => {
    const res = await request(app)
      .post("/api/admin/resumes/upload-url")
      .send({ filename: "x.pdf", size: 100 });
    expect(res.status).toBe(401);
  });
});

// ---- confirm (task #92 §6.7 mirror) ----------------------------------------

describe("POST /api/admin/resumes/:id/confirm", () => {
  it("HEADs the object, records the true size, stamps confirmed_at", async () => {
    const created = await uploadUrl({ filename: "cv.pdf", size: 500 });
    const { id, s3_key } = created.body.data;

    mockHead.mockResolvedValueOnce({
      contentLength: 40_000,
      contentType: RESUME_MIME,
    });

    const res = await request(app)
      .post(`/api/admin/resumes/${id}/confirm`)
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.confirmed_at).not.toBeNull();
    expect(res.body.data.confirmed).toBe(true);
    expect(res.body.data.bytes).toBe(40_000);
    expect(res.body.data.url).toBe(`https://${CDN_DOMAIN}/${s3_key}`);

    expect(mockHead).toHaveBeenCalledWith(s3_key);

    const row = await getDb()("resumes").where({ id }).first();
    expect(row.confirmed_at).not.toBeNull();
    expect(Number(row.bytes)).toBe(40_000);
  });

  it("returns 404 when the object never landed (HEAD 404)", async () => {
    const created = await uploadUrl({ filename: "cv.pdf", size: 500 });
    const { id } = created.body.data;

    mockHead.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/admin/resumes/${id}/confirm`)
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(404);

    // Row stays pending so the client can retry.
    const row = await getDb()("resumes").where({ id }).first();
    expect(row.confirmed_at).toBeNull();
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app)
      .post("/api/admin/resumes/not-a-uuid/confirm")
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown uuid", async () => {
    const res = await request(app)
      .post("/api/admin/resumes/99999999-9999-9999-9999-999999999999/confirm")
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ---- admin list (task #92 DoD 353) -----------------------------------------

describe("GET /api/admin/resumes", () => {
  it("returns every version newest-first with per-version url + confirmed state", async () => {
    // Insert three versions with strictly increasing created_at.
    const old = await insertResume({
      s3_key: "resumes/aaa/old.pdf",
      filename: "old.pdf",
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    const mid = await insertResume({
      s3_key: "resumes/bbb/mid.pdf",
      filename: "mid.pdf",
      created_at: new Date(Date.now() - 1800_000).toISOString(),
      confirmed_at: null,
    });
    const newest = await insertResume({
      s3_key: "resumes/ccc/new.pdf",
      filename: "new.pdf",
      created_at: new Date().toISOString(),
    });

    const res = await request(app).get("/api/admin/resumes").set(...AUTH);
    expect(res.status).toBe(200);
    const resumes = res.body.data.resumes as Array<{
      id: string;
      url: string;
      filename: string;
      confirmed: boolean;
    }>;
    expect(resumes.map((r) => r.id)).toEqual([newest, mid, old]);
    // Per-version CDN url resolved from the row's s3_key (§6.8).
    expect(resumes[0].url).toBe(`https://${CDN_DOMAIN}/resumes/ccc/new.pdf`);
    // The unconfirmed row surfaces `confirmed: false`.
    expect(resumes.find((r) => r.id === mid)?.confirmed).toBe(false);
    expect(resumes.find((r) => r.id === newest)?.confirmed).toBe(true);
  });

  it("requires an admin token (401)", async () => {
    const res = await request(app).get("/api/admin/resumes");
    expect(res.status).toBe(401);
  });
});

// ---- admin delete (DoD 353 — delete-newest promotes next) ------------------

describe("DELETE /api/admin/resumes/:id", () => {
  it("removes the S3 object + row; deleting the newest promotes the next-newest publicly", async () => {
    const older = await insertResume({
      s3_key: "resumes/older/r.pdf",
      filename: "older.pdf",
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    const newer = await insertResume({
      s3_key: "resumes/newer/r.pdf",
      filename: "newer.pdf",
      created_at: new Date().toISOString(),
    });

    // Public /api/resume currently serves the NEWER one.
    let pub = await request(app).get("/api/resume");
    expect(pub.status).toBe(200);
    expect(pub.body.available).toBe(true);
    expect(pub.body.filename).toBe("newer.pdf");

    // Delete the newer version.
    const del = await request(app)
      .delete(`/api/admin/resumes/${newer}`)
      .set(...AUTH);
    expect(del.status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("resumes/newer/r.pdf");
    expect(
      await getDb()("resumes").where({ id: newer }).first()
    ).toBeUndefined();

    // Public /api/resume now serves the older one (implicit promotion — no
    // explicit "promote" step required).
    pub = await request(app).get("/api/resume");
    expect(pub.status).toBe(200);
    expect(pub.body.available).toBe(true);
    expect(pub.body.filename).toBe("older.pdf");

    // Older row is untouched.
    expect(
      await getDb()("resumes").where({ id: older }).first()
    ).toBeDefined();
  });

  it("returns 404 for an unknown id and 400 for a malformed id", async () => {
    const unknown = await request(app)
      .delete("/api/admin/resumes/99999999-9999-9999-9999-999999999999")
      .set(...AUTH);
    expect(unknown.status).toBe(404);

    const bad = await request(app)
      .delete("/api/admin/resumes/not-a-uuid")
      .set(...AUTH);
    expect(bad.status).toBe(400);
  });
});

// ---- public GET /api/resume (DoD 350) --------------------------------------

describe("GET /api/resume (public)", () => {
  it("returns {available:false} when no version has ever been confirmed", async () => {
    // Only unconfirmed rows exist.
    await insertResume({ confirmed_at: null });

    const res = await request(app).get("/api/resume");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
    // no-store cache header — new upload must go live immediately.
    expect(res.headers["cache-control"]).toBe("no-store");
    // Raw response — no admin envelope wrapping (§4.3).
    expect(res.body.status).toBeUndefined();
    expect(res.body.data).toBeUndefined();
  });

  it("returns the newest CONFIRMED version with a CDN url + no-store", async () => {
    // Older confirmed row.
    await insertResume({
      s3_key: "resumes/old/r.pdf",
      filename: "old.pdf",
      bytes: 1000,
      created_at: new Date(Date.now() - 3600_000).toISOString(),
      confirmed_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    // Newer confirmed row — this is the one that must be served.
    const confirmedAt = new Date().toISOString();
    await insertResume({
      s3_key: "resumes/new/r.pdf",
      filename: "Ben Kile Resume.pdf",
      bytes: 42_000,
      created_at: confirmedAt,
      confirmed_at: confirmedAt,
    });
    // A still-newer UNCONFIRMED upload — must be ignored publicly.
    await insertResume({
      s3_key: "resumes/pending/r.pdf",
      filename: "pending.pdf",
      created_at: new Date(Date.now() + 1000).toISOString(),
      confirmed_at: null,
    });

    const res = await request(app).get("/api/resume");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.url).toBe(`https://${CDN_DOMAIN}/resumes/new/r.pdf`);
    expect(res.body.filename).toBe("Ben Kile Resume.pdf");
    expect(res.body.bytes).toBe(42_000);
    expect(res.body.uploaded_at).toBe(confirmedAt);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("degrades to {available:false} instead of 5xx when the DB layer throws", async () => {
    // Force an internal error: an invalid CDN domain wouldn't do it, but
    // closing the DB pool would — however that would break the rest of the
    // suite. Instead spy on the service to throw once.
    const svc = await import("../src/services/resumesService");
    const spy = jest
      .spyOn(svc, "getNewestConfirmedResume")
      .mockRejectedValueOnce(new Error("boom"));
    try {
      const res = await request(app).get("/api/resume");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false });
    } finally {
      spy.mockRestore();
    }
  });
});

// ---- public GET /api/resume/download (DoD 351) -----------------------------

describe("GET /api/resume/download (public)", () => {
  it("streams the newest confirmed PDF with attachment Content-Disposition + Content-Type", async () => {
    await insertResume({
      s3_key: "resumes/dl/original.pdf",
      filename: "Ben Kile — 2026.pdf",
      bytes: 4,
    });

    // A tiny fake PDF stream — the fixed 4-byte "%PDF" prefix is enough to
    // prove that what the client receives is what S3 handed us.
    const body = new PassThrough();
    body.end(Buffer.from("%PDF"));
    mockGetStream.mockResolvedValueOnce({
      body: body as unknown as Readable,
      contentLength: 4,
      contentType: RESUME_MIME,
    });

    const res = await request(app)
      .get("/api/resume/download")
      .buffer(true)
      .parse((r, cb) => {
        // Capture raw bytes so we can assert the PDF payload.
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c as Buffer));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    // Attachment Content-Disposition carries the stored filename. Unicode
    // characters (em-dash) are stripped from the header-quoted form and
    // re-provided via RFC 5987 `filename*=UTF-8''…` for compliant browsers.
    expect(res.headers["content-disposition"]).toContain("attachment;");
    expect(res.headers["content-disposition"]).toMatch(
      /filename="Ben Kile _ 2026\.pdf"/
    );
    expect(res.headers["content-disposition"]).toMatch(
      /filename\*=UTF-8''Ben%20Kile%20%E2%80%94%202026\.pdf/
    );
    // Cache-Control no-store — a new upload must serve immediately.
    expect(res.headers["cache-control"]).toBe("no-store");

    // Body is the raw PDF stream (not a JSON envelope).
    expect((res.body as Buffer).equals(Buffer.from("%PDF"))).toBe(true);

    // The row's s3_key drove the S3 GetObject call.
    expect(mockGetStream).toHaveBeenCalledWith("resumes/dl/original.pdf");
  });

  it("returns 404 when no confirmed version exists", async () => {
    await insertResume({ confirmed_at: null });
    const res = await request(app).get("/api/resume/download");
    expect(res.status).toBe(404);
    expect(mockGetStream).not.toHaveBeenCalled();
  });

  it("returns 404 when the S3 object is missing for the newest row", async () => {
    await insertResume({ s3_key: "resumes/missing/r.pdf" });
    mockGetStream.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/resume/download");
    expect(res.status).toBe(404);
    expect(mockGetStream).toHaveBeenCalledWith("resumes/missing/r.pdf");
  });

  it("escapes quotes and backslashes in the ASCII filename form", async () => {
    await insertResume({
      s3_key: "resumes/quotes/r.pdf",
      filename: 'weird"name\\.pdf',
    });
    const body = new PassThrough();
    body.end(Buffer.from("%PDF"));
    mockGetStream.mockResolvedValueOnce({
      body: body as unknown as Readable,
      contentLength: 4,
      contentType: RESUME_MIME,
    });

    const res = await request(app)
      .get("/api/resume/download")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c as Buffer));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    // Backslash-escaped quote/backslash in the ASCII form.
    expect(res.headers["content-disposition"]).toMatch(
      /filename="weird\\"name\\\\\.pdf"/
    );
  });
});

// ---- orphan sweep is unaffected by resume rows/objects (DoD 352) -----------

describe("media orphan sweep is unaffected by resumes (task #92 DoD 352)", () => {
  it("never scans, tags, or references any resumes row or resumes/ S3 object", async () => {
    // Seed: several resumes, some confirmed, some pending, all under the
    // `resumes/` prefix.
    await insertResume({ s3_key: "resumes/sweep-1/r.pdf", filename: "a.pdf" });
    await insertResume({
      s3_key: "resumes/sweep-2/r.pdf",
      filename: "b.pdf",
      confirmed_at: null,
    });
    await insertResume({ s3_key: "resumes/sweep-3/r.pdf", filename: "c.pdf" });

    // Seed a media_assets row that will not be touched either (young, no
    // references) so we can prove the sweep ran and just found nothing to do.
    await getDb()("media_assets").insert({
      s3_key: "media/young/x.webp",
      mime: "image/webp",
      bytes: 100,
      confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    // Run the sweep via the admin endpoint.
    const res = await request(app)
      .post("/api/admin/media/sweep")
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(200);

    // The sweep's summary NEVER mentions any resume id — the reference set is
    // built exclusively from media-bearing tables (sections, section_items,
    // page_versions, posts) and the asset scan is `media_assets` only.
    const summary = res.body.data as {
      orphaned: string[];
      rescued: string[];
      deleted: string[];
    };
    const resumeRows = await getDb()("resumes").select("id");
    const resumeIds = new Set(resumeRows.map((r) => r.id));
    for (const id of [...summary.orphaned, ...summary.rescued, ...summary.deleted]) {
      expect(resumeIds.has(id)).toBe(false);
    }
    // No S3 tag was applied to any `resumes/` key.
    for (const call of mockPutTags.mock.calls) {
      expect(call[0]).not.toMatch(/^resumes\//);
    }
    // And every resumes row is still present, untouched — nothing was scheduled
    // for deletion, orphaned, or otherwise mutated.
    const after = await getDb()("resumes").select("id", "confirmed_at");
    expect(after.length).toBe(3);
  });
});

// ---- section-schema round-trip (DoD 354) -----------------------------------

describe("resume section type round-trips through the schema registry", () => {
  it("the section-data map has a `resume` entry that validates {heading?, intro?}", async () => {
    const { SECTION_DATA_SCHEMAS, SECTION_TYPES } = await import(
      "../src/schemas"
    );
    expect(SECTION_TYPES).toContain("resume");
    const schema = SECTION_DATA_SCHEMAS.resume;
    expect(schema.safeParse({}).success).toBe(true);
    expect(
      schema.safeParse({ heading: "Resume", intro: "Grab the PDF." }).success
    ).toBe(true);
    // .strict() — no items on a resume section.
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });

  it("GET /api/schema advertises the resume section (integration)", async () => {
    // Reuse the app under test — this hits the same schemaRouter as production.
    const schemaApp = express();
    schemaApp.set("secrets", { cdn_domain: CDN_DOMAIN });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schemaRouter = (await import("../src/routers/schemaRouter")).default;
    schemaApp.use("/api/schema", schemaRouter);

    const res = await request(schemaApp).get("/api/schema");
    expect(res.status).toBe(200);
    const defs = (res.body.definitions ?? res.body["$defs"]) as Record<string, any>;
    const root = defs["PortfolioV6Content"] as { properties: Record<string, any> };
    expect(root.properties.sectionData.properties).toHaveProperty("resume");
  });
});
