import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

/**
 * Admin integrations router tests (§4.7) — the generalized /api/admin/integrations
 * surface over a throwaway Postgres 15 cluster (unix-socket-only, under /tmp, as
 * agent-pre-checks.md documents). Upstream HTTP is a mocked global fetch and
 * Cognito is a mocked verifier; the database and migrations are real.
 *
 * Covers all three auth kinds — spotify ('oauth'), github ('api_key', a PAT),
 * duolingo ('value', a public username) — plus the legacy /api/admin/spotify/*
 * aliases that must keep working until the admin's own task migrates.
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
import {
  mintOAuthState,
  SPOTIFY_OAUTH_TOKEN_URL,
  _clearSpotifyOAuthStateForTests,
} from "../src/services/spotifyOAuthService";
import {
  SPOTIFY_REFRESH_TOKEN_LIFETIME_MS,
} from "../src/services/spotifyTokenStore";
import { _resetSpotifyStateForTests } from "../src/services/spotifyService";
import { IAppSecrets } from "../src/interfaces";

const mockVerify = verifyAdminIdToken as jest.Mock;
const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55447"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_integrations_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_integrations");

const CLIENT_SECRET = "client-secret-xyz";
const SECRETS: Partial<IAppSecrets> = {
  node_env: "development",
  port: "3002",
  spotify_client_id: "client-id-abc",
  spotify_client_secret: CLIENT_SECRET,
  spotify_refresh_token: "", // no static fallback unless a test sets one
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
  _clearSpotifyOAuthStateForTests();
  _resetServiceTokenStoreForTests();
  _resetSpotifyStateForTests();
  app.set("secrets", SECRETS);
  await getDb()("service_tokens").del();
});

describe("GET /api/admin/integrations (§4.7 enumeration)", () => {
  it("requires an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const res = await request(app).get("/api/admin/integrations");
    expect(res.status).toBe(401);
  });

  it("lists all three integrations with correct kinds and disconnected status", async () => {
    const res = await request(app).get("/api/admin/integrations").set(...AUTH);
    expect(res.status).toBe(200);

    const byKey: Record<string, any> = {};
    for (const entry of res.body.data.integrations) byKey[entry.key] = entry;

    expect(Object.keys(byKey).sort()).toEqual(["duolingo", "github", "spotify"]);

    expect(byKey.spotify).toMatchObject({
      key: "spotify",
      name: "Spotify",
      auth_kind: "oauth",
      connected: false,
      source: null,
      authorized_at: null,
      expires_at: null,
    });
    expect(byKey.github).toMatchObject({
      key: "github",
      name: "GitHub",
      auth_kind: "api_key",
      connected: false,
      source: null,
    });
    expect(byKey.duolingo).toMatchObject({
      key: "duolingo",
      name: "Duolingo",
      auth_kind: "value",
      connected: false,
      source: null,
    });
  });

  it("reports the spotify secrets fallback when only the static secret is set", async () => {
    app.set("secrets", { ...SECRETS, spotify_refresh_token: "static-token" });
    try {
      const res = await request(app).get("/api/admin/integrations").set(...AUTH);
      const spotify = res.body.data.integrations.find(
        (e: any) => e.key === "spotify"
      );
      expect(spotify).toMatchObject({
        connected: true,
        source: "secrets",
        authorized_at: null,
        expires_at: null,
      });
      expect(JSON.stringify(res.body)).not.toContain("static-token");
    } finally {
      app.set("secrets", SECRETS);
    }
  });
});

describe("PUT /api/admin/integrations/:key/value (api_key/value kinds)", () => {
  it("stores a github PAT as ciphertext and reports it connected", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/github/value")
      .set(...AUTH)
      .send({ value: "ghp_secretPAT123" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      key: "github",
      auth_kind: "api_key",
      connected: true,
      source: "admin",
      expires_at: null, // github never expires
    });
    expect(res.body.data.authorized_at).not.toBeNull();
    // The response NEVER echoes the stored value.
    expect(JSON.stringify(res.body)).not.toContain("ghp_secretPAT123");

    // At rest it is ciphertext, not the plaintext PAT.
    const row = await getDb()("service_tokens")
      .where({ service: "github" })
      .first();
    expect(row.token_ciphertext.startsWith("v1:")).toBe(true);
    expect(row.token_ciphertext).not.toContain("ghp_secretPAT123");

    // …but the store can retrieve the plaintext.
    _resetServiceTokenStoreForTests();
    const stored = await getStoredServiceToken("github", CLIENT_SECRET);
    expect(stored?.token).toBe("ghp_secretPAT123");
  });

  it("round-trips a duolingo username (value kind)", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/duolingo/value")
      .set(...AUTH)
      .send({ value: "cooldev" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      key: "duolingo",
      auth_kind: "value",
      connected: true,
      source: "admin",
    });

    _resetServiceTokenStoreForTests();
    const stored = await getStoredServiceToken("duolingo", CLIENT_SECRET);
    expect(stored?.token).toBe("cooldev");
  });

  it("rejects an empty value with 400", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/github/value")
      .set(...AUTH)
      .send({ value: "   " });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown integration key", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/myspace/value")
      .set(...AUTH)
      .send({ value: "x" });
    expect(res.status).toBe(404);
  });

  it("409s when trying to set a value on the oauth spotify integration", async () => {
    const res = await request(app)
      .put("/api/admin/integrations/spotify/value")
      .set(...AUTH)
      .send({ value: "should-not-store" });
    expect(res.status).toBe(409);
    const row = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    expect(row).toBeUndefined();
  });

  it("requires an admin bearer", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const res = await request(app)
      .put("/api/admin/integrations/github/value")
      .send({ value: "x" });
    expect(res.status).toBe(401);
  });
});

describe("oauth connect/callback (parameterized + legacy alias)", () => {
  function mockTokenExchange(refreshToken: string): void {
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_OAUTH_TOKEN_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ refresh_token: refreshToken }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
  }

  it("connect returns an authorize URL on the parameterized path", async () => {
    const res = await request(app)
      .post("/api/admin/integrations/spotify/connect")
      .set(...AUTH)
      .send({ return_to: "http://localhost:5174/integrations" });
    expect(res.status).toBe(200);
    const url = new URL(res.body.data.authorize_url);
    expect(url.searchParams.get("client_id")).toBe("client-id-abc");
    expect(res.body.data.authorize_url).not.toContain("localhost:5174");
  });

  it("409s connect for a non-oauth integration", async () => {
    const res = await request(app)
      .post("/api/admin/integrations/github/connect")
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(409);
  });

  it("callback (parameterized) exchanges the code and persists the token", async () => {
    mockTokenExchange("minted-via-integrations");
    const state = mintOAuthState("http://localhost:5174/integrations");
    const res = await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=auth-code-1`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://localhost:5174/integrations?spotify=connected"
    );

    _resetServiceTokenStoreForTests();
    const stored = await getStoredServiceToken("spotify", CLIENT_SECRET);
    expect(stored?.token).toBe("minted-via-integrations");
  });

  it("callback (legacy /spotify alias) still works identically", async () => {
    mockTokenExchange("minted-via-legacy");
    const state = mintOAuthState("http://localhost:5174/integrations");
    const res = await request(app).get(
      `/api/admin/spotify/callback?state=${state}&code=auth-code-2`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://localhost:5174/integrations?spotify=connected"
    );

    _resetServiceTokenStoreForTests();
    const stored = await getStoredServiceToken("spotify", CLIENT_SECRET);
    expect(stored?.token).toBe("minted-via-legacy");
  });

  it("legacy /spotify/status reports the admin source with 180-day expiry", async () => {
    // Seed via the parameterized callback, then read via the legacy alias.
    mockTokenExchange("stored-refresh-token");
    const state = mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.connected).toBe(true);
    expect(res.body.data.source).toBe("admin");
    const authorizedAt = new Date(res.body.data.authorized_at).getTime();
    const expiresAt = new Date(res.body.data.expires_at).getTime();
    expect(expiresAt - authorizedAt).toBe(SPOTIFY_REFRESH_TOKEN_LIFETIME_MS);
    expect(JSON.stringify(res.body)).not.toContain("stored-refresh-token");
  });

  it("GET /integrations shows spotify connected with an expiry after the oauth flow", async () => {
    mockTokenExchange("stored-refresh-token");
    const state = mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    const res = await request(app).get("/api/admin/integrations").set(...AUTH);
    const spotify = res.body.data.integrations.find(
      (e: any) => e.key === "spotify"
    );
    expect(spotify.connected).toBe(true);
    expect(spotify.source).toBe("admin");
    expect(spotify.expires_at).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("stored-refresh-token");
  });
});

describe("DELETE /api/admin/integrations/:key (any kind)", () => {
  it("removes a stored api_key credential", async () => {
    await request(app)
      .put("/api/admin/integrations/github/value")
      .set(...AUTH)
      .send({ value: "ghp_deleteme" });

    const del = await request(app)
      .delete("/api/admin/integrations/github")
      .set(...AUTH);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ deleted: true });

    _resetServiceTokenStoreForTests();
    expect(await getStoredServiceToken("github", CLIENT_SECRET)).toBeNull();

    // Deleting again reports false (nothing to remove).
    const again = await request(app)
      .delete("/api/admin/integrations/github")
      .set(...AUTH);
    expect(again.body.data).toEqual({ deleted: false });
  });

  it("removes a stored oauth (spotify) credential via the parameterized path", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_OAUTH_TOKEN_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ refresh_token: "to-delete" }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    const state = mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    const del = await request(app)
      .delete("/api/admin/integrations/spotify")
      .set(...AUTH);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ deleted: true });

    _resetServiceTokenStoreForTests();
    expect(await getStoredServiceToken("spotify", CLIENT_SECRET)).toBeNull();
  });

  it("404s deleting an unknown integration key", async () => {
    const res = await request(app)
      .delete("/api/admin/integrations/myspace")
      .set(...AUTH);
    expect(res.status).toBe(404);
  });
});
