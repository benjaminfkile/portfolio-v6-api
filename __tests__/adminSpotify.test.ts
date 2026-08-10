import request from "supertest";

/**
 * Admin Spotify reconnect flow tests (§4.6) — the OAuth service, the token
 * crypto, and the router surface. Everything here runs WITHOUT a database or
 * network: upstream HTTP is a mocked global fetch, Cognito is a mocked
 * verifier, and the token-store paths exercised are the ones that must degrade
 * gracefully when no DB is initialized (the §4.6 contract). The DB-backed
 * store/persistence paths are covered in spotifyTokenStore.test.ts against the
 * throwaway Postgres cluster.
 */

// Mock the Cognito verifier so requireAdmin() authorizes offline (§5.3).
jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import app from "../src/app";
import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import {
  buildAuthorizeUrl,
  consumeOAuthState,
  exchangeCodeForRefreshToken,
  mintOAuthState,
  resolveRedirectUri,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_OAUTH_STATE_TTL_MS,
  SPOTIFY_OAUTH_TOKEN_URL,
  _clearSpotifyOAuthStateForTests,
} from "../src/services/spotifyOAuthService";
import {
  decryptToken,
  encryptToken,
  _resetSpotifyTokenStoreForTests,
} from "../src/services/spotifyTokenStore";
import { IAppSecrets } from "../src/interfaces";

const mockVerify = verifyAdminIdToken as jest.Mock;
const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

const SECRETS: Partial<IAppSecrets> = {
  node_env: "development",
  port: "3002",
  spotify_client_id: "client-id-abc",
  spotify_client_secret: "client-secret-xyz",
  spotify_refresh_token: "secrets-refresh-token",
};

const mockFetch = jest.fn();

beforeAll(() => {
  app.set("secrets", SECRETS);
});

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
  _clearSpotifyOAuthStateForTests();
  _resetSpotifyTokenStoreForTests();
});

describe("token crypto (spotifyTokenStore)", () => {
  it("round-trips a token through AES-256-GCM", () => {
    const ct = encryptToken("secret-key", "the-refresh-token");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain("the-refresh-token");
    expect(decryptToken("secret-key", ct)).toBe("the-refresh-token");
  });

  it("produces distinct ciphertexts per call (fresh IV)", () => {
    const a = encryptToken("secret-key", "same-token");
    const b = encryptToken("secret-key", "same-token");
    expect(a).not.toBe(b);
    expect(decryptToken("secret-key", a)).toBe("same-token");
    expect(decryptToken("secret-key", b)).toBe("same-token");
  });

  it("returns null with the wrong key (rotated client secret)", () => {
    const ct = encryptToken("old-secret", "the-refresh-token");
    expect(decryptToken("new-secret", ct)).toBeNull();
  });

  it("returns null on tampered or malformed ciphertext", () => {
    const ct = encryptToken("secret-key", "the-refresh-token");
    const [v, iv, tag, body] = ct.split(":");
    const flipped = body.startsWith("A") ? `B${body.slice(1)}` : `A${body.slice(1)}`;
    expect(decryptToken("secret-key", [v, iv, tag, flipped].join(":"))).toBeNull();
    expect(decryptToken("secret-key", "v0:not:a:token")).toBeNull();
    expect(decryptToken("secret-key", "garbage")).toBeNull();
  });
});

