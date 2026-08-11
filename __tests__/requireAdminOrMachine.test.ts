import express, { Express, NextFunction, Request, Response } from "express";
import request from "supertest";

/**
 * API Keys v1.16 — `requireAdminOrMachine` / `requireAdmin` unit tests. The admin
 * ID-token verifier is mocked WHOLESALE (no AWS/JWKS call is ever made, exactly
 * like auth.test.ts), and the `apiKeysService` is mocked so no DB is touched —
 * `verifyApiKey` drives the key path per-test.
 *
 * Covered:
 *  - the admin ID-token path is UNCHANGED (200/401/403, sets req.adminSub) and the
 *    key path is never consulted when the admin succeeds;
 *  - an ACTIVE `pv6k_` key is accepted, sets req.apiKeyId/req.apiKeyName, and fires
 *    the (fire-and-forget) last_used_at touch;
 *  - a revoked/unknown `pv6k_` key → 401;
 *  - a non-`pv6k_` invalid bearer falls back to the admin failure (401/403);
 *  - an API key on a plain `requireAdmin` route is denied (401) — it can only
 *    succeed on the narrow machine surface.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

jest.mock("../src/services/apiKeysService", () => ({
  API_KEY_PREFIX: "pv6k_",
  verifyApiKey: jest.fn(),
  touchApiKeyLastUsed: jest.fn(),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { verifyApiKey, touchApiKeyLastUsed } from "../src/services/apiKeysService";
import { requireAdmin } from "../src/middleware/requireAdmin";
import { requireAdminOrMachine } from "../src/middleware/requireAdminOrMachine";

const mockVerifyAdmin = verifyAdminIdToken as jest.Mock;
const mockVerifyApiKey = verifyApiKey as jest.Mock;
const mockTouch = touchApiKeyLastUsed as jest.Mock;

const POOL_ID = "us-east-1_testpool";
const ADMIN_CLIENT_ID = "test-admin-client";

const ADMIN_PAYLOAD = { sub: "admin-sub-616", "cognito:groups": ["admins"] };
const API_KEY = "pv6k_abcdef0123456789";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", {
    cognito_user_pool_id: POOL_ID,
    cognito_client_id: ADMIN_CLIENT_ID,
  });

  // Stand-in for the narrow machine surface (posts/media/blogs GET).
  app.get(
    "/machine-surface",
    requireAdminOrMachine(),
    (req: Request, res: Response) => {
      res.status(200).json({
        adminSub: req.adminSub ?? null,
        apiKeyId: req.apiKeyId ?? null,
        apiKeyName: req.apiKeyName ?? null,
      });
    }
  );

  // Stand-in for every OTHER admin route (pages/sections/site-publish/…): an API
  // key must be blocked here.
  app.get("/admin-only", requireAdmin(), (req: Request, res: Response) => {
    res.status(200).json({ adminSub: req.adminSub ?? null });
  });

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

beforeEach(() => {
  mockVerifyAdmin.mockReset();
  mockVerifyApiKey.mockReset();
  mockTouch.mockReset();
});

describe("requireAdminOrMachine — admin ID-token path is unchanged", () => {
  it("accepts a valid admin token, sets adminSub, never consults the key path", async () => {
    mockVerifyAdmin.mockResolvedValue(ADMIN_PAYLOAD);
    const app = buildApp();

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer good.admin.token");

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-616");
    expect(res.body.apiKeyName).toBeNull();
    expect(mockVerifyAdmin).toHaveBeenCalledWith(
      "good.admin.token",
      POOL_ID,
      ADMIN_CLIENT_ID
    );
    // Admin succeeded first, so the key path is never consulted.
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it("returns 401 when no Authorization header is present", async () => {
    const app = buildApp();
    const res = await request(app).get("/machine-surface");
    expect(res.status).toBe(401);
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it("returns 403 for a valid admin token whose group is not 'admins'", async () => {
    mockVerifyAdmin.mockResolvedValue({ sub: "u", "cognito:groups": ["viewers"] });
    const app = buildApp();

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer valid.wrong.group");

    expect(res.status).toBe(403);
    // A wrong-group ID token is not a `pv6k_` bearer, so no key lookup happens.
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });
});

describe("requireAdminOrMachine — API-key path", () => {
  it("accepts an ACTIVE key, sets req.apiKeyId/apiKeyName, fires the last_used touch", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("not an admin id token"));
    mockVerifyApiKey.mockResolvedValue({ id: "key-1", name: "posting-bot" });
    const app = buildApp();

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", `Bearer ${API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.apiKeyId).toBe("key-1");
    expect(res.body.apiKeyName).toBe("posting-bot");
    expect(res.body.adminSub).toBeNull();
    expect(mockVerifyApiKey).toHaveBeenCalledWith(API_KEY);
    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });

  it("returns 401 for a revoked/unknown key and never touches last_used", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("not an admin id token"));
    mockVerifyApiKey.mockResolvedValue(null); // revoked or unknown
    const app = buildApp();

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", `Bearer ${API_KEY}`);

    expect(res.status).toBe(401);
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed non-pv6k bearer (falls back to admin failure)", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("bad signature"));
    const app = buildApp();

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer not-a-key-token");

    expect(res.status).toBe(401);
    // Not a `pv6k_` bearer, so the key path is never consulted.
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });
});

describe("requireAdmin — an API key is blocked on every other admin route", () => {
  it("denies an active API key with 401 on a plain requireAdmin route", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("not an admin id token"));
    // Even a valid key has no reach here — requireAdmin never checks keys.
    mockVerifyApiKey.mockResolvedValue({ id: "key-1", name: "posting-bot" });
    const app = buildApp();

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", `Bearer ${API_KEY}`);

    expect(res.status).toBe(401);
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it("still admits a real admin on the plain requireAdmin route", async () => {
    mockVerifyAdmin.mockResolvedValue(ADMIN_PAYLOAD);
    const app = buildApp();

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer good.admin.token");

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-616");
  });
});
