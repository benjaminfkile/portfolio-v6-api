import request from "supertest";

/**
 * Admin Spotify unit tests — the crypto helpers, the authorize-URL builder,
 * the redirect-URI resolver, and the code-exchange fetch. Everything here
 * runs WITHOUT a database or network: upstream HTTP is a mocked global
 * fetch, Cognito is a mocked verifier. The stateful (DB-backed) surface —
 * the OAuth state token single-use across instances, the status/enable/
 * disable/disconnect endpoints, the reconnect callback — is covered by
 * adminIntegrations.test.ts against the throwaway Postgres cluster.
 */

// Mock the Cognito verifier so requireAdmin() authorizes offline (§5.3).
jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import app from "../src/app";
import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import {
  buildAuthorizeUrl,
  exchangeCodeForRefreshToken,
  resolveRedirectUri,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_OAUTH_TOKEN_URL,
} from "../src/services/spotifyOAuthService";
import {
  decryptToken,
  encryptToken,
  _resetSpotifyTokenStoreForTests,
} from "../src/services/spotifyTokenStore";
import { IAppSecrets } from "../src/interfaces";

const mockVerify = verifyAdminIdToken as jest.Mock;
const ADMIN_PAYLOAD = { sub: "admin-sub-123", "cognito:groups": ["admins"] };

const SECRETS: Partial<IAppSecrets> = {
  node_env: "development",
  port: "3002",
  spotify_client_id: "client-id-abc",
  spotify_client_secret: "client-secret-xyz",
  // Task #112 removed the static spotify_refresh_token fallback entirely —
  // client id/secret remain because they are app config, not a grant.
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

describe("OAuth helpers (spotifyOAuthService)", () => {
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

describe("admin auth guard on Spotify routes (§5.3)", () => {
  it("requires an admin bearer on status/connect/enable/disable/disconnect", async () => {
    mockVerify.mockRejectedValue(new Error("bad token"));
    for (const call of [
      request(app).get("/api/admin/spotify/status"),
      request(app).post("/api/admin/spotify/connect").send({}),
      request(app).post("/api/admin/spotify/enable").send({}),
      request(app).post("/api/admin/spotify/disable").send({}),
      request(app).post("/api/admin/spotify/disconnect").send({}),
    ]) {
      const res = await call;
      expect(res.status).toBe(401);
    }
  });
});
