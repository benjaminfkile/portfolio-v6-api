import express, { Express, NextFunction, Request, Response } from "express";
import request from "supertest";

/**
 * Machine Auth v1.15 — `requireAdminOrMachine` unit tests. The Cognito verifiers
 * are mocked WHOLESALE (no AWS/JWKS call is ever made, exactly like auth.test.ts):
 * `verifyAdminIdToken` is the human ID-token path, `verifyMachineAccessToken` the
 * client-credentials ACCESS-token path. We drive both per-test.
 *
 * Covered (task #601 DoD):
 *  - the admin ID-token path is UNCHANGED (200/401/403, sets req.adminSub);
 *  - a machine access token WITH the scope is accepted and sets req.machineClient;
 *  - a valid machine token with the WRONG scope → 403;
 *  - a bad-signature/invalid token → 401;
 *  - a machine token on a plain `requireAdmin` route → 403 (blocked elsewhere);
 *  - the feature is fully OFF when `machine_client_id` is unset — a machine token
 *    behaves exactly as it does today (401) and the machine verifier is never
 *    even called.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
  verifyMachineAccessToken: jest.fn(),
}));

import {
  verifyAdminIdToken,
  verifyMachineAccessToken,
} from "../src/aws/cognitoAuth";
import { requireAdmin } from "../src/middleware/requireAdmin";
import { requireAdminOrMachine } from "../src/middleware/requireAdminOrMachine";
import { DEFAULT_MACHINE_SCOPE } from "../src/middleware/machineAuth";

const mockVerifyAdmin = verifyAdminIdToken as jest.Mock;
const mockVerifyMachine = verifyMachineAccessToken as jest.Mock;

const POOL_ID = "us-east-1_testpool";
const ADMIN_CLIENT_ID = "test-admin-client";
const MACHINE_CLIENT_ID = "test-machine-client";
const MACHINE_SCOPE = "portfolio-api/machine";

const ADMIN_PAYLOAD = { sub: "admin-sub-601", "cognito:groups": ["admins"] };

/** Build an app whose secrets may or may not enable the machine feature. */
function buildApp(opts: {
  machine_client_id?: string;
  machine_scope?: string;
}): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", {
    cognito_user_pool_id: POOL_ID,
    cognito_client_id: ADMIN_CLIENT_ID,
    machine_client_id: opts.machine_client_id,
    machine_scope: opts.machine_scope,
  });

  // Stand-in for the narrow machine surface (posts/media/blogs GET).
  app.get(
    "/machine-surface",
    requireAdminOrMachine(),
    (req: Request, res: Response) => {
      res.status(200).json({
        adminSub: req.adminSub ?? null,
        machineClient: req.machineClient ?? null,
      });
    }
  );

  // Stand-in for every OTHER admin route (pages/sections/site-publish/…): a
  // machine token must be blocked here.
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

const ON = { machine_client_id: MACHINE_CLIENT_ID, machine_scope: MACHINE_SCOPE };

beforeEach(() => {
  mockVerifyAdmin.mockReset();
  mockVerifyMachine.mockReset();
});

describe("requireAdminOrMachine — admin ID-token path is unchanged", () => {
  it("accepts a valid admin token, sets adminSub, never touches the machine verifier", async () => {
    mockVerifyAdmin.mockResolvedValue(ADMIN_PAYLOAD);
    const app = buildApp(ON);

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer good.admin.token");

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-601");
    expect(res.body.machineClient).toBeNull();
    expect(mockVerifyAdmin).toHaveBeenCalledWith(
      "good.admin.token",
      POOL_ID,
      ADMIN_CLIENT_ID
    );
    // Admin succeeded first, so the machine path is never consulted.
    expect(mockVerifyMachine).not.toHaveBeenCalled();
  });

  it("returns 401 when no Authorization header is present", async () => {
    const app = buildApp(ON);
    const res = await request(app).get("/machine-surface");
    expect(res.status).toBe(401);
    expect(mockVerifyAdmin).not.toHaveBeenCalled();
    // No bearer at all → machine path short-circuits without a verify call.
    expect(mockVerifyMachine).not.toHaveBeenCalled();
  });

  it("returns 403 for a valid admin token whose group is not 'admins'", async () => {
    mockVerifyAdmin.mockResolvedValue({ sub: "u", "cognito:groups": ["viewers"] });
    // The wrong-group ID token is not a machine token either.
    mockVerifyMachine.mockRejectedValue(new Error("not an access token"));
    const app = buildApp(ON);

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer valid.wrong.group");

    expect(res.status).toBe(403);
  });
});

