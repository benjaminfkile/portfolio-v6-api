import express, { Express, NextFunction, Request, Response } from "express";
import request from "supertest";

// Mock the Cognito verifier wrapper ENTIRELY — no AWS/JWKS network call is ever
// made (§5.3 / hard rule: verification runs offline). The middleware imports
// verifyAdminIdToken from this module; we control its behaviour per-test.
jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import {
  requireAdmin,
  requireAdminOrPreviewToken,
} from "../src/middleware/requireAdmin";
import adminAuthRouter from "../src/routers/adminAuthRouter";
import {
  clearPreviewTokens,
  isValidPreviewToken,
  mintPreviewToken,
  PREVIEW_TOKEN_TTL_MS,
} from "../src/services/previewTokenService";

const mockVerify = verifyAdminIdToken as jest.Mock;

const TEST_SECRETS = {
  cognito_user_pool_id: "us-east-1_testpool",
  cognito_client_id: "test-client-id",
};

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", TEST_SECRETS);

  // Preview-token mint route, exactly as wired in app.ts.
  app.use("/api/admin", adminAuthRouter);

  // A stand-in for a mutating admin route (task 438+ wires the real ones).
  app.get("/admin-only", requireAdmin(), (req: Request, res: Response) => {
    res.status(200).json({ adminSub: req.adminSub });
  });

  // A stand-in for a preview-serialization route (§4.2 †).
  app.get(
    "/preview-route",
    requireAdminOrPreviewToken(),
    (req: Request, res: Response) => {
      res.status(200).json({ adminSub: req.adminSub ?? null });
    }
  );

  app.use(function errorHandler(
    err: Error,
    _req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (res.headersSent) return next(err);
    res.status(500).json({ status: "error", error: true, errorMsg: err.message });
  });

  return app;
}

const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };

beforeEach(() => {
  mockVerify.mockReset();
  clearPreviewTokens();
});

