import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { getDb } from "../db/db";
import { IAppSecrets } from "../interfaces";

/**
 * Service-keyed encrypted credential store (§4.7) — the generalized backend for
 * every integration's stored secret. It owns the `service_tokens` table (one row
 * per integration `key`) and the AES-256-GCM crypto that keeps the credential as
 * ciphertext at rest, so a database dump alone never reveals it.
 *
 * This began as the Spotify-only token store (§4.6) and was extracted here so the
 * three real cases share one implementation:
 *   - spotify  (auth_kind 'oauth')   — an encrypted refresh token
 *   - github   (auth_kind 'api_key') — an encrypted personal access token
 *   - duolingo (auth_kind 'value')   — a public username (still encrypted so the
 *     store has one shape; it is not secret, just uniformly handled)
 *
 * The Spotify-named helpers in spotifyTokenStore.ts now delegate here, so the
 * now-playing hot path and the existing tests keep working unchanged.
 *
 * DOCUMENTED CHOICE — encryption key derivation (see resolveEncryptionKey): the
 * scrypt input is `token_encryption_key` when the app secret is present, else it
 * falls back to `spotify_client_secret`. Rationale:
 *   - Back-compat: before the dedicated key is introduced, spotify ciphertext
 *     stays derived from the client secret exactly as before, so nothing already
 *     stored becomes undecryptable.
 *   - After a key change (introducing the dedicated key, or rotating either
 *     input) old ciphertext no longer decrypts; per the §4.6/§4.7 degrade rule a
 *     decrypt failure is treated as "not connected" (never a 5xx), and the fix is
 *     re-entering the value / reconnecting the OAuth integration.
 * The salt below is deliberately left at its historical Spotify value so that
 * ciphertext written by the pre-generalization store remains decryptable.
 */

/** Ciphertext format version prefix — bump if the scheme ever changes. */
const CIPHERTEXT_VERSION = "v1";
/**
 * Fixed scrypt salt: the derivation input is itself secret. Left at the original
 * Spotify value ON PURPOSE — changing it would re-derive the key and orphan every
 * ciphertext the pre-generalization store already wrote (§4.7 back-compat).
 */
const KEY_SALT = "portfolio-v6:spotify-token:v1";

export interface StoredServiceToken {
  /** The decrypted credential (refresh token, PAT, username, …). */
  token: string;
  authorizedAt: Date;
}

/**
 * Resolve the scrypt derivation input for the crypto below (§4.7). Prefers the
 * dedicated `token_encryption_key`, falling back to `spotify_client_secret` for
 * back-compat with ciphertext written before the dedicated key existed.
 */
export function resolveEncryptionKey(secrets: IAppSecrets | undefined): string {
  return (
    secrets?.token_encryption_key || secrets?.spotify_client_secret || ""
  );
}

// Per-service one-row cache of the decrypted token so hot paths (e.g. the
// now-playing token refresh, ~1/hour) do not hit the database. A missing map
// entry = not yet loaded; a stored `value: null` = loaded and known
// absent/undecryptable. Every entry carries an `expiresAt` deadline so a
// process converges on the DB truth within `SERVICE_TOKEN_CACHE_TTL_MS` even
// when the row was updated on a DIFFERENT process (task #121: cross-instance
// stale-cache wedge, where a resume-then-fetch on the polling leader would
// read its own stale token, get invalid_grant, and re-suspend permanently).
interface CacheEntry {
  value: StoredServiceToken | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Task #121 - cache TTL for every service. Sixty seconds is short enough that
 * an admin reconnect on one instance propagates to the polling leader within
 * one Redis-side resume tick, and long enough that the hot paths (~1/hour
 * token refresh, ~1/tick presence read) still avoid the DB. Applies uniformly
 * to spotify / github / duolingo / spotify_listener - one extra DB read per
 * minute per service is negligible under the single-poller invariant.
 */
export const SERVICE_TOKEN_CACHE_TTL_MS = 60 * 1000;

function cacheEntry(
  value: StoredServiceToken | null,
  now: number = Date.now()
): CacheEntry {
  return { value, expiresAt: now + SERVICE_TOKEN_CACHE_TTL_MS };
}

function deriveKey(encryptionKey: string): Buffer {
  return scryptSync(encryptionKey, KEY_SALT, 32);
}

/** AES-256-GCM encrypt to `v1:<iv>:<authTag>:<ciphertext>` (base64 fields). */
export function encryptToken(encryptionKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(encryptionKey), iv);
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
 * secret rotation, tampered/truncated value, unknown version) — the caller treats
 * that as "no stored token" and the §4.7 degrade contract holds.
 */
