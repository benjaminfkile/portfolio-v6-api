import express, { Express } from "express";
import request from "supertest";

/**
 * Icons manifest + import tests — §Icons v1.6 (task #532), acceptance 1659.
 *
 * FULLY OFFLINE (agent-pre-checks §7): `global.fetch` is stubbed so no jsDelivr
 * call is ever made, and `src/aws/s3Service` is mocked so no AWS call is ever
 * made. The Cognito verifier is mocked so `requireAdmin` passes with a bearer
 * token. No Postgres is needed — neither endpoint touches the database.
 *
 * Covered: manifest slimming to the contract shape + ~24h caching (one upstream
 * call, not one per request) + a 502 on upstream failure; import happy path
 * (validate → download → store under icons/ → CDN URL); unknown icon / unknown
 * variant 400s; and idempotent re-import (existing key → no re-upload).
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

jest.mock("../src/aws/s3Service", () => ({
  headObject: jest.fn(),
  putObject: jest.fn().mockResolvedValue(undefined),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import * as s3 from "../src/aws/s3Service";
import adminIconsRouter from "../src/routers/adminIconsRouter";
import { failure } from "../src/utils/envelope";
import {
  DEVICON_VERSION,
  DEVICON_MANIFEST_URL,
  MANIFEST_CACHE_TTL_MS,
  _resetIconsCacheForTests,
} from "../src/services/iconsService";

const mockVerify = verifyAdminIdToken as jest.Mock;
const mockHead = s3.headObject as jest.Mock;
const mockPut = s3.putObject as jest.Mock;

const ADMIN_PAYLOAD = { sub: "admin-sub-532", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;
const CDN = "media-test.benkile.com";

// A tiny raw devicon.json — the exact shape jsDelivr serves, including a font-only
// `aliases` array and a `font` list that must NOT leak into the slimmed output.
const RAW_MANIFEST = [
  {
    name: "react",
    altnames: [],
    tags: ["web", "framework"],
    versions: { svg: ["original", "original-wordmark"], font: ["original"] },
    color: "#61DAFB",
    aliases: [{ base: "original", alias: "original-wordmark" }],
  },
  {
    name: "aarch64",
    altnames: ["arm64"],
    tags: ["architecture"],
    versions: { svg: ["original", "plain", "line"], font: ["plain", "line"] },
    color: "#16358C",
    aliases: [],
  },
];

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function svgResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

// Route the mocked fetch by URL: the manifest URL returns devicon.json, an
// icon SVG URL returns the SVG body. Tests override this per-case as needed.
let fetchImpl: (url: string) => Response;
const mockFetch = jest.fn(async (input: unknown) => fetchImpl(String(input)));

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", {
    cognito_user_pool_id: "us-east-1_testpool",
    cognito_client_id: "test-client-id",
    cdn_domain: CDN,
  });
  app.use("/api/admin", adminIconsRouter);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) return next(err);
      res.status(500).json(failure(err.message));
    }
  );
  return app;
}

let app: Express;

beforeAll(() => {
  (global as unknown as { fetch: unknown }).fetch = mockFetch;
  app = buildApp();
});

beforeEach(() => {
  _resetIconsCacheForTests();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
  mockHead.mockReset();
  mockHead.mockResolvedValue(null); // default: object absent → import uploads
  mockPut.mockClear();
  mockFetch.mockClear();
  fetchImpl = (url) =>
    url.endsWith("/devicon.json")
      ? jsonResponse(RAW_MANIFEST)
      : svgResponse(SVG_BODY);
});

// ---- GET /api/admin/icons/devicon-manifest ---------------------------------

describe("GET /api/admin/icons/devicon-manifest (§Icons v1.6)", () => {
  it("requires an admin token (401)", async () => {
    const res = await request(app).get("/api/admin/icons/devicon-manifest");
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("serves the pinned manifest slimmed to the contract shape", async () => {
    const res = await request(app)
      .get("/api/admin/icons/devicon-manifest")
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(DEVICON_VERSION);
    // Fetched from the pinned jsDelivr URL.
    expect(mockFetch).toHaveBeenCalledWith(
      DEVICON_MANIFEST_URL,
      expect.any(Object)
    );

    const react = res.body.data.icons.find(
      (i: { name: string }) => i.name === "react"
    );
    // versions is versions.svg only — the font list never leaks in.
    expect(react).toEqual({
      name: "react",
      altnames: [],
      tags: ["web", "framework"],
      versions: ["original", "original-wordmark"],
      color: "#61DAFB",
    });
    // No raw devicon fields (aliases/font) survive the slim.
    expect(react).not.toHaveProperty("aliases");
    expect(react).not.toHaveProperty("font");

    const arm = res.body.data.icons.find(
      (i: { name: string }) => i.name === "aarch64"
    );
    expect(arm.altnames).toEqual(["arm64"]);
    expect(arm.versions).toEqual(["original", "plain", "line"]);
  });

  it("caches ~24h — a second request does NOT re-fetch upstream", async () => {
    await request(app).get("/api/admin/icons/devicon-manifest").set(...AUTH);
    await request(app).get("/api/admin/icons/devicon-manifest").set(...AUTH);
    // One upstream call for two requests (the cache served the second).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Sanity: the TTL constant is ~24h.
    expect(MANIFEST_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("returns 502 with a clear message on an upstream failure", async () => {
    fetchImpl = (url) =>
      url.endsWith("/devicon.json")
        ? jsonResponse(null, false, 503)
        : svgResponse(SVG_BODY);

    const res = await request(app)
      .get("/api/admin/icons/devicon-manifest")
      .set(...AUTH);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(true);
    expect(typeof res.body.errorMsg).toBe("string");
    expect(res.body.errorMsg.length).toBeGreaterThan(0);
  });
});

// ---- POST /api/admin/icons/import ------------------------------------------

describe("POST /api/admin/icons/import (§Icons v1.6)", () => {
  const KEY = `icons/devicon/react-original@${DEVICON_VERSION}.svg`;
  const URL = `https://${CDN}/${KEY}`;

  it("requires an admin token (401)", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .send({ name: "react", variant: "original" });
    expect(res.status).toBe(401);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("validates, downloads, stores under icons/, and returns the CDN URL", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ name: "react", variant: "original" });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(URL);

    // Idempotency probe on the deterministic key first.
    expect(mockHead).toHaveBeenCalledWith(KEY);

    // Downloaded the pinned SVG, then stored it with the icon content-type under
    // the icons/ prefix (NOT media/).
    expect(mockFetch).toHaveBeenCalledWith(
      `https://cdn.jsdelivr.net/gh/devicons/devicon@${DEVICON_VERSION}/icons/react/react-original.svg`,
      expect.any(Object)
    );
    expect(mockPut).toHaveBeenCalledTimes(1);
    const putArgs = mockPut.mock.calls[0][0];
    expect(putArgs.key).toBe(KEY);
    expect(putArgs.key.startsWith("icons/")).toBe(true);
    expect(putArgs.contentType).toBe("image/svg+xml");
    expect(putArgs.body).toBe(SVG_BODY);
    expect(typeof putArgs.cacheControl).toBe("string");
  });

  it("rejects an unknown icon with a 400 and never uploads", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ name: "not-a-real-icon", variant: "original" });
    expect(res.status).toBe(400);
    expect(res.body.errorMsg).toContain("not-a-real-icon");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("rejects an unknown variant with a 400 and never uploads", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      // react publishes original + original-wordmark, not `plain`.
      .send({ name: "react", variant: "plain" });
    expect(res.status).toBe(400);
    expect(res.body.errorMsg).toContain("plain");
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("is idempotent — an already-imported icon skips the upload", async () => {
    // The deterministic key already exists in S3.
    mockHead.mockResolvedValue({ contentLength: 500, contentType: "image/svg+xml" });

    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ name: "react", variant: "original" });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(URL);
    // Existing key → no SVG download and no re-upload.
    expect(mockPut).not.toHaveBeenCalled();
    const svgFetches = mockFetch.mock.calls.filter((c) =>
      String(c[0]).endsWith(".svg")
    );
    expect(svgFetches).toHaveLength(0);
  });

  it("rejects a missing name/variant with a 400", async () => {
    const noName = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ variant: "original" });
    expect(noName.status).toBe(400);

    const noVariant = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ name: "react" });
    expect(noVariant.status).toBe(400);

    expect(mockPut).not.toHaveBeenCalled();
  });
});