describe("requireAdmin() — §5.3", () => {
  it("passes a valid admin token, sets req.adminSub, and calls the verifier with pool/client/tokenUse", async () => {
    mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
    const app = buildTestApp();

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer good.token");

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-123");

    // Verifier was asked to check THIS token against the configured pool/client.
    expect(mockVerify).toHaveBeenCalledWith(
      "good.token",
      TEST_SECRETS.cognito_user_pool_id,
      TEST_SECRETS.cognito_client_id
    );
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const app = buildTestApp();
    const res = await request(app).get("/admin-only");
    expect(res.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns 401 when the header is present but not a Bearer token", async () => {
    const app = buildTestApp();
    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Basic abc123");
    expect(res.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns 401 for a bad signature / invalid token (verifier throws)", async () => {
    mockVerify.mockRejectedValue(new Error("JwtInvalidSignatureError"));
    const app = buildTestApp();

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer tampered.token");

    expect(res.status).toBe(401);
  });

  it("returns 403 for a valid token whose cognito:groups lacks 'admins'", async () => {
    mockVerify.mockResolvedValue({
      sub: "user-sub-999",
      "cognito:groups": ["viewers"],
    });
    const app = buildTestApp();

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer valid.but.wrong.group");

    expect(res.status).toBe(403);
  });

  it("returns 403 when the token has no cognito:groups claim at all", async () => {
    mockVerify.mockResolvedValue({ sub: "user-sub-000" });
    const app = buildTestApp();

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer valid.no.groups");

    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/preview-token — §7", () => {
  it("mints a token behind requireAdminOrMachine and returns it with a 15-minute expiry", async () => {
    mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
    const app = buildTestApp();

    const res = await request(app)
      .post("/api/admin/preview-token")
      .set("Authorization", "Bearer good.token");

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.token.length).toBeGreaterThan(32);
    expect(res.body.data.expiresInMs).toBe(PREVIEW_TOKEN_TTL_MS);
    expect(res.body.data.expiresInMs).toBe(15 * 60 * 1000);
  });

  it("refuses to mint without a valid admin token (401)", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/api/admin/preview-token");
    expect(res.status).toBe(401);
  });

  it("refuses to mint for a non-admin group (403)", async () => {
    mockVerify.mockResolvedValue({ sub: "x", "cognito:groups": [] });
    const app = buildTestApp();
    const res = await request(app)
      .post("/api/admin/preview-token")
      .set("Authorization", "Bearer valid.wrong.group");
    expect(res.status).toBe(403);
  });
});

describe("requireAdminOrPreviewToken() — §4.2 / §7", () => {
  async function mintToken(app: Express): Promise<string> {
    mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
    const res = await request(app)
      .post("/api/admin/preview-token")
      .set("Authorization", "Bearer good.token");
    return res.body.data.token as string;
  }

  it("accepts a valid preview token via the ?token= query param — the public site's transport (lib/api.ts)", async () => {
    const app = buildTestApp();
    const token = await mintToken(app);

    const res = await request(app).get("/preview-route").query({ token });

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBeNull();
  });

  it("accepts a valid preview token via the ?preview= query param (read-only, no adminSub)", async () => {
    const app = buildTestApp();
    const token = await mintToken(app);

    const res = await request(app).get("/preview-route").query({ preview: token });

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBeNull();
  });

  it("accepts a valid preview token via the X-Preview-Token header", async () => {
    const app = buildTestApp();
    const token = await mintToken(app);

    const res = await request(app)
      .get("/preview-route")
      .set("X-Preview-Token", token);

    expect(res.status).toBe(200);
  });

  it("accepts a valid admin bearer token on the preview route and sets adminSub", async () => {
    const app = buildTestApp();
    mockVerify.mockResolvedValue(ADMIN_PAYLOAD);

    const res = await request(app)
      .get("/preview-route")
      .set("Authorization", "Bearer good.token");

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-123");
  });

  it("returns 403 for a wrong-group admin bearer token on the preview route", async () => {
    const app = buildTestApp();
    mockVerify.mockResolvedValue({ sub: "x", "cognito:groups": ["viewers"] });

    const res = await request(app)
      .get("/preview-route")
      .set("Authorization", "Bearer valid.wrong.group");

    expect(res.status).toBe(403);
  });

  it("returns 401 for an unknown preview token", async () => {
    const app = buildTestApp();
    const res = await request(app)
      .get("/preview-route")
      .query({ preview: "definitely-not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when no credentials are supplied at all", async () => {
    const app = buildTestApp();
    const res = await request(app).get("/preview-route");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an EXPIRED preview token (past the 15-minute window)", async () => {
    const app = buildTestApp();
    const t0 = Date.parse("2026-07-26T00:00:00.000Z");
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);

    const token = await mintToken(app);

    // Still valid one millisecond before expiry.
    nowSpy.mockReturnValue(t0 + PREVIEW_TOKEN_TTL_MS - 1);
    const ok = await request(app).get("/preview-route").query({ preview: token });
    expect(ok.status).toBe(200);

    // Expired one millisecond past the window → 401.
    nowSpy.mockReturnValue(t0 + PREVIEW_TOKEN_TTL_MS + 1);
    const expired = await request(app)
      .get("/preview-route")
      .query({ preview: token });
    expect(expired.status).toBe(401);

    nowSpy.mockRestore();
  });

  it("SINGLE-PURPOSE SCOPE: a preview token cannot authorize a requireAdmin route", async () => {
    const app = buildTestApp();
    const token = await mintToken(app);

    // Same token that just worked on /preview-route is rejected on the admin route.
    const viaQuery = await request(app)
      .get("/admin-only")
      .query({ preview: token });
    expect(viaQuery.status).toBe(401);

    const viaHeader = await request(app)
      .get("/admin-only")
      .set("X-Preview-Token", token);
    expect(viaHeader.status).toBe(401);
  });
});

describe("previewTokenService — expiry unit checks (§7)", () => {
  it("mints a 256-bit hex token valid for 15 minutes and self-evicts on expiry", () => {
    const t0 = 1_000_000_000_000;
    const { token, expiresInMs } = mintPreviewToken(t0);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresInMs).toBe(PREVIEW_TOKEN_TTL_MS);

    expect(isValidPreviewToken(token, t0)).toBe(true);
    expect(isValidPreviewToken(token, t0 + PREVIEW_TOKEN_TTL_MS - 1)).toBe(true);
    // Exactly at expiry is no longer valid (expiry <= now).
    expect(isValidPreviewToken(token, t0 + PREVIEW_TOKEN_TTL_MS)).toBe(false);
    expect(isValidPreviewToken(token, t0 + PREVIEW_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it("treats unknown and empty tokens as invalid", () => {
    expect(isValidPreviewToken(undefined)).toBe(false);
    expect(isValidPreviewToken("")).toBe(false);
    expect(isValidPreviewToken("nope")).toBe(false);
  });
});
