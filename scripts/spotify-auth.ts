/**
 * scripts/spotify-auth.ts — one-time local Spotify bootstrap (TECH_SPEC_V1.md §4.6).
 *
 * Walks the OAuth 2.0 authorization-code flow to obtain a **refresh token** for the
 * `user-read-currently-playing` scope, which client-credentials auth cannot grant.
 * Run it locally, on the owner's machine; store the printed refresh token (with the
 * client id and secret) in Secrets Manager (§9.3).
 *
 * NOTE: since Spotify's June 2026 policy change, refresh tokens EXPIRE 180 days
 * after the authorization (refreshing does not extend it). Prefer the admin
 * "reconnect Spotify" flow (adminSpotifyRouter), which stores the new token
 * without touching Secrets Manager; this script remains as the manual fallback
 * and must be re-run before each expiry if the static secret is what's in use.
 *
 * Prerequisites:
 *   - A Spotify app in the developer dashboard whose Redirect URI is EXACTLY
 *     `http://127.0.0.1:8888/callback` (§4.6).
 *   - `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` set in the environment.
 *
 * Usage:
 *   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npx ts-node scripts/spotify-auth.ts
 *
 * It prints an authorize URL, opens a local server on 127.0.0.1:8888, waits for the
 * redirect, exchanges the `code` for tokens, prints the refresh token, and exits.
 *
 * NOTE: this file is intentionally NOT wired into the app or the test suite — it is
 * an operator tool. It is typechecked by `npm run build` (§ tsconfig `include`) but
 * the interactive OAuth flow cannot run in CI / the offline container.
 */

import http from "http";
import crypto from "crypto";
import { URL } from "url";

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 8888;
const REDIRECT_PATH = "/callback";
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPE = "user-read-currently-playing";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name}. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the ` +
        `environment before running this script (§4.6).`
    );
    process.exit(1);
  }
  return value;
}

function buildAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string
): Promise<TokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  return (await res.json()) as TokenResponse;
}

function main(): void {
  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const expectedState = crypto.randomBytes(16).toString("hex");

  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      const requestUrl = new URL(
        req.url ?? "/",
        `http://${REDIRECT_HOST}:${REDIRECT_PORT}`
      );

      if (requestUrl.pathname !== REDIRECT_PATH) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");

      const finish = (statusCode: number, message: string): void => {
        res.writeHead(statusCode, { "content-type": "text/plain" });
        res.end(message);
        // Give the response a beat to flush before tearing the server down.
        setTimeout(() => server.close(() => process.exit(statusCode === 200 ? 0 : 1)), 100);
      };

      if (error) {
        console.error(`Authorization was denied or failed: ${error}`);
        finish(400, `Authorization failed: ${error}. You can close this tab.`);
        return;
      }
      if (state !== expectedState) {
        console.error("State mismatch — possible CSRF; aborting.");
        finish(400, "State mismatch. You can close this tab.");
        return;
      }
      if (!code) {
        console.error("No authorization code in the redirect.");
        finish(400, "No authorization code received. You can close this tab.");
        return;
      }

      exchangeCodeForTokens(clientId, clientSecret, code)
        .then((tokens) => {
          if (!tokens.refresh_token) {
            console.error(
              "Token exchange returned no refresh_token:",
              tokens.error_description ?? tokens.error ?? "unknown error"
            );
            finish(500, "Token exchange failed. Check the terminal.");
            return;
          }
          console.log("\n=== Spotify refresh token (store in Secrets Manager, §9.3) ===\n");
          console.log(tokens.refresh_token);
          console.log("\nGranted scope:", tokens.scope ?? SCOPE);
          console.log(
            "\nDone. Keep it secret. NOTE: Spotify expires refresh tokens 180 " +
              "days after authorization — re-run this (or use the admin " +
              "reconnect flow) before then.\n"
          );
          finish(200, "Success. Refresh token printed to the terminal. You can close this tab.");
        })
        .catch((err: unknown) => {
          console.error(
            "Token exchange request failed:",
            err instanceof Error ? err.message : err
          );
          finish(500, "Token exchange request failed. Check the terminal.");
        });
    }
  );

  server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
    const authorizeUrl = buildAuthorizeUrl(clientId, expectedState);
    console.log(
      "Open this URL in a browser, log in, and approve the request:\n"
    );
    console.log(authorizeUrl);
    console.log(
      `\nWaiting for the redirect to ${REDIRECT_URI} …\n` +
        "(Ctrl+C to abort.)"
    );
  });
}

main();
