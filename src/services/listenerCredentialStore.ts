import {
  deleteStoredServiceToken,
  getServiceTokenUpdatedAt,
  getStoredServiceToken,
  saveServiceToken,
  _resetServiceTokenStoreForTests,
} from "./serviceTokenStore";

/**
 * Spotify listener credential store, a thin facade over the generalized
 * `serviceTokenStore` (§4.7). Owns the `spotify_listener` service key: the
 * Spotify web-player `sp_dc` session cookie the connect-listener uses to mint
 * web-player access tokens (task series #115 through #123).
 *
 * The value is a long-lived (~1 year) browser session cookie the admin pastes
 * in from a signed-in Spotify web-player tab. It is stored EXACTLY like every
 * other admin-granted integration credential: one `service_tokens` row,
 * AES-256-GCM at rest, decrypted only where the listener actually needs it.
 * It is write-only from the admin surface: the value never appears in any
 * response, redirect, or log line.
 *
 * The `encryptionKey` argument mirrors spotifyTokenStore's shape. Callers
 * pass the resolved encryption key (serviceTokenStore.resolveEncryptionKey,
 * which returns `token_encryption_key` when present, else
 * `spotify_client_secret`).
 */

/** The `service_tokens.service` key the listener owns. */
export const SPOTIFY_LISTENER_SERVICE_KEY = "spotify_listener";

export interface StoredListenerCredential {
  /** The stored `sp_dc` cookie value. */
  spDc: string;
  authorizedAt: Date;
}

/** Upsert the freshly pasted sp_dc cookie (admin write). */
export async function saveListenerCredential(
  encryptionKey: string,
  spDc: string
): Promise<void> {
  if (!encryptionKey || !spDc) {
    throw new Error("An encryption key and sp_dc value are both required");
  }
  await saveServiceToken(SPOTIFY_LISTENER_SERVICE_KEY, encryptionKey, spDc);
}

/** The stored (admin-granted) listener credential, or null when absent/undecryptable. */
export async function getListenerCredential(
  encryptionKey: string
): Promise<StoredListenerCredential | null> {
  const stored = await getStoredServiceToken(
    SPOTIFY_LISTENER_SERVICE_KEY,
    encryptionKey
  );
  if (!stored) {
    return null;
  }
  return { spDc: stored.token, authorizedAt: stored.authorizedAt };
}

/**
 * Read only the `updated_at` column, useful for callers (the listener loop in
 * a later task) that need to notice a fresh admin-paste without pulling the
 * plaintext through the cache. Never throws (a DB blip yields `null`, treated
 * as "no change").
 */
export async function getListenerCredentialUpdatedAt(): Promise<Date | null> {
  return getServiceTokenUpdatedAt(SPOTIFY_LISTENER_SERVICE_KEY);
}

/** Remove the stored listener credential (admin delete). True iff a row was deleted. */
export async function deleteListenerCredential(): Promise<boolean> {
  return deleteStoredServiceToken(SPOTIFY_LISTENER_SERVICE_KEY);
}

/** Test-only: forget any in-memory copy so the next read hits the database. */
export function _resetListenerCredentialStoreForTests(): void {
  _resetServiceTokenStoreForTests();
}
