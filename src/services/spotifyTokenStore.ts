import {
  deleteStoredServiceToken,
  getStoredServiceToken,
  saveServiceToken,
  _resetServiceTokenStoreForTests,
} from "./serviceTokenStore";

/**
 * Spotify refresh-token store (§4.6) — now a thin façade over the generalized,
 * service-keyed `serviceTokenStore` (§4.7). It keeps the Spotify-named exports so
 * the now-playing hot path (nowPlayingRouter) and the existing tests stay
 * unchanged while the storage/crypto live in one shared place.
 *
 * Since Spotify's June 2026 policy change, refresh tokens expire 180 days after
 * the user's original authorization. The admin reconnect flow mints a new one in
 * the browser and stores it here; `/api/now-playing` prefers this stored token
 * and falls back to the `spotify_refresh_token` secret for installs still on the
 * one-time `scripts/spotify-auth.ts` bootstrap.
 *
 * The `encryptionKey` argument these helpers take used to be the Spotify client
 * secret verbatim; callers now pass the resolved encryption key
 * (serviceTokenStore.resolveEncryptionKey — `token_encryption_key` when present,
 * else the client secret), which is identical whenever the dedicated key is unset.
 */

// Re-exported crypto helpers keep the pre-generalization import surface intact.
export { encryptToken, decryptToken } from "./serviceTokenStore";

/** The `service_tokens.service` key Spotify owns. */
export const SPOTIFY_SERVICE_KEY = "spotify";

/** Spotify's refresh-token lifetime since the June 2026 policy change. */
export const SPOTIFY_REFRESH_TOKEN_LIFETIME_DAYS = 180;
export const SPOTIFY_REFRESH_TOKEN_LIFETIME_MS =
  SPOTIFY_REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

export interface StoredSpotifyToken {
  refreshToken: string;
  authorizedAt: Date;
}

/** Upsert the freshly authorized refresh token (admin reconnect callback). */
export async function saveSpotifyRefreshToken(
  encryptionKey: string,
  refreshToken: string
): Promise<void> {
  if (!encryptionKey || !refreshToken) {
    throw new Error("An encryption key and refresh token are both required");
  }
  await saveServiceToken(SPOTIFY_SERVICE_KEY, encryptionKey, refreshToken);
}

/** The stored (admin-connected) token, or null when absent/undecryptable. */
export async function getStoredSpotifyToken(
  encryptionKey: string
): Promise<StoredSpotifyToken | null> {
  const stored = await getStoredServiceToken(SPOTIFY_SERVICE_KEY, encryptionKey);
  if (!stored) {
    return null;
  }
  return { refreshToken: stored.token, authorizedAt: stored.authorizedAt };
}

/** Remove the stored token (admin disconnect). True iff a row was deleted. */
export async function deleteStoredSpotifyToken(): Promise<boolean> {
  return deleteStoredServiceToken(SPOTIFY_SERVICE_KEY);
}

/** Test-only: forget the in-memory copy so the next read hits the database. */
export function _resetSpotifyTokenStoreForTests(): void {
  _resetServiceTokenStoreForTests();
}
