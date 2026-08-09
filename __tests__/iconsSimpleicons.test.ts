import express, { Express } from "express";
import request from "supertest";

/**
 * Simple Icons manifest + tinted-import tests — §Icons v1.6.1 (task #541),
 * acceptance 1683/1684.
 *
 * FULLY OFFLINE (agent-pre-checks §7): `global.fetch` is stubbed so no jsDelivr /
 * cdn.simpleicons.org call is ever made, and `src/aws/s3Service` is mocked so no
 * AWS call is ever made. The Cognito verifier is mocked so `requireAdmin` passes
 * with a bearer token. No Postgres is needed.
 *
 * Covered: manifest slimming to `{ slug, title }` + slug derivation + ~24h
 * caching + 502 on upstream failure; tinted import happy path (validate slug &
 * color → download tinted SVG → store under icons/simpleicons/ → CDN URL);
 * unknown slug → 400; bad colours (`red`, `#fff`, 7 chars) → 400; idempotent
 * re-import; and a regression check that the devicon `{ name, variant }` shape
 * still routes through the same POST unchanged.
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
  SIMPLEICONS_VERSION,
  SIMPLEICONS_MANIFEST_URL,
  DEVICON_VERSION,
  MANIFEST_CACHE_TTL_MS,
  titleToSlug,
  slimSimpleIcons,
  simpleIconSvgUrl,
  tintSvg,
  _resetIconsCacheForTests,
} from "../src/services/iconsService";

/** True for the pinned jsDelivr ARTWORK url (not the `_data` catalog json). */
const isArtworkUrl = (url: unknown): boolean =>
  String(url).includes(`simple-icons@${SIMPLEICONS_VERSION}/icons/`);

const mockVerify = verifyAdminIdToken as jest.Mock;
const mockHead = s3.headObject as jest.Mock;
const mockPut = s3.putObject as jest.Mock;

const ADMIN_PAYLOAD = { sub: "admin-sub-541", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;
const CDN = "media-test.benkile.com";

// A tiny raw simple-icons data file: a plain entry (slug derived from title),
// one whose slug must be DERIVED with the special char rules (`.`→`dot`), and one
// carrying an explicit `slug` override that must win over the derivation.
const RAW_CATALOG = [
  { title: "React", hex: "61DAFB" },
  { title: "Node.js", hex: "5FA04E" },
  { title: "X", hex: "000000", slug: "x" },
  { title: "" }, // dropped: no usable title
];

// RAW artwork as shipped by the simple-icons package: single glyph, no fill.
// The import downloads this and tints it server-side (tintSvg).
const SVG_BODY =
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

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

// Route the mocked fetch by URL: the catalog data file returns RAW_CATALOG, a
// pinned jsDelivr artwork URL returns the raw SVG body. Overridden per-case.
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
    isArtworkUrl(url)
      ? svgResponse(SVG_BODY)
      : jsonResponse(RAW_CATALOG);
});

// ---- Pure helpers -----------------------------------------------------------

describe("titleToSlug / slimSimpleIcons (§Icons v1.6.1)", () => {
  it("derives slugs with the official special-char rules", () => {
    expect(titleToSlug("React")).toBe("react");
    expect(titleToSlug("Node.js")).toBe("nodedotjs");
    expect(titleToSlug("C++")).toBe("cplusplus");
    expect(titleToSlug("AT&T")).toBe("atandt");
    expect(titleToSlug("Löve")).toBe("love");
  });

  it("slims to { slug, title }, prefers explicit slug, drops title-less rows", () => {
    expect(slimSimpleIcons(RAW_CATALOG)).toEqual([
      { slug: "react", title: "React" },
      { slug: "nodedotjs", title: "Node.js" },
      { slug: "x", title: "X" },
    ]);
  });

  it("accepts the { icons: [...] } wrapper form too", () => {
    expect(slimSimpleIcons({ icons: [{ title: "React", hex: "61DAFB" }] })).toEqual([
      { slug: "react", title: "React" },
    ]);
  });
});

// ---- GET /api/admin/icons/simpleicons-manifest -----------------------------

