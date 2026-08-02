import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { getDb } from "../db/db";

/**
 * Encrypted persistence for the Spotify refresh token (§4.6, admin reconnect).
 *
 * Since Spotify's June 2026 policy change, refresh tokens expire 180 days after
 * the user's original authorization. The admin reconnect flow (adminSpotifyRouter)
 * mints a new one in the browser and stores it here; `/api/now-playing` prefers
 * this stored token and falls back to the `spotify_refresh_token` secret for
 * installs that still use the one-time `scripts/spotify-auth.ts` bootstrap.
 *
 * Storage is the `service_tokens` row `service = 'spotify'`, with the token held
 * ONLY as AES-256-GCM ciphertext so a database dump alone never reveals it.
 *
 * DOCUMENTED CHOICE — encryption key derivation: the key is derived (scrypt)
 * from `spotify_client_secret` rather than a new dedicated secret. The client
 * secret already lives in Secrets Manager/env alongside everything else the
 * token protects, so a dedicated key would add a Secrets Manager schema change
 * without adding a meaningfully different trust boundary: anyone holding the
 * app secrets can mint Spotify access tokens either way. If the client secret
 * is ever rotated, decryption fails, the service degrades to the §4.6 idle
 * payload, and the fix is a 10-second admin reconnect.
 */

/** The `service_tokens.service` key this store owns. */
export const SPOTIFY_SERVICE_KEY = "spotify";

/** Spotify's refresh-token lifetime since the June 2026 policy change. */
export const SPOTIFY_REFRESH_TOKEN_LIFETIME_DAYS = 180;
export const SPOTIFY_REFRESH_TOKEN_LIFETIME_MS =
  SPOTIFY_REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

/** Ciphertext format version prefix — bump if the scheme ever changes. */
const CIPHERTEXT_VERSION = "v1";
/** Fixed scrypt salt: the derivation input (client secret) is itself secret. */
const KEY_SALT = "portfolio-v6:spotify-token:v1";

export interface StoredSpotifyToken {
  refreshToken: string;
  authorizedAt: Date;
}

// One-row cache of the decrypted token so the hot path (/api/now-playing token
// refresh, ~1/hour) does not hit the database. `undefined` = not yet loaded,
// `null` = loaded and known-absent (or undecryptable).
let cached: StoredSpotifyToken | null | undefined = undefined;

function deriveKey(clientSecret: string): Buffer {
  return scryptSync(clientSecret, KEY_SALT, 32);
}

/** AES-256-GCM encrypt to `v1:<iv>:<authTag>:<ciphertext>` (base64 fields). */
export function encryptToken(clientSecret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(clientSecret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    CIPHERTEXT_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ct.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a `v1:` ciphertext. Returns null on ANY failure (wrong key after a
 * client-secret rotation, tampered/truncated value, unknown version) — the
 * caller treats that as "no stored token" and the §4.6 degrade contract holds.
 */
export function decryptToken(
  clientSecret: string,
  ciphertext: string
): string | null {
  try {
    const [version, ivB64, tagB64, ctB64] = ciphertext.split(":");
    if (version !== CIPHERTEXT_VERSION || !ivB64 || !tagB64 || !ctB64) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(clientSecret),
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Upsert the freshly authorized refresh token (admin reconnect callback).
 * `authorized_at` is reset because a new authorization starts a new 180-day
 * window. Throws on DB/crypto failure — the callback surfaces it as the error
 * redirect rather than pretending the reconnect worked.
 */
export async function saveSpotifyRefreshToken(
  clientSecret: string,
  refreshToken: string
): Promise<void> {
  if (!clientSecret || !refreshToken) {
    throw new Error("A client secret and refresh token are both required");
  }
  const now = new Date();
  await getDb()("service_tokens")
    .insert({
      service: SPOTIFY_SERVICE_KEY,
      token_ciphertext: encryptToken(clientSecret, refreshToken),
      authorized_at: now,
      updated_at: now,
    })
    .onConflict("service")
    .merge(["token_ciphertext", "authorized_at", "updated_at"]);
  cached = { refreshToken, authorizedAt: now };
}

/**
 * The stored (admin-connected) token, or null when absent/undecryptable. Never
 * throws: with no database (IS_LOCAL bring-up before migrate, tests) or a
 * transient DB error it logs and returns null, and the caller falls back to the
 * `spotify_refresh_token` secret — the §4.6 degrade contract, not a 5xx.
 */
export async function getStoredSpotifyToken(
  clientSecret: string
): Promise<StoredSpotifyToken | null> {
  if (cached !== undefined) {
    return cached;
  }
  let row: { token_ciphertext: string; authorized_at: Date } | undefined;
  try {
    row = await getDb()("service_tokens")
      .where({ service: SPOTIFY_SERVICE_KEY })
      .first();
  } catch (err) {
    console.error(
      "[spotifyTokenStore] could not read the stored token; falling back to the secrets token:",
      err instanceof Error ? err.message : err
    );
    return null; // NOT cached — a transient DB error should be retried next call.
  }

  if (!row) {
    cached = null;
    return null;
  }

  const refreshToken = decryptToken(clientSecret, row.token_ciphertext);
  if (refreshToken === null) {
    console.error(
      "[spotifyTokenStore] stored token could not be decrypted (client secret " +
        "rotated?) — reconnect Spotify from the admin Integrations page"
    );
    cached = null;
    return null;
  }

  cached = { refreshToken, authorizedAt: new Date(row.authorized_at) };
  return cached;
}

/** Remove the stored token (admin disconnect). True iff a row was deleted. */
export async function deleteStoredSpotifyToken(): Promise<boolean> {
  const deleted = await getDb()("service_tokens")
    .where({ service: SPOTIFY_SERVICE_KEY })
    .del();
  cached = null;
  return deleted > 0;
}

/** Test-only: forget the in-memory copy so the next read hits the database. */
export function _resetSpotifyTokenStoreForTests(): void {
  cached = undefined;
}
