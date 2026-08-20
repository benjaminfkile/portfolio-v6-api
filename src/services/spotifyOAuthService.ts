import { createHash, randomBytes } from "crypto";
import { getDb } from "../db/db";
import { IAppSecrets } from "../interfaces";

/**
 * Spotify OAuth for the admin reconnect flow (§4.6 / task #113).
 *
 * Since Spotify's June 2026 policy change expires refresh tokens 180 days after
 * authorization, re-authorization is a twice-a-year routine. This service holds
 * the pieces the adminIntegrationsRouter composes: single-use `state` tokens
 * (DB-backed, task #113), the authorize-URL builder, and the code→token
 * exchange. The admin reconnect flow is the ONLY bootstrap for the polling
 * fallback lane's grant — everything else in the app reads the token this
 * flow writes.
 *
 * State tokens are opaque 256-bit values persisted (sha256-hashed) to the
 * shared `spotify_oauth_states` table. Only a verified admin can mint one,
 * and the callback validates + marks it consumed in a single atomic UPDATE so
 * a second callback with the same state fails, even across instances. The
 * table row expires 10 minutes after mint — expired/unknown/consumed tokens
 * are indistinguishable to the caller (§7 pattern), which is what the failure
 * UX depends on.
 *
 * Why DB and not in-memory: the API runs as multiple instances behind a load
 * balancer. A state minted on instance A must be validatable on B when the
 * Spotify callback round-robins to a different node — otherwise every
 * reconnect surfaces the "invalid or expired" failure UX and no grant is
 * ever stored. Same shared-record-is-authoritative philosophy as the preview
 * tokens migration (task #105) and the Spotify suspension record (task #97).
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

const OAUTH_STATES_TABLE = "spotify_oauth_states";

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

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
 * admin's `return_to` URL, persisting the sha256 hash to the shared table so
 * ANY instance can validate the eventual callback. Only http(s) return URLs
 * are kept — anything else (or none) falls back to the callback's own
 * confirmation page. Expired rows are dropped opportunistically here so the
 * table self-cleans as states are minted.
 */
export async function mintOAuthState(
  returnTo: string | null | undefined,
  now: number = Date.now()
): Promise<string> {
  const state = randomBytes(32).toString("hex");
  const expiry = now + SPOTIFY_OAUTH_STATE_TTL_MS;
  const db = getDb();
  await db(OAUTH_STATES_TABLE).where("expires_at", "<=", new Date(now)).del();
  await db(OAUTH_STATES_TABLE).insert({
    state_hash: hashState(state),
    return_to: isHttpUrl(returnTo) ? (returnTo as string) : null,
    expires_at: new Date(expiry),
  });
  return state;
}

/**
 * Consume a state token: valid at most once, and only before expiry. The
 * validate + mark-consumed happens as a single conditional UPDATE, so a second
 * callback with the same state (even from a different instance) sees a zero
 * row count and fails. Unknown, reused, and expired states are
 * indistinguishable to the caller (§7 pattern).
 */
export async function consumeOAuthState(
  state: string | undefined | null,
  now: number = Date.now()
): Promise<{ valid: boolean; returnTo: string | null }> {
  if (!state) {
    return { valid: false, returnTo: null };
  }
  const db = getDb();
  const stateHash = hashState(state);
  // Atomic single-use: return the row iff we successfully flipped it from
  // "unconsumed and unexpired" to "consumed now". A concurrent second consume
  // sees consumed_at != null and the UPDATE finds zero rows.
  const nowDate = new Date(now);
  const rows = (await db(OAUTH_STATES_TABLE)
    .where({ state_hash: stateHash })
    .whereNull("consumed_at")
    .andWhere("expires_at", ">", nowDate)
    .update({ consumed_at: nowDate }, ["return_to"])) as Array<{
    return_to: string | null;
  }>;
  if (rows.length === 0) {
    return { valid: false, returnTo: null };
  }
  return { valid: true, returnTo: rows[0].return_to ?? null };
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

/** Test-only: drop every pending authorization row. */
export async function clearOAuthStates(): Promise<void> {
  await getDb()(OAUTH_STATES_TABLE).del();
}
