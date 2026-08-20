import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

/**
 * Spotify listener credential store + admin grant endpoints (task #115).
 *
 * The `sp_dc` cookie is the long-lived Spotify web-player session cookie the
 * connect-listener will use. It must live in `service_tokens` under the
 * `spotify_listener` service key (§4.7), AES-256-GCM at rest, and be
 * write-only from the admin surface (never echoed back, never logged).
 *
 * Tests run against a throwaway Postgres 15 cluster (unix-socket-only, under
 * /tmp, per agent-pre-checks.md). Cognito is a mocked verifier; no network is
 * touched. The store shares the generalized `serviceTokenStore` implementation
 * covered in adjacent tests, so this file focuses on the listener-specific
 * facade, the write-only endpoint semantics, and the idempotent delete.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import app from "../src/app";
import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import {
  deleteListenerCredential,
  getListenerCredential,
  getListenerCredentialUpdatedAt,
  saveListenerCredential,
  SPOTIFY_LISTENER_SERVICE_KEY,
  _resetListenerCredentialStoreForTests,
} from "../src/services/listenerCredentialStore";
import { IAppSecrets } from "../src/interfaces";

const mockVerify = verifyAdminIdToken as jest.Mock;
const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55451"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_listener_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_listener");

const CLIENT_SECRET = "client-secret-xyz";
const SECRETS: Partial<IAppSecrets> = {
  node_env: "development",
  port: "3002",
  spotify_client_id: "client-id-abc",
  spotify_client_secret: CLIENT_SECRET,
};

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
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
  _resetListenerCredentialStoreForTests();
  app.set("secrets", SECRETS);
  await getDb()("service_tokens").del();
});

// ============================================================================
// Store facade (unit)
// ============================================================================

describe("listenerCredentialStore facade", () => {
  it("uses the `spotify_listener` service key", () => {
    expect(SPOTIFY_LISTENER_SERVICE_KEY).toBe("spotify_listener");
  });

  it("save → get round-trips, storing ONLY ciphertext at rest", async () => {
    await saveListenerCredential(CLIENT_SECRET, "sp-dc-cookie-value");

    const row = await getDb()("service_tokens")
      .where({ service: SPOTIFY_LISTENER_SERVICE_KEY })
      .first();
    expect(row.token_ciphertext.startsWith("v1:")).toBe(true);
    expect(row.token_ciphertext).not.toContain("sp-dc-cookie-value");

    _resetListenerCredentialStoreForTests(); // force the next read through the DB
    const stored = await getListenerCredential(CLIENT_SECRET);
    expect(stored?.spDc).toBe("sp-dc-cookie-value");
    expect(stored?.authorizedAt).toBeInstanceOf(Date);
  });

  it("re-saving upserts the single row", async () => {
    await saveListenerCredential(CLIENT_SECRET, "first-cookie");
    await saveListenerCredential(CLIENT_SECRET, "second-cookie");

    _resetListenerCredentialStoreForTests();
    const stored = await getListenerCredential(CLIENT_SECRET);
    expect(stored?.spDc).toBe("second-cookie");
    expect(
      await getDb()("service_tokens").where({
        service: SPOTIFY_LISTENER_SERVICE_KEY,
      })
    ).toHaveLength(1);
  });

  it("returns null (degrade, not throw) when the encryption key rotated", async () => {
    await saveListenerCredential("old-secret", "sp-dc-cookie");
    _resetListenerCredentialStoreForTests();
    await expect(getListenerCredential("new-secret")).resolves.toBeNull();
  });

  it("returns null when nothing is stored", async () => {
    await expect(getListenerCredential(CLIENT_SECRET)).resolves.toBeNull();
    await expect(getListenerCredentialUpdatedAt()).resolves.toBeNull();
  });

  it("getListenerCredentialUpdatedAt returns the row's updated_at timestamp", async () => {
    await saveListenerCredential(CLIENT_SECRET, "sp-dc-cookie");
    const updatedAt = await getListenerCredentialUpdatedAt();
    expect(updatedAt).toBeInstanceOf(Date);
  });

  it("delete removes the row and reports whether one existed", async () => {
    await saveListenerCredential(CLIENT_SECRET, "sp-dc-cookie");
    await expect(deleteListenerCredential()).resolves.toBe(true);
    await expect(deleteListenerCredential()).resolves.toBe(false);
    _resetListenerCredentialStoreForTests();
    await expect(getListenerCredential(CLIENT_SECRET)).resolves.toBeNull();
  });

  it("save rejects an empty encryption key or value", async () => {
    await expect(saveListenerCredential("", "sp-dc")).rejects.toThrow();
    await expect(saveListenerCredential(CLIENT_SECRET, "")).rejects.toThrow();
  });
});

// ============================================================================
// PUT /api/admin/integrations/spotify/listener
// ============================================================================

describe("PUT /api/admin/integrations/spotify/listener", () => {
  it("requires an admin bearer (401 with no token / bad token / machine key)", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const noAuth = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .send({ sp_dc: "sp-dc-cookie" });
    expect(noAuth.status).toBe(401);

    const badBearer = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set("Authorization", "Bearer nope")
      .send({ sp_dc: "sp-dc-cookie" });
    expect(badBearer.status).toBe(401);

    // Machine (pv6k_) bearers must be denied on humans-only routes.
    const machine = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set("Authorization", "Bearer pv6k_fake_key")
      .send({ sp_dc: "sp-dc-cookie" });
    expect(machine.status).toBe(401);

    // The store was never touched.
    expect(
      await getDb()("service_tokens").where({
        service: SPOTIFY_LISTENER_SERVICE_KEY,
      })
    ).toHaveLength(0);
  });

  it("saves the sp_dc as ciphertext under `spotify_listener` and returns 204", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "AQ_super_secret_spdc_cookie" });

    expect(res.status).toBe(204);
    // 204 means empty body. The stored value MUST NEVER appear in the response.
    expect(res.text).toBe("");
    expect(JSON.stringify(res.body)).not.toContain(
      "AQ_super_secret_spdc_cookie"
    );

    // At rest: exactly one row under `spotify_listener`, ciphertext-only.
    const rows = await getDb()("service_tokens").where({
      service: SPOTIFY_LISTENER_SERVICE_KEY,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].token_ciphertext.startsWith("v1:")).toBe(true);
    expect(rows[0].token_ciphertext).not.toContain(
      "AQ_super_secret_spdc_cookie"
    );

    // The store's read path returns the plaintext.
    _resetListenerCredentialStoreForTests();
    const stored = await getListenerCredential(CLIENT_SECRET);
    expect(stored?.spDc).toBe("AQ_super_secret_spdc_cookie");
  });

  it("trims whitespace and stores the trimmed value", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "   sp-dc-with-spaces   " });
    expect(res.status).toBe(204);

    _resetListenerCredentialStoreForTests();
    const stored = await getListenerCredential(CLIENT_SECRET);
    expect(stored?.spDc).toBe("sp-dc-with-spaces");
  });

  it("rejects an empty / whitespace / non-string sp_dc with 400", async () => {
    for (const body of [{}, { sp_dc: "" }, { sp_dc: "   " }, { sp_dc: 42 }]) {
      const res = await request(app)
        .put("/api/admin/integrations/spotify/listener")
        .set(...AUTH)
        .send(body);
      expect(res.status).toBe(400);
    }
    // Nothing was stored for any of the rejected payloads.
    expect(
      await getDb()("service_tokens").where({
        service: SPOTIFY_LISTENER_SERVICE_KEY,
      })
    ).toHaveLength(0);
  });

  it("does NOT log the stored value", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await request(app)
        .put("/api/admin/integrations/spotify/listener")
        .set(...AUTH)
        .send({ sp_dc: "NEVER_LOG_THIS_COOKIE_VALUE" });
      expect(res.status).toBe(204);

      for (const spy of [logSpy, errSpy, warnSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(
            "NEVER_LOG_THIS_COOKIE_VALUE"
          );
        }
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("re-PUT upserts (the single row is replaced, not duplicated)", async () => {
    await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "first-cookie" });
    await request(app)
      .put("/api/admin/integrations/spotify/listener")
      .set(...AUTH)
      .send({ sp_dc: "second-cookie" });

    const rows = await getDb()("service_tokens").where({
      service: SPOTIFY_LISTENER_SERVICE_KEY,
    });
    expect(rows).toHaveLength(1);

    _resetListenerCredentialStoreForTests();
    const stored = await getListenerCredential(CLIENT_SECRET);
    expect(stored?.spDc).toBe("second-cookie");
  });
});

// ============================================================================
// DELETE /api/admin/integrations/spotify/listener
// ============================================================================

describe("DELETE /api/admin/integrations/spotify/listener", () => {
  it("requires an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const noAuth = await request(app).delete(
      "/api/admin/integrations/spotify/listener"
    );
    expect(noAuth.status).toBe(401);

    const machine = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set("Authorization", "Bearer pv6k_fake_key");
    expect(machine.status).toBe(401);
  });

  it("removes the stored sp_dc and returns 204", async () => {
    await saveListenerCredential(CLIENT_SECRET, "sp-dc-to-delete");

    const res = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set(...AUTH);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    expect(
      await getDb()("service_tokens").where({
        service: SPOTIFY_LISTENER_SERVICE_KEY,
      })
    ).toHaveLength(0);

    _resetListenerCredentialStoreForTests();
    await expect(getListenerCredential(CLIENT_SECRET)).resolves.toBeNull();
  });

  it("is idempotent (204 even when nothing was stored)", async () => {
    const first = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set(...AUTH);
    expect(first.status).toBe(204);

    // A second delete against an empty row set MUST also succeed.
    const second = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set(...AUTH);
    expect(second.status).toBe(204);
  });

  it("does NOT touch other integrations' stored tokens", async () => {
    // Seed a stored spotify (OAuth refresh token) row, plus a listener row.
    await getDb()("service_tokens").insert({
      service: "spotify",
      token_ciphertext: "v1:should-not-be-touched",
      authorized_at: new Date(),
      updated_at: new Date(),
    });
    await saveListenerCredential(CLIENT_SECRET, "listener-cookie");

    const res = await request(app)
      .delete("/api/admin/integrations/spotify/listener")
      .set(...AUTH);
    expect(res.status).toBe(204);

    // spotify row still there, listener row gone.
    const spotifyRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    expect(spotifyRow).toBeDefined();
    expect(
      await getDb()("service_tokens").where({
        service: SPOTIFY_LISTENER_SERVICE_KEY,
      })
    ).toHaveLength(0);
  });
});
