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
  consumeOAuthState,
  mintOAuthState,
  SPOTIFY_OAUTH_TOKEN_URL,
  SPOTIFY_OAUTH_STATE_TTL_MS,
  clearOAuthStates,
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
  // Task #112 removed the static spotify_refresh_token fallback entirely.
  // The admin reconnect flow is the only bootstrap.
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
  _resetServiceTokenStoreForTests();
  _resetSpotifyStateForTests();
  app.set("secrets", SECRETS);
  app.set("upstream", null);
  await getDb()("service_tokens").del();
  await getDb()("service_settings").del();
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
      state: "disconnected",
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

  it("task #112 — a static spotify_refresh_token secret is IGNORED (no fallback)", async () => {
    // Even if an old-style static secret is still present in the environment,
    // the integrations status must show DISCONNECTED — service_tokens is the
    // sole grant source and no row exists. The status endpoint MUST NOT
    // surface `source: "secrets"` any more.
    app.set("secrets", {
      ...SECRETS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spotify_refresh_token: "static-token-that-must-be-ignored",
    } as any);
    try {
      const res = await request(app).get("/api/admin/integrations").set(...AUTH);
      const spotify = res.body.data.integrations.find(
        (e: any) => e.key === "spotify"
      );
      expect(spotify).toMatchObject({
        state: "disconnected",
        authorized_at: null,
        expires_at: null,
      });
      expect(JSON.stringify(res.body)).not.toContain("static-token-that-must-be-ignored");
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
    const state = await mintOAuthState("http://localhost:5174/integrations");
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
    const state = await mintOAuthState("http://localhost:5174/integrations");
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

  it("/spotify/status returns the truthful contract (connected + 180-day expiry) after the oauth flow", async () => {
    // Seed via the parameterized callback, then read via the truthful status
    // endpoint (task #113).
    mockTokenExchange("stored-refresh-token");
    const state = await mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("connected");
    const authorizedAt = new Date(res.body.data.authorized_at).getTime();
    const expiresAt = new Date(res.body.data.expires_at).getTime();
    expect(expiresAt - authorizedAt).toBe(SPOTIFY_REFRESH_TOKEN_LIFETIME_MS);
    expect(JSON.stringify(res.body)).not.toContain("stored-refresh-token");
  });

  it("GET /integrations shows spotify connected with an expiry after the oauth flow", async () => {
    mockTokenExchange("stored-refresh-token");
    const state = await mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    const res = await request(app).get("/api/admin/integrations").set(...AUTH);
    const spotify = res.body.data.integrations.find(
      (e: any) => e.key === "spotify"
    );
    expect(spotify.state).toBe("connected");
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
    const state = await mintOAuthState("http://localhost:5174/integrations");
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

// ============================================================================
// Task #113 — Spotify overhaul 2/2
// ============================================================================

describe("task #113 — cross-instance OAuth state (spotify_oauth_states)", () => {
  it("mint on one instance, consume on another (against the same DB) — single-use across instances", async () => {
    // Simulate two service instances by minting on "A" and consuming on "B":
    // both call the exported helpers directly, sharing the SAME DB. A concurrent
    // second consume from either instance must fail — that is the property the
    // in-memory implementation could not provide behind the multi-instance ALB.
    const state = await mintOAuthState("http://localhost:5174/integrations");

    // The row is persisted, hashed at rest (never the raw state).
    const row = await getDb()("spotify_oauth_states").first();
    expect(row.state_hash).not.toBe(state);
    expect(row.state_hash).toHaveLength(64); // sha256 hex

    // Instance B consumes it (same DB reads succeed regardless of which
    // process originally minted the state).
    const first = await consumeOAuthState(state);
    expect(first).toEqual({
      valid: true,
      returnTo: "http://localhost:5174/integrations",
    });

    // A second consume — whether from A or B — fails (row marked consumed).
    const second = await consumeOAuthState(state);
    expect(second).toEqual({ valid: false, returnTo: null });
  });

  it("expired states cannot be consumed", async () => {
    const now = Date.now();
    const state = await mintOAuthState(null, now);
    const past = now + SPOTIFY_OAUTH_STATE_TTL_MS + 1;
    const res = await consumeOAuthState(state, past);
    expect(res).toEqual({ valid: false, returnTo: null });
  });

  it("unknown states are indistinguishable from expired/consumed ones", async () => {
    const res = await consumeOAuthState("never-minted-state");
    expect(res).toEqual({ valid: false, returnTo: null });
  });

  it("keeps only http(s) return URLs", async () => {
    const bad = await mintOAuthState("javascript:alert(1)");
    expect(await consumeOAuthState(bad)).toEqual({
      valid: true,
      returnTo: null,
    });
    const good = await mintOAuthState("http://localhost:5174/integrations");
    expect((await consumeOAuthState(good)).returnTo).toBe(
      "http://localhost:5174/integrations"
    );
  });

  it("callback works when the state was minted by a different instance's request", async () => {
    // Instance A mints via /connect; the row lives in the shared DB. Instance
    // B receives the callback from Spotify's redirect and validates against
    // the SAME row (same test process, but semantically identical to A/B).
    const connectRes = await request(app)
      .post("/api/admin/integrations/spotify/connect")
      .set(...AUTH)
      .send({ return_to: "http://localhost:5174/integrations" });
    const state = new URL(connectRes.body.data.authorize_url).searchParams.get(
      "state"
    )!;

    // Mock the token exchange for the callback.
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockImplementation((url: string) => {
        if (url === SPOTIFY_OAUTH_TOKEN_URL) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ refresh_token: "cross-instance-token" }),
          });
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });

    const cbRes = await request(app).get(
      `/api/admin/spotify/callback?state=${state}&code=some-code`
    );
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.location).toBe(
      "http://localhost:5174/integrations?spotify=connected"
    );

    // Row is now marked consumed — a replayed callback fails.
    const replay = await request(app).get(
      `/api/admin/spotify/callback?state=${state}&code=some-code`
    );
    expect(replay.status).toBe(400);
    expect(replay.headers.location).toBeUndefined();
  });
});