export function decryptToken(
  encryptionKey: string,
  ciphertext: string
): string | null {
  try {
    const [version, ivB64, tagB64, ctB64] = ciphertext.split(":");
    if (version !== CIPHERTEXT_VERSION || !ivB64 || !tagB64 || !ctB64) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(encryptionKey),
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
 * Upsert the freshly authorized credential for `service`. `authorized_at` is
 * reset because a new authorization starts a new validity window (e.g. Spotify's
 * 180 days). Throws on DB/crypto failure — the caller surfaces it rather than
 * pretending the write succeeded.
 */
export async function saveServiceToken(
  service: string,
  encryptionKey: string,
  plaintext: string
): Promise<void> {
  if (!service || !plaintext) {
    throw new Error("A service key and value are both required");
  }
  const now = new Date();
  await getDb()("service_tokens")
    .insert({
      service,
      token_ciphertext: encryptToken(encryptionKey, plaintext),
      authorized_at: now,
      updated_at: now,
    })
    .onConflict("service")
    .merge(["token_ciphertext", "authorized_at", "updated_at"]);
  cache.set(service, cacheEntry({ token: plaintext, authorizedAt: now }));
}

/**
 * Rotate the ciphertext for an existing row while PRESERVING `authorized_at`
 * (task #112). Used by the Spotify refresh path: Spotify's June 2026 policy
 * rotates the refresh token on refresh, but rotation does NOT extend the
 * 180-day validity window — the original grant time is what expires. If no
 * row exists this returns false (a fresh grant would go through the admin
 * reconnect flow / `saveServiceToken`, which sets a new `authorized_at`).
 * Idempotent / last-write-wins under the single-poller invariant (task #84).
 */
export async function rotateServiceTokenCiphertext(
  service: string,
  encryptionKey: string,
  plaintext: string
): Promise<boolean> {
  if (!service || !plaintext) {
    throw new Error("A service key and value are both required");
  }
  const now = new Date();
  const updated = await getDb()("service_tokens")
    .where({ service })
    .update({
      token_ciphertext: encryptToken(encryptionKey, plaintext),
      updated_at: now,
    });
  if (updated === 0) {
    // No row to rotate — clear the cache so a next read hits the DB and
    // observes the truth (no stored token). Callers treat that as
    // "no rotation persisted"; the disconnected state stands.
    cache.delete(service);
    return false;
  }
  // Preserve the cached authorizedAt if we have it; otherwise drop the cache
  // so the next read fetches the (unchanged) authorized_at from the DB.
  const cached = cache.get(service);
  if (cached && cached.value && cached.value.authorizedAt) {
    cache.set(
      service,
      cacheEntry({ token: plaintext, authorizedAt: cached.value.authorizedAt })
    );
  } else {
    cache.delete(service);
  }
  return true;
}

/**
 * The stored credential for `service`, or null when absent/undecryptable. Never
 * throws: with no database (IS_LOCAL bring-up before migrate, tests) or a
 * transient DB error it logs and returns null — the §4.7 degrade contract, not a
 * 5xx.
 */
export async function getStoredServiceToken(
  service: string,
  encryptionKey: string
): Promise<StoredServiceToken | null> {
  const now = Date.now();
  const cached = cache.get(service);
  // Task #121 - honour the TTL so a cross-instance update (admin reconnects
  // via instance A; polling leader is instance B) converges within a minute
  // even without an explicit invalidation. A stale entry falls through to a
  // fresh DB read below.
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  let row: { token_ciphertext: string; authorized_at: Date } | undefined;
  try {
    row = await getDb()("service_tokens").where({ service }).first();
  } catch (err) {
    console.error(
      `[serviceTokenStore] could not read the stored token for '${service}':`,
      err instanceof Error ? err.message : err
    );
    return null; // NOT cached — a transient DB error should be retried next call.
  }

  if (!row) {
    cache.set(service, cacheEntry(null, now));
    return null;
  }

  const token = decryptToken(encryptionKey, row.token_ciphertext);
  if (token === null) {
    console.error(
      `[serviceTokenStore] stored token for '${service}' could not be decrypted ` +
        "(encryption key rotated?) — re-enter it from the admin Integrations page"
    );
    cache.set(service, cacheEntry(null, now));
    return null;
  }

  const stored = { token, authorizedAt: new Date(row.authorized_at) };
  cache.set(service, cacheEntry(stored, now));
  return stored;
}

/**
 * Read only the `updated_at` column for `service` — used by the poll loop's
 * auth-suspension resume check (task #95): while Spotify is suspended, the
 * leader compares this timestamp at most once per minute to a snapshot taken
 * at suspend-time and resumes on change. Never throws (a DB blip is logged
 * and reported as `null`, which the caller treats as "no change").
 */
export async function getServiceTokenUpdatedAt(
  service: string
): Promise<Date | null> {
  try {
    const row = (await getDb()("service_tokens")
      .where({ service })
      .select("updated_at")
      .first()) as { updated_at: Date } | undefined;
    return row ? new Date(row.updated_at) : null;
  } catch (err) {
    console.error(
      `[serviceTokenStore] could not read updated_at for '${service}':`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Remove the stored credential for `service`. True iff a row was deleted. */
export async function deleteStoredServiceToken(
  service: string
): Promise<boolean> {
  const deleted = await getDb()("service_tokens").where({ service }).del();
  cache.set(service, cacheEntry(null));
  return deleted > 0;
}

/**
 * Task #121 - explicit cache invalidation for `service`. The next
 * `getStoredServiceToken(service)` call is guaranteed to hit the database,
 * regardless of how much of the TTL is left. Called from the Spotify auth
 * resume path (spotifyService.resumeSpotifyAuth + the spotifyLane resume
 * transitions) so the first post-resume fetch reads the fresh DB row
 * immediately rather than up to `SERVICE_TOKEN_CACHE_TTL_MS` later.
 */
export function invalidateServiceTokenCache(service: string): void {
  cache.delete(service);
}

/** Test-only: forget every in-memory copy so the next read hits the database. */
export function _resetServiceTokenStoreForTests(): void {
  cache.clear();
}
