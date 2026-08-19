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
  rotateSpotifyRefreshToken,
  saveSpotifyRefreshToken,
  SPOTIFY_REFRESH_TOKEN_LIFETIME_MS,
  _resetSpotifyTokenStoreForTests,
} from "../src/services/spotifyTokenStore";
import {
  mintOAuthState,
  SPOTIFY_OAUTH_TOKEN_URL,
  clearOAuthStates,
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
  // Task #112 killed the static spotify_refresh_token fallback — the store
  // is now the ONLY grant source.
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
  await clearOAuthStates();
  _resetSpotifyTokenStoreForTests();
  _resetSpotifyStateForTests();
  await getDb()("service_tokens").del();
  await getDb()("service_settings").del();
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

describe("rotateSpotifyRefreshToken (task #112)", () => {
  it("persists the rotated ciphertext and preserves authorized_at", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "original-token");
    const before = await getStoredSpotifyToken(CLIENT_SECRET);
    const originalAuthorizedAt = before!.authorizedAt.getTime();
    const beforeRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    const beforeCiphertext = beforeRow.token_ciphertext;

    // Wait a real millisecond so updated_at is strictly greater than
    // authorized_at (Postgres timestamp resolution is microseconds).
    await new Promise((r) => setTimeout(r, 5));

    const rotated = await rotateSpotifyRefreshToken(
      CLIENT_SECRET,
      "rotated-token"
    );
    expect(rotated).toBe(true);

    const afterRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    // Ciphertext changed (proof the rotated token was actually persisted).
    expect(afterRow.token_ciphertext).not.toBe(beforeCiphertext);
    expect(afterRow.token_ciphertext.startsWith("v1:")).toBe(true);
    expect(afterRow.token_ciphertext).not.toContain("rotated-token");
    // authorized_at was PRESERVED — rotation does not extend the 180-day window.
    expect(new Date(afterRow.authorized_at).getTime()).toBe(
      originalAuthorizedAt
    );

    // Fresh read from DB (bypass cache) surfaces the rotated plaintext
    // with the ORIGINAL authorized_at.
    _resetSpotifyTokenStoreForTests();
    const after = await getStoredSpotifyToken(CLIENT_SECRET);
    expect(after?.refreshToken).toBe("rotated-token");
    expect(after!.authorizedAt.getTime()).toBe(originalAuthorizedAt);
  });

  it("returns false when no row exists (no-op, no accidental insert)", async () => {
    // Nothing stored — rotation MUST NOT create a fresh row (that would
    // start a new 180-day window we did not actually earn).
    const rotated = await rotateSpotifyRefreshToken(
      CLIENT_SECRET,
      "phantom-token"
    );
    expect(rotated).toBe(false);
    const rows = await getDb()("service_tokens").where({ service: "spotify" });
    expect(rows).toHaveLength(0);
  });

  it("is idempotent / last-write-wins under repeated rotations", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "original-token");
    const originalAuthorizedAt = (await getStoredSpotifyToken(
      CLIENT_SECRET
    ))!.authorizedAt.getTime();

    for (const t of ["rotated-1", "rotated-2", "rotated-3"]) {
      const ok = await rotateSpotifyRefreshToken(CLIENT_SECRET, t);
      expect(ok).toBe(true);
    }

    _resetSpotifyTokenStoreForTests();
    const stored = await getStoredSpotifyToken(CLIENT_SECRET);
    expect(stored?.refreshToken).toBe("rotated-3");
    expect(stored!.authorizedAt.getTime()).toBe(originalAuthorizedAt);
    // Still exactly one row (upsert-style semantics).
    expect(
      await getDb()("service_tokens").where({ service: "spotify" })
    ).toHaveLength(1);
  });
});

describe("rotation persistence via Spotify refresh response (task #112)", () => {
  it("persists a rotated refresh_token from a Spotify token refresh, preserving authorized_at", async () => {
    // Seed the store with an original grant.
    await saveSpotifyRefreshToken(CLIENT_SECRET, "original-refresh-token");
    const originalRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    const originalAuthorizedAt = new Date(originalRow.authorized_at).getTime();
    const originalCiphertext = originalRow.token_ciphertext;

    // Spotify's refresh response includes a rotated refresh_token (June 2026
    // policy). The router path must exchange with the ORIGINAL and persist
    // the NEW one before returning to the caller.
    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "at-1",
            expires_in: 3600,
            refresh_token: "rotated-refresh-token",
          }),
        });
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) {
        return Promise.resolve({
          ok: false,
          status: 204,
          json: async () => ({}),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    // Wait a real millisecond so updated_at is strictly greater than authorized_at.
    await new Promise((r) => setTimeout(r, 5));

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);

    // Token request went out with the ORIGINAL, not the rotated one.
    const tokenCall = mockFetch.mock.calls.find(
      (c) => c[0] === SPOTIFY_TOKEN_URL
    );
    expect(String((tokenCall![1] as RequestInit).body)).toContain(
      "refresh_token=original-refresh-token"
    );

    // The rotated refresh_token has been PERSISTED — the ciphertext at rest
    // changed, and the next store read surfaces the new plaintext.
    const rotatedRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    expect(rotatedRow.token_ciphertext).not.toBe(originalCiphertext);
    // authorized_at PRESERVED — the 180-day window still starts at grant time.
    expect(new Date(rotatedRow.authorized_at).getTime()).toBe(
      originalAuthorizedAt
    );

    _resetSpotifyTokenStoreForTests();
    const persisted = await getStoredSpotifyToken(CLIENT_SECRET);
    expect(persisted?.refreshToken).toBe("rotated-refresh-token");
    expect(persisted!.authorizedAt.getTime()).toBe(originalAuthorizedAt);
  });

  it("does NOT touch the store when Spotify's refresh response has no rotated refresh_token", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "original-refresh-token");
    const beforeRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();

    mockFetch.mockImplementation((url: string) => {
      if (url === SPOTIFY_TOKEN_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ access_token: "at-1", expires_in: 3600 }),
        });
      }
      if (url === SPOTIFY_NOW_PLAYING_URL) {
        return Promise.resolve({
          ok: false,
          status: 204,
          json: async () => ({}),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);

    const afterRow = await getDb()("service_tokens")
      .where({ service: "spotify" })
      .first();
    // Row unchanged — no rotation happened.
    expect(afterRow.token_ciphertext).toBe(beforeRow.token_ciphertext);
    expect(new Date(afterRow.authorized_at).getTime()).toBe(
      new Date(beforeRow.authorized_at).getTime()
    );
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

    const state = await mintOAuthState("http://localhost:5174/integrations");
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

  it("status reports authorized_at + 180-day expiry with the new truthful contract", async () => {
    await saveSpotifyRefreshToken(CLIENT_SECRET, "stored-refresh-token");

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);

    expect(res.status).toBe(200);
    // Task #113: the new truthful contract. With a stored grant and no
    // observed error/backoff/disable, the state is `connected` and the
    // 180-day expiry hangs off the grant's authorized_at.
    expect(res.body.data.state).toBe("connected");
    const authorizedAt = new Date(res.body.data.authorized_at).getTime();
    const expiresAt = new Date(res.body.data.expires_at).getTime();
    expect(expiresAt - authorizedAt).toBe(SPOTIFY_REFRESH_TOKEN_LIFETIME_MS);
    // The token itself never appears in the status payload.
    expect(JSON.stringify(res.body)).not.toContain("stored-refresh-token");
  });

  it("/api/now-playing refreshes with the STORED token — service_tokens is the ONLY grant source (task #112)", async () => {
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