describe("task #113 — GET /api/admin/spotify/status contract + precedence", () => {
  it("requires an admin bearer (machine keys / no key = 401)", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const noAuth = await request(app).get("/api/admin/spotify/status");
    expect(noAuth.status).toBe(401);
    const badBearer = await request(app)
      .get("/api/admin/spotify/status")
      .set("Authorization", "Bearer nope");
    expect(badBearer.status).toBe(401);
    // A machine (pv6k_) bearer is not a valid admin ID token → 401 (checkAdmin
    // fails signature, requireAdmin never consults api_keys).
    const machine = await request(app)
      .get("/api/admin/spotify/status")
      .set("Authorization", "Bearer pv6k_fake_key");
    expect(machine.status).toBe(401);
  });

  it("returns the exact documented contract shape", async () => {
    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.status).toBe(200);
    // Every field is present, even when null.
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        "state",
        "last_success_at",
        "last_error",
        "rate_limited_until",
        "authorized_at",
        "expires_at",
      ].sort()
    );
  });

  it("state = `disconnected` when no grant is stored (no static fallback)", async () => {
    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.body.data.state).toBe("disconnected");
    expect(res.body.data.authorized_at).toBeNull();
    expect(res.body.data.expires_at).toBeNull();
  });

  it("state = `connected` only when a grant is stored AND no active suspension", async () => {
    // Seed a grant via the callback path.
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockImplementation((url: string) => {
        if (url === SPOTIFY_OAUTH_TOKEN_URL) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ refresh_token: "connected-token" }),
          });
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });
    const state = await mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.body.data.state).toBe("connected");
    expect(res.body.data.authorized_at).not.toBeNull();
    expect(res.body.data.expires_at).not.toBeNull();
    // expires_at = authorized_at + 180 days.
    expect(
      new Date(res.body.data.expires_at).getTime() -
        new Date(res.body.data.authorized_at).getTime()
    ).toBe(SPOTIFY_REFRESH_TOKEN_LIFETIME_MS);
  });

  it("state = `auth_broken` when the last refresh returned invalid_grant, even with a stored grant", async () => {
    // Seed a real (decryptable) grant so the status service sees a stored
    // token; then simulate the invalid_grant observation the poller records
    // on a dead refresh token (task #112 health mirror).
    const { saveServiceToken } = await import(
      "../src/services/serviceTokenStore"
    );
    await saveServiceToken("spotify", CLIENT_SECRET, "some-refresh-token");
    _resetServiceTokenStoreForTests();

    const {
      noteSpotifyApiError,
    } = await import("../src/services/spotifyService");
    noteSpotifyApiError("invalid_grant");

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    // Even though the grant row is present, invalid_grant precedence takes over.
    expect(res.body.data.state).toBe("auth_broken");
    expect(res.body.data.last_error?.kind).toBe("invalid_grant");
  });

  it("state = `rate_limited` when the shared 429 window is active", async () => {
    // Seed a decryptable grant so the precedence check reaches the
    // rate-limit level rather than short-circuiting at `disconnected`.
    const { saveServiceToken } = await import(
      "../src/services/serviceTokenStore"
    );
    await saveServiceToken("spotify", CLIENT_SECRET, "grant-for-rate-limit");
    _resetServiceTokenStoreForTests();

    // Simulate the leader's local 429 backoff mirror — the status service
    // falls back to it when Redis is unwired (which it is in these tests).
    const spotifyService = await import("../src/services/spotifyService");
    spotifyService.applySpotifyBackoffUntil(Date.now() + 60_000);
    spotifyService.noteSpotifyApiError(
      "rate_limited",
      Date.now(),
      Date.now() + 60_000
    );

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.body.data.state).toBe("rate_limited");
    expect(res.body.data.rate_limited_until).not.toBeNull();
  });

  it("state = `disabled` beats every other signal (precedence top)", async () => {
    // A stored grant PLUS an active 429 PLUS invalid_grant PLUS everything —
    // an explicit disable still wins.
    const { saveServiceToken } = await import(
      "../src/services/serviceTokenStore"
    );
    await saveServiceToken("spotify", CLIENT_SECRET, "grant-for-disable");
    _resetServiceTokenStoreForTests();
    const spotifyService = await import("../src/services/spotifyService");
    spotifyService.applySpotifyBackoffUntil(Date.now() + 60_000);
    spotifyService.noteSpotifyApiError("invalid_grant");

    await request(app).post("/api/admin/spotify/disable").set(...AUTH);

    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.body.data.state).toBe("disabled");
  });

  it("NEVER reports connected merely because credentials exist without a working grant", async () => {
    // No stored grant but the app has spotify_client_id/spotify_client_secret
    // set from SECRETS — the status endpoint must still say `disconnected`,
    // NOT `connected` (task #112 killed the static-secret bootstrap).
    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.body.data.state).not.toBe("connected");
    expect(res.body.data.state).toBe("disconnected");
  });
});

