import { randomBytes } from "crypto";
import { IAppSecrets } from "../interfaces";

/**
 * Spotify OAuth for the admin reconnect flow (§4.6).
 *
 * Since Spotify's June 2026 policy change expires refresh tokens 180 days after
 * authorization, re-authorization is a twice-a-year routine. This service holds
 * the pieces the adminSpotifyRouter composes: single-use `state` tokens, the
 * authorize-URL builder, and the code→token exchange. The flow mirrors the
 * one-time `scripts/spotify-auth.ts` bootstrap, but redirects back to the
 * deployed API instead of a local throwaway server, so the admin never handles
 * the token by hand.
 *
 * State tokens follow the previewTokenService pattern: opaque 256-bit values in
 * an in-memory map. Only a verified admin can mint one, the callback consumes it
 * (single-use), and it expires after 10 minutes — so an unauthenticated hit on
 * the public callback URL can never cause a token to be stored.
 */

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
/** Same token endpoint the now-playing refresh uses (spotifyService). */
export const SPOTIFY_OAUTH_TOKEN_URL = "https://accounts.spotify.com/api/token";
/**
 * Scopes now-playing needs (§4.6): currently-playing for the live track,
 * recently-played for the last-played fallback shown when idle. Existing
 * stored tokens keep their original grant — the fallback silently stays off
 * until the admin reconnects and re-authorizes with both scopes.
 */
export const SPOTIFY_OAUTH_SCOPE =
  "user-read-currently-playing user-read-recently-played";
/** Authorize flows are human-paced; 10 minutes is generous but still bounded. */
export const SPOTIFY_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingAuthorization {
  /** Admin URL to send the browser back to after the callback, if provided. */
  returnTo: string | null;
  expiresAt: number;
}

// state -> pending authorization. In-memory on purpose (single container,
// single admin class); a lost state just means clicking Connect again.
const pending = new Map<string, PendingAuthorization>();

/**
 * The exact redirect URI Spotify sends the browser back to. Must match a
 * Redirect URI registered in the Spotify app EXACTLY. Deployed installs set
 * `spotify_redirect_uri` in the app secrets (the public API origin is an infra
 * value that never lives in this repo); locally it defaults to the loopback
 * address Spotify permits plain http for.
 */
export function resolveRedirectUri(secrets: IAppSecrets): string {
  if (secrets.spotify_redirect_uri) {
    return secrets.spotify_redirect_uri;
  }
  return `http://127.0.0.1:${secrets.port}/api/admin/spotify/callback`;
}

/**
 * Mint a single-use state token binding this authorization attempt to the
 * admin's `return_to` URL. Only http(s) return URLs are kept — anything else
 * (or none) falls back to the callback's own confirmation page.
 */
export function mintOAuthState(
  returnTo: string | null | undefined,
  now: number = Date.now()
): string {
  const state = randomBytes(32).toString("hex");
  pending.set(state, {
    returnTo: isHttpUrl(returnTo) ? (returnTo as string) : null,
    expiresAt: now + SPOTIFY_OAUTH_STATE_TTL_MS,
  });
  return state;
}

/**
 * Consume a state token: valid at most once, and only before expiry. Unknown,
 * reused, and expired states are indistinguishable to the caller (§7 pattern).
 */
export function consumeOAuthState(
  state: string | undefined | null,
  now: number = Date.now()
): { valid: boolean; returnTo: string | null } {
  if (!state) {
    return { valid: false, returnTo: null };
  }
  const entry = pending.get(state);
  if (!entry) {
    return { valid: false, returnTo: null };
  }
  pending.delete(state); // single-use, even when expired
  if (entry.expiresAt <= now) {
    return { valid: false, returnTo: null };
  }
  return { valid: true, returnTo: entry.returnTo };
}

/** The Spotify authorize URL the admin's browser is sent to. */
export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SPOTIFY_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange the authorization code for a refresh token (server-side; the client
 * secret and the resulting token never reach the browser). Throws on failure
 * with a message that NEVER contains a credential — the router maps it to the
 * error redirect and the log keeps only status/shape information.
 */
export async function exchangeCodeForRefreshToken(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new Error("Spotify client credentials are not configured");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(SPOTIFY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    // As in spotifyService: log status only, never the response body, so no
    // credential can ever leak into logs.
    throw new Error(`Spotify code exchange failed with status ${res.status}`);
  }

  const tokens = (await res.json()) as { refresh_token?: string };
  if (!tokens.refresh_token) {
    throw new Error("Spotify code exchange returned no refresh_token");
  }
  return tokens.refresh_token;
}

function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Test-only: drop every pending authorization. */
export function _clearSpotifyOAuthStateForTests(): void {
  pending.clear();
}