describe("GET /api/admin/icons/simpleicons-manifest (§Icons v1.6.1)", () => {
  it("requires an admin token (401)", async () => {
    const res = await request(app).get("/api/admin/icons/simpleicons-manifest");
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("serves the pinned catalog slimmed to { slug, title }", async () => {
    const res = await request(app)
      .get("/api/admin/icons/simpleicons-manifest")
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(SIMPLEICONS_VERSION);
    expect(mockFetch).toHaveBeenCalledWith(
      SIMPLEICONS_MANIFEST_URL,
      expect.any(Object)
    );

    const react = res.body.data.icons.find(
      (i: { slug: string }) => i.slug === "react"
    );
    expect(react).toEqual({ slug: "react", title: "React" });
    // No raw simple-icons fields (hex) survive the slim.
    expect(react).not.toHaveProperty("hex");
    expect(res.body.data.icons).toContainEqual({
      slug: "nodedotjs",
      title: "Node.js",
    });
  });

  it("caches ~24h — a second request does NOT re-fetch upstream", async () => {
    await request(app).get("/api/admin/icons/simpleicons-manifest").set(...AUTH);
    await request(app).get("/api/admin/icons/simpleicons-manifest").set(...AUTH);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(MANIFEST_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("returns 502 with a clear message on an upstream failure", async () => {
    fetchImpl = () => jsonResponse(null, false, 503);
    const res = await request(app)
      .get("/api/admin/icons/simpleicons-manifest")
      .set(...AUTH);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(true);
    expect(typeof res.body.errorMsg).toBe("string");
    expect(res.body.errorMsg.length).toBeGreaterThan(0);
  });
});

// ---- POST /api/admin/icons/import { source: 'simpleicons' } -----------------

describe("POST /api/admin/icons/import — simpleicons (§Icons v1.6.1)", () => {
  const COLOR = "EDF1F7";
  const KEY = `icons/simpleicons/react-${COLOR.toLowerCase()}.svg`;
  const URL = `https://${CDN}/${KEY}`;

  it("requires an admin token (401)", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .send({ source: "simpleicons", slug: "react", color: COLOR });
    expect(res.status).toBe(401);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("validates, downloads the tint, stores under icons/simpleicons/, returns URL", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "react", color: COLOR });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(URL);

    // Idempotency probe on the deterministic key first.
    expect(mockHead).toHaveBeenCalledWith(KEY);

    // Downloaded the RAW artwork from pinned jsDelivr (never
    // cdn.simpleicons.org — it 403s datacenter IPs) and tinted server-side.
    expect(mockFetch).toHaveBeenCalledWith(
      simpleIconSvgUrl("react"),
      expect.any(Object)
    );
    expect(mockPut).toHaveBeenCalledTimes(1);
    const putArgs = mockPut.mock.calls[0][0];
    expect(putArgs.key).toBe(KEY);
    expect(putArgs.key.startsWith("icons/simpleicons/")).toBe(true);
    expect(putArgs.contentType).toBe("image/svg+xml");
    expect(putArgs.body).toBe(tintSvg(SVG_BODY, COLOR));
    expect(putArgs.body).toContain(`fill="#${COLOR.toLowerCase()}"`);
    expect(typeof putArgs.cacheControl).toBe("string");
  });

  it("accepts an explicit-slug entry and the amber accent preset (E8A33D)", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "x", color: "E8A33D" });
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(
      `https://${CDN}/icons/simpleicons/x-e8a33d.svg`
    );
  });

  it("rejects an unknown slug with a 400 and never uploads", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "not-a-real-slug", color: COLOR });
    expect(res.status).toBe(400);
    expect(res.body.errorMsg).toContain("not-a-real-slug");
    expect(mockPut).not.toHaveBeenCalled();
    // Slug rejected before any CDN artwork fetch.
    const svgFetches = mockFetch.mock.calls.filter((c) =>
      isArtworkUrl(c[0])
    );
    expect(svgFetches).toHaveLength(0);
  });

  it.each([
    ["red", "a named colour"],
    ["#fff", "a leading #"],
    ["1234567", "7 hex digits"],
    ["12", "2 hex digits"],
    ["gggggg", "non-hex characters"],
  ])("rejects bad color %p (%s) with a 400 and never uploads", async (color) => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "react", color });
    expect(res.status).toBe(400);
    expect(res.body.errorMsg).toContain(color);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("accepts a 3-digit hex color", async () => {
    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "react", color: "fff" });
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(
      `https://${CDN}/icons/simpleicons/react-fff.svg`
    );
  });

  it("rejects a missing slug/color with a 400", async () => {
    const noSlug = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", color: COLOR });
    expect(noSlug.status).toBe(400);

    const noColor = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "react" });
    expect(noColor.status).toBe(400);

    expect(mockPut).not.toHaveBeenCalled();
  });

  it("is idempotent — an already-imported tint skips the upload", async () => {
    mockHead.mockResolvedValue({
      contentLength: 500,
      contentType: "image/svg+xml",
    });

    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "react", color: COLOR });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(URL);
    expect(mockPut).not.toHaveBeenCalled();
    const svgFetches = mockFetch.mock.calls.filter((c) =>
      isArtworkUrl(c[0])
    );
    expect(svgFetches).toHaveLength(0);
  });

  it("returns 502 when the CDN artwork download fails", async () => {
    fetchImpl = (url) =>
      isArtworkUrl(url)
        ? svgResponse("", false, 500)
        : jsonResponse(RAW_CATALOG);

    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ source: "simpleicons", slug: "react", color: COLOR });
    expect(res.status).toBe(502);
    expect(mockPut).not.toHaveBeenCalled();
  });
});

// ---- Regression: the devicon body shape is untouched -----------------------

describe("POST /api/admin/icons/import — devicon shape unchanged (regression)", () => {
  const RAW_DEVICON = [
    {
      name: "react",
      altnames: [],
      tags: ["web"],
      versions: { svg: ["original"], font: ["original"] },
      color: "#61DAFB",
    },
  ];

  it("still routes { name, variant } to the devicon import (icons/devicon/)", async () => {
    // With no `source`, the catalog fetch must be devicon.json, not simple-icons.
    fetchImpl = (url) =>
      url.endsWith("/devicon.json")
        ? jsonResponse(RAW_DEVICON)
        : svgResponse(SVG_BODY);

    const res = await request(app)
      .post("/api/admin/icons/import")
      .set(...AUTH)
      .send({ name: "react", variant: "original" });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(
      `https://${CDN}/icons/devicon/react-original@${DEVICON_VERSION}.svg`
    );
    const putArgs = mockPut.mock.calls[0][0];
    expect(putArgs.key.startsWith("icons/devicon/")).toBe(true);
  });
});