describe("requireAdminOrMachine — machine ACCESS-token path", () => {
  it("accepts a machine token carrying the scope and sets req.machineClient", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("token_use=access, wrong client"));
    mockVerifyMachine.mockResolvedValue({
      sub: MACHINE_CLIENT_ID,
      client_id: MACHINE_CLIENT_ID,
      scope: `openid ${MACHINE_SCOPE}`,
    });
    const app = buildApp(ON);

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer machine.access.token");

    expect(res.status).toBe(200);
    expect(res.body.machineClient).toBe(MACHINE_CLIENT_ID);
    expect(res.body.adminSub).toBeNull();
    // Verified as an ACCESS token against the MACHINE client, same pool.
    expect(mockVerifyMachine).toHaveBeenCalledWith(
      "machine.access.token",
      POOL_ID,
      MACHINE_CLIENT_ID
    );
  });

  it("defaults the required scope to portfolio-api/machine when machine_scope is unset", async () => {
    expect(DEFAULT_MACHINE_SCOPE).toBe("portfolio-api/machine");
    mockVerifyAdmin.mockRejectedValue(new Error("not an id token"));
    mockVerifyMachine.mockResolvedValue({
      sub: MACHINE_CLIENT_ID,
      scope: DEFAULT_MACHINE_SCOPE,
    });
    // machine_scope intentionally omitted from secrets.
    const app = buildApp({ machine_client_id: MACHINE_CLIENT_ID });

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer machine.access.token");

    expect(res.status).toBe(200);
    expect(res.body.machineClient).toBe(MACHINE_CLIENT_ID);
  });

  it("returns 403 for a valid machine token WITHOUT the required scope", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("not an id token"));
    mockVerifyMachine.mockResolvedValue({
      sub: MACHINE_CLIENT_ID,
      scope: "openid email", // no portfolio-api/machine
    });
    const app = buildApp(ON);

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer machine.wrong.scope");

    expect(res.status).toBe(403);
    expect(res.body.errorMsg).toBe("Forbidden");
  });

  it("returns 401 for a bad-signature token (both verifiers reject)", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("JwtInvalidSignatureError"));
    mockVerifyMachine.mockRejectedValue(new Error("JwtInvalidSignatureError"));
    const app = buildApp(ON);

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer tampered.token");

    expect(res.status).toBe(401);
  });
});

describe("requireAdminOrMachine — feature OFF (machine_client_id unset)", () => {
  it("behaves exactly like requireAdmin: a machine token yields 401 and the machine verifier is never called", async () => {
    // Even if it WERE called it would pass — prove it is not consulted at all.
    mockVerifyAdmin.mockRejectedValue(new Error("not an id token"));
    mockVerifyMachine.mockResolvedValue({
      sub: MACHINE_CLIENT_ID,
      scope: MACHINE_SCOPE,
    });
    const app = buildApp({}); // no machine_client_id

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer machine.access.token");

    expect(res.status).toBe(401);
    expect(mockVerifyMachine).not.toHaveBeenCalled();
  });

  it("still accepts a valid admin token on the machine surface when the feature is off", async () => {
    mockVerifyAdmin.mockResolvedValue(ADMIN_PAYLOAD);
    const app = buildApp({});

    const res = await request(app)
      .get("/machine-surface")
      .set("Authorization", "Bearer good.admin.token");

    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-601");
  });
});

describe("requireAdmin — a machine token is blocked (403) on every other admin route", () => {
  it("denies a valid machine token with 403 on a plain requireAdmin route", async () => {
    mockVerifyAdmin.mockRejectedValue(new Error("not an id token"));
    mockVerifyMachine.mockResolvedValue({
      sub: MACHINE_CLIENT_ID,
      scope: MACHINE_SCOPE, // even a fully-scoped machine token has no reach here
    });
    const app = buildApp(ON);

    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer machine.access.token");

    expect(res.status).toBe(403);
    expect(res.body.errorMsg).toBe("Forbidden");
  });

  it("still admits a real admin, and (feature off) is a strict no-op — machine token 401, verifier untouched", async () => {
    // Admin still works.
    mockVerifyAdmin.mockResolvedValue(ADMIN_PAYLOAD);
    let app = buildApp(ON);
    let res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer good.admin.token");
    expect(res.status).toBe(200);
    expect(res.body.adminSub).toBe("admin-sub-601");

    // Feature off: machine token → 401, and the machine verifier is never called.
    mockVerifyAdmin.mockReset();
    mockVerifyMachine.mockReset();
    mockVerifyAdmin.mockRejectedValue(new Error("not an id token"));
    mockVerifyMachine.mockResolvedValue({ sub: MACHINE_CLIENT_ID, scope: MACHINE_SCOPE });
    app = buildApp({});
    res = await request(app)
      .get("/admin-only")
      .set("Authorization", "Bearer machine.access.token");
    expect(res.status).toBe(401);
    expect(mockVerifyMachine).not.toHaveBeenCalled();
  });
});
