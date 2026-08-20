import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

/**
 * Admin integrations router tests (§4.7) over a throwaway Postgres 15 cluster
 * (unix-socket-only, under /tmp, as agent-pre-checks.md documents). Upstream
 * HTTP is a mocked global fetch and Cognito is a mocked verifier; the database
 * and migrations are real.
 *
 * Now-playing is listener-only, so the generalized integrations surface carries
 * only the credential kinds — github ('api_key', a PAT) and duolingo ('value',
 * a public username) — plus the connect-listener credential endpoints
 * (`sp_dc`) and the listener-only `/spotify/status` contract.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import app from "../src/app";
import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import {
  getStoredServiceToken,
  _resetServiceTokenStoreForTests,
} from "../src/services/serviceTokenStore";
import { IAppSecrets } from "../src/interfaces";

const mockVerify = verifyAdminIdToken as jest.Mock;
const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55447";
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_integrations_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_integrations");

const SECRETS: Partial<IAppSecrets> = {
  node_env: "development",
  port: "3002",
};

const mockFetch = jest.fn();

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
  app.set("secrets", SECRETS);
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(async () => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
  _resetServiceTokenStoreForTests();
  app.set("secrets", SECRETS);
  app.set("upstream", null);
  await getDb()("service_tokens").del();
});

describe("GET /api/admin/integrations (§4.7 enumeration)", () => {
  it("requires an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const res = await request(app).get("/api/admin/integrations");
    expect(res.status).toBe(401);
  });

  it("lists the credential integrations (github, duolingo) as disconnected", async () => {
    const res = await request(app).get("/api/admin/integrations").set(...AUTH);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      res.body.data.integrations.map((e: { key: string }) => [e.key, e])
    );
    expect(Object.keys(byKey).sort()).toEqual(["duolingo", "github"]);
    expect(byKey.github).toMatchObject({
      key: "github",
      auth_kind: "api_key",
      connected: false,
      source: null,
    });
    expect(byKey.duolingo).toMatchObject({
      key: "duolingo",
      auth_kind: "value",
      connected: false,
      source: null,
    });
    // Spotify is NOT a generalized integration anymore (listener-only).
    expect(byKey.spotify).toBeUndefined();
  });
});

describe("PUT /api/admin/integrations/:key/value (api_key/value kinds)", () => {
  it("stores a github PAT as ciphertext and reports it connected", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/github/value")
      .set(...AUTH)
      .send({ value: "ghp_secretPAT" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      key: "github",
      connected: true,
      source: "admin",
    });
    // Stored encrypted, never echoed.
    const raw = await getDb()("service_tokens").where({ service: "github" }).first();
    expect(raw.token_ciphertext).not.toContain("ghp_secretPAT");
    expect(JSON.stringify(res.body)).not.toContain("ghp_secretPAT");
  });

  it("round-trips a duolingo username (value kind)", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/duolingo/value")
      .set(...AUTH)
      .send({ value: "ben_learns" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ key: "duolingo", connected: true });
    const stored = await getStoredServiceToken("duolingo", "");
    expect(stored?.token).toBe("ben_learns");
  });

  it("rejects an empty value with 400", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/github/value")
      .set(...AUTH)
      .send({ value: "  " });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown integration key", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/nope/value")
      .set(...AUTH)
      .send({ value: "x" });
    expect(res.status).toBe(404);
  });

  it("requires an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const res = await request(app)
      .put("/api/admin/integrations/github/value")
      .send({ value: "x" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/admin/integrations/:key", () => {
  it("removes a stored credential", async () => {
    await request(app)
      .put("/api/admin/integrations/github/value")
      .set(...AUTH)
      .send({ value: "ghp_x" });
    const res = await request(app)
      .delete("/api/admin/integrations/github")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    const stored = await getStoredServiceToken("github", "");
    expect(stored).toBeNull();
  });

  it("404s deleting an unknown integration key", async () => {
    const res = await request(app)
      .delete("/api/admin/integrations/nope")
      .set(...AUTH);
    expect(res.status).toBe(404);
  });
});

describe("connect-listener credential (sp_dc) endpoints", () => {
  it("PUT stores the sp_dc cookie write-only and never echoes it", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "SECRET_SP_DC_COOKIE" });
    expect(res.status).toBe(204);
    const raw = await getDb()("service_tokens")
      .where({ service: "spotify_listener" })
      .first();
    expect(raw).toBeTruthy();
    expect(raw.token_ciphertext).not.toContain("SECRET_SP_DC_COOKIE");
    expect(JSON.stringify(res.body)).not.toContain("SECRET_SP_DC_COOKIE");
  });

  it("PUT 400s on an empty sp_dc", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "" });
    expect(res.status).toBe(400);
  });

  it("DELETE removes the stored cookie (idempotent 204)", async () => {
    await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "cookie" });
    const first = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set(...AUTH);
    expect(first.status).toBe(204);
    const second = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set(...AUTH);
    expect(second.status).toBe(204);
    const raw = await getDb()("service_tokens")
      .where({ service: "spotify_listener" })
      .first();
    expect(raw).toBeUndefined();
  });

  it("both endpoints require an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const put = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .send({ sp_dc: "x" });
    expect(put.status).toBe(401);
    const del = await request(app).delete(
      "/api/admin/integrations/spotify/listener"
    );
    expect(del.status).toBe(401);
  });
});

describe("GET /api/admin/spotify/status (listener-only contract)", () => {
  it("requires an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const res = await request(app).get("/api/admin/spotify/status");
    expect(res.status).toBe(401);
  });

  it("reports no_credential + source none when no listener cookie is stored", async () => {
    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      source: "none",
      listener: {
        state: "no_credential",
        credential_present: false,
        last_event_at: null,
        error_kind: null,
      },
    });
  });

  it("reports listener state 'unknown' when a cookie is stored but Redis is unwired", async () => {
    await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "cookie" });
    app.set("upstream", null);
    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      source: "none",
      listener: { state: "unknown", credential_present: true },
    });
  });
});
