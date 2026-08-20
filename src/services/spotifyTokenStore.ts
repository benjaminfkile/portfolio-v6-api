import {
  deleteStoredServiceToken,
  getStoredServiceToken,
  rotateServiceTokenCiphertext,
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
 * the browser and stores it here; this store is the ONLY grant source for the
 * polling fallback lane (there is no env or secret fallback).
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

/**
 * Persist a rotated refresh token from a Spotify refresh response (task #112).
 * Under Spotify's June 2026 rotation/reuse behavior, every successful refresh
 * MAY return a new `refresh_token` — failing to persist it kills the stored
 * grant within days (the old token becomes unusable on the next refresh).
 * `authorized_at` is PRESERVED because rotation does not extend the 180-day
 * validity window (§4.6). Idempotent / last-write-wins; only the polling
 * leader refreshes (single-poller invariant, task #84). Returns true when
 * a row was rotated, false when no stored row exists (defensive: this should
 * only happen if the admin disconnected mid-refresh).
 */
export async function rotateSpotifyRefreshToken(
  encryptionKey: string,
  refreshToken: string
): Promise<boolean> {
  if (!encryptionKey || !refreshToken) {
    throw new Error("An encryption key and refresh token are both required");
  }
  return rotateServiceTokenCiphertext(
    SPOTIFY_SERVICE_KEY,
    encryptionKey,
    refreshToken
  );
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