describe("OAuth state (spotifyOAuthService)", () => {
  it("mints single-use states — the second consume fails", () => {
    const state = mintOAuthState("https://admin.example/integrations");
    expect(consumeOAuthState(state)).toEqual({
      valid: true,
      returnTo: "https://admin.example/integrations",
    });
    expect(consumeOAuthState(state)).toEqual({ valid: false, returnTo: null });
  });

  it("rejects unknown and expired states", () => {
    expect(consumeOAuthState("never-minted")).toEqual({
      valid: false,
      returnTo: null,
    });
    const now = 1_000_000;
    const state = mintOAuthState(null, now);
    expect(
      consumeOAuthState(state, now + SPOTIFY_OAUTH_STATE_TTL_MS + 1)
    ).toEqual({ valid: false, returnTo: null });
  });

  it("keeps only http(s) return URLs", () => {
    const bad = mintOAuthState("javascript:alert(1)");
    expect(consumeOAuthState(bad)).toEqual({ valid: true, returnTo: null });
    const good = mintOAuthState("http://localhost:5174/integrations");
    expect(consumeOAuthState(good).returnTo).toBe(
      "http://localhost:5174/integrations"
    );
  });

  it("builds the authorize URL with the §4.6 scope and no secret", () => {
    const url = new URL(buildAuthorizeUrl("cid", "http://cb/here", "st4te"));
    expect(url.origin + url.pathname).toBe(SPOTIFY_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://cb/here");
    expect(url.searchParams.get("scope")).toBe(
      "user-read-currently-playing user-read-recently-played"
    );
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.toString()).not.toContain("client-secret");
  });

  it("resolves the redirect URI from secrets, else the loopback default", () => {
    expect(
      resolveRedirectUri({
        ...(SECRETS as IAppSecrets),
        spotify_redirect_uri: "https://api.example/api/admin/spotify/callback",
      })
    ).toBe("https://api.example/api/admin/spotify/callback");
    expect(resolveRedirectUri(SECRETS as IAppSecrets)).toBe(
      "http://127.0.0.1:3002/api/admin/spotify/callback"
    );
  });

  it("exchanges a code and never leaks credentials in errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ refresh_token: "new-refresh-token" }),
    });
    await expect(
      exchangeCodeForRefreshToken("cid", "csecret", "http://cb", "auth-code")
    ).resolves.toBe("new-refresh-token");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(SPOTIFY_OAUTH_TOKEN_URL);
    expect(String((init as RequestInit).body)).toContain(
      "grant_type=authorization_code"
    );

    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    await expect(
      exchangeCodeForRefreshToken("cid", "csecret", "http://cb", "bad-code")
    ).rejects.toThrow(/status 400/);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    await expect(
      exchangeCodeForRefreshToken("cid", "csecret", "http://cb", "bad-code")
    ).rejects.not.toThrow(/csecret/);
  });
});

describe("admin routes (§5.3 guard + status/connect)", () => {
  it("requires an admin bearer on status and connect", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    expect(
      (await request(app).get("/api/admin/spotify/status")).status
    ).toBe(401);
    expect(
      (await request(app).post("/api/admin/spotify/connect").send({})).status
    ).toBe(401);
  });

  it("status falls back to the secrets token when no DB row exists", async () => {
    // No DB is initialized in this suite, so the store degrades to null and the
    // static secret is what reports connected.
    const res = await request(app)
      .get("/api/admin/spotify/status")
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      connected: true,
      source: "secrets",
      authorized_at: null,
      expires_at: null,
    });
  });

  it("connect returns the authorize URL and captures return_to server-side", async () => {
    const res = await request(app)
      .post("/api/admin/spotify/connect")
      .set(...AUTH)
      .send({ return_to: "http://localhost:5174/integrations" });

    expect(res.status).toBe(200);
    const url = new URL(res.body.data.authorize_url);
    expect(url.origin + url.pathname).toBe(SPOTIFY_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("client-id-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3002/api/admin/spotify/callback"
    );
    // return_to rides in the server-side state map, never in the URL.
    expect(res.body.data.authorize_url).not.toContain("localhost:5174");

    const state = url.searchParams.get("state")!;
    expect(consumeOAuthState(state).returnTo).toBe(
      "http://localhost:5174/integrations"
    );
  });

  it("connect refuses (409) when client credentials are unconfigured", async () => {
    app.set("secrets", { ...SECRETS, spotify_client_id: "" });
    try {
      const res = await request(app)
        .post("/api/admin/spotify/connect")
        .set(...AUTH)
        .send({});
      expect(res.status).toBe(409);
    } finally {
      app.set("secrets", SECRETS);
    }
  });
});

describe("GET /api/admin/spotify/callback", () => {
  it("rejects an unknown/expired/reused state without redirecting", async () => {
    const res = await request(app).get(
      "/api/admin/spotify/callback?state=forged&code=x"
    );
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("redirects back with ?spotify=error when the user denied", async () => {
    const state = mintOAuthState("http://localhost:5174/integrations");
    const res = await request(app).get(
      `/api/admin/spotify/callback?state=${state}&error=access_denied`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://localhost:5174/integrations?spotify=error"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("redirects with ?spotify=error when the code exchange fails, leaking nothing", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    const state = mintOAuthState("http://localhost:5174/integrations");
    const res = await request(app).get(
      `/api/admin/spotify/callback?state=${state}&code=bad-code`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://localhost:5174/integrations?spotify=error"
    );
  });

  // The success path needs the DB (the token must be persisted) — covered in
  // spotifyTokenStore.test.ts against the throwaway cluster.
});