describe("task #113 — POST /api/admin/spotify/disable stops the poller", () => {
  it("the now-playing fetcher makes zero Spotify calls when disabled, even with a stored grant", async () => {
    // Seed a decryptable grant so the fetcher would otherwise refresh + fetch.
    const { saveServiceToken } = await import(
      "../src/services/serviceTokenStore"
    );
    await saveServiceToken("spotify", CLIENT_SECRET, "grant-for-disable-fetcher");
    _resetServiceTokenStoreForTests();

    // Flip disabled ON.
    const dis = await request(app).post("/api/admin/spotify/disable").set(...AUTH);
    expect(dis.status).toBe(200);
    expect(dis.body.data.state).toBe("disabled");

    // Persistence across "instances/restarts" — the flag is a DB row, so any
    // other instance / a new process instantly reads it as disabled.
    const { isSpotifyDisabled } = await import(
      "../src/services/serviceSettingsStore"
    );
    expect(await isSpotifyDisabled()).toBe(true);

    // Any Spotify HTTP would go through the mocked global fetch — proving
    // ZERO calls means the fetcher short-circuited before both the token
    // endpoint and the currently-playing endpoint.
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchSpy;

    const { buildFetchers } = await import("../src/services/upstream");
    const fetchers = buildFetchers(app);
    const result = await fetchers.nowPlaying();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Re-enable brings it back — the fetcher will try again on the next call.
    const en = await request(app).post("/api/admin/spotify/enable").set(...AUTH);
    expect(en.status).toBe(200);
    // The state is `connected` because a grant row exists (albeit undecryptable
    // in this seed) — but the KEY assertion is that `disabled` is gone.
    expect(en.body.data.state).not.toBe("disabled");
    expect(await isSpotifyDisabled()).toBe(false);
  });

  it("disable/enable are admin-only", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    for (const call of [
      request(app).post("/api/admin/spotify/disable").send({}),
      request(app).post("/api/admin/spotify/enable").send({}),
      // A machine (pv6k_) bearer must be denied on humans-only routes.
      request(app)
        .post("/api/admin/spotify/disable")
        .set("Authorization", "Bearer pv6k_fake"),
    ]) {
      const res = await call;
      expect(res.status).toBe(401);
    }
  });
});

describe("task #113 — POST /api/admin/spotify/disconnect", () => {
  it("deletes the stored grant → status reports disconnected", async () => {
    // Seed a grant, then disconnect via the new endpoint.
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockImplementation((url: string) => {
        if (url === SPOTIFY_OAUTH_TOKEN_URL) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ refresh_token: "grant-to-disconnect" }),
          });
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });
    const state = await mintOAuthState("http://localhost:5174/integrations");
    await request(app).get(
      `/api/admin/integrations/spotify/callback?state=${state}&code=c`
    );

    // Confirm the grant is stored before disconnect.
    _resetServiceTokenStoreForTests();
    expect(
      await getStoredServiceToken("spotify", CLIENT_SECRET)
    ).not.toBeNull();

    const res = await request(app)
      .post("/api/admin/spotify/disconnect")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("disconnected");
    expect(res.body.data.authorized_at).toBeNull();
    expect(res.body.data.expires_at).toBeNull();

    // Row is gone from the shared table — any other instance sees the same.
    _resetServiceTokenStoreForTests();
    expect(await getStoredServiceToken("spotify", CLIENT_SECRET)).toBeNull();

    // Idempotent — second disconnect still reports disconnected, no error.
    const again = await request(app)
      .post("/api/admin/spotify/disconnect")
      .set(...AUTH);
    expect(again.status).toBe(200);
    expect(again.body.data.state).toBe("disconnected");
  });

  it("is admin-only (machine keys 401)", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    const noAuth = await request(app).post("/api/admin/spotify/disconnect");
    expect(noAuth.status).toBe(401);
    const machine = await request(app)
      .post("/api/admin/spotify/disconnect")
      .set("Authorization", "Bearer pv6k_fake");
    expect(machine.status).toBe(401);
  });
});
