import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

/**
 * Spotify token store + reconnect persistence tests (§4.6) — the DB-backed half
 * of the admin reconnect flow, against a throwaway Postgres 15 cluster
 * (unix-socket-only, under /tmp, exactly as agent-pre-checks.md documents).
 * Spotify HTTP is a mocked global fetch and Cognito is a mocked verifier; the
 * database and migrations are real. The no-DB surface (state tokens, crypto,
 * guard behaviour, degrade paths) is covered in adminSpotify.test.ts.
 */

jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import app from "../src/app";
import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import {
  deleteStoredSpotifyToken,
  getStoredSpotifyToken,
  saveSpotifyRefreshToken,
  SPOTIFY_REFRESH_TOKEN_LIFETIME_MS,
  _resetSpotifyTokenStoreForTests,
} from "../src/services/spotifyTokenStore";
import {
  mintOAuthState,
  SPOTIFY_OAUTH_TOKEN_URL,
  _clearSpotifyOAuthStateForTests,
} from "../src/services/spotifyOAuthService";
import {
  SPOTIFY_NOW_PLAYING_URL,
  SPOTIFY_TOKEN_URL,
  _resetSpotifyStateForTests,
} from "../src/services/spotifyService";
import { IAppSecrets } from "../src/interfaces";

const mockVerify = verifyAdminIdToken as jest.Mock;
const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55439"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_spotify_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_spotify");

const CLIENT_SECRET = "client-secret-xyz";
const SECRETS: Partial<IAppSecrets> = {
  node_env: "development",
  port: "3002",
  spotify_client_id: "client-id-abc",
  spotify_client_secret: CLIENT_SECRET,
  spotify_refresh_token: "", // no static fallback: the store is what's under test
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
  _resetSpotifyTokenStoreForTests();
  _resetSpotifyStateForTests();
  await getDb()("service_tokens").del();
});

describe("spotifyTokenStore persistence", () => {
  it("migration created the service_tokens table", async () => {
    const res = await getDb().raw(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'service_tokens'`
    );
    expect(res.rows).toHaveLength(1);
  });

  it("save → get round-trips, storing ONLY ciphertext at rest", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "stored-refresh-token");

    const row = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    expect(row.token_ciphertext.startsWith("v1:")).toBe(true);
    expect(row.token_ciphertext).not.toContain("stored-refresh-token");

    _resetSpotifyTokenStoreForTests(); // force the next read through the DB
    const stored = await getStoredSpotifyToken(CLIENT_SECRET);
    expect(stored?.refreshToken).toBe("stored-refresh-token");
    expect(stored?.authorizedAt).toBeInstanceOf(Date);
  });

  it("re-saving upserts the single row and restarts the 180-day window", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "first-token");
    const first = await getStoredSpotifyToken(CLIENT_SECRET);

    await saveSpotifyRefreshToken(CLIENT_SECRET, "second-token");
    _resetSpotifyTokenStoreForTests();
    const second = await getStoredSpotifyToken(CLIENT_SECRET);

    expect(second?.refreshToken).toBe("second-token");
    expect(second!.authorizedAt.getTime()).toBeGreaterThanOrEqual(
      first!.authorizedAt.getTime()
    );
    expect(
      await getDb()("service_tokens").where({ service: "spotify" })
    ).toHaveLength(1);
  });

  it("returns null (degrade, not throw) when the client secret rotated", async () => {
    await saveSpotifyRefreshToken("old-secret", "stored-refresh-token");
    _resetSpotifyTokenStoreForTests();
    await expect(getStoredSpotifyToken("new-secret")).resolves.toBeNull();
  });

  it("delete removes the row and reports whether one existed", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "stored-refresh-token");
    await expect(deleteStoredSpotifyToken()).resolves.toBe(true);
    await expect(deleteStoredSpotifyToken()).resolves.toBe(false);
    _resetSpotifyTokenStoreForTests();
    await expect(getStoredSpotifyToken(CLIENT_SECRET)).resolves.toBeNull();
  });
});

describe("reconnect flow end-to-end (callback → store → now-playing)", () => {
  it("callback exchanges the code, persists the token, and redirects connected", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_OAUTH_TOKEN_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ refresh_token: "minted-by-callback" }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const state = mintOAuthState("http://localhost:5174/integrations");
    const res = await request(app).get(
      `/api/admin/spotify/callback?state=${state}&code=auth-code-1`
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://localhost:5174/integrations?spotify=connected"
    );

    _resetSpotifyTokenStoreForTests();
    const stored = await getStoredSpotifyToken(CLIENT_SECRET);
    expect(stored?.refreshToken).toBe("minted-by-callback");
  });

  it("status reports the admin source with the 180-day expiry", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "stored-refresh-token");

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.connected).toBe(true);
    expect(res.body.data.source).toBe("admin");
    const authorizedAt = new Date(res.body.data.authorized_at).getTime();
    const expiresAt = new Date(res.body.data.expires_at).getTime();
    expect(expiresAt - authorizedAt).toBe(SPOTIFY_REFRESH_TOKEN_LIFETIME_MS);
    // The token itself never appears in the status payload.
    expect(JSON.stringify(res.body)).not.toContain("stored-refresh-token");
  });

  it("/api/now-playing refreshes with the STORED token, not the secrets one", async () => {
    app.set("secrets", { ...SECRETS, spotify_refresh_token: "stale-secrets-token" });
    try {
      await saveSpotifyRefreshToken(CLIENT_SECRET, "stored-refresh-token");

      mockFetch.mockImplementation((url: string) => {
        if (url === SPOTIFY_TOKEN_URL) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ access_token: "at-1", expires_in: 3600 }),
          });
        }
        if (url === SPOTIFY_NOW_PLAYING_URL) {
          return Promise.resolve({ ok: false, status: 204, json: async () => ({}) });
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      });

      const res = await request(app).get("/api/now-playing");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ playing: false }); // 204 = idle, normal

      const tokenCall = mockFetch.mock.calls.find((c) => c[0] === SPOTIFY_TOKEN_URL);
      const body = String((tokenCall![1] as RequestInit).body);
      expect(body).toContain("refresh_token=stored-refresh-token");
      expect(body).not.toContain("stale-secrets-token");
    } finally {
      app.set("secrets", SECRETS);
    }
  });

  it("DELETE /api/admin/spotify removes the stored token", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "stored-refresh-token");

    const res = await request(app)
      .delete("/api/admin/spotify")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });

    _resetSpotifyTokenStoreForTests();
    await expect(getStoredSpotifyToken(CLIENT_SECRET)).resolves.toBeNull();
  });
});
