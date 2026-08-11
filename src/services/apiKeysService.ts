import crypto from "crypto";
import { z } from "zod";
import { getDb } from "../db/db";

/**
 * API Keys service — API Keys v1.16.
 *
 * Owns the `api_keys` table behind the admin API-keys router and the middleware
 * that accepts a key on the narrow machine surface (see `requireAdminOrMachine`).
 * These keys REPLACE the never-activated Cognito client-credentials machine path
 * from Machine Auth v1.15 — a consuming app authenticates with a first-class key
 * and needs zero Cognito/AWS dependencies.
 *
 * KEY FORMAT (contract §2):
 *  - full key   = `pv6k_` + 32 random bytes (crypto.randomBytes) base64url — a
 *                 Node-built-in-only design, no new deps.
 *  - key_prefix = the first 12 chars of the full key (e.g. `pv6k_ab12cd3`), stored
 *                 for display only.
 *  - key_hash   = hex SHA-256 of the FULL key, stored UNIQUE. The full key is
 *                 NEVER logged or stored anywhere except the single mint response.
 *
 * The stored hash is the credential equalizer: authentication hashes the incoming
 * key and looks the row up by the unique `key_hash` index (never a raw-key
 * compare), so a lookup either finds the exact fixed-length hash or does not.
 */

const API_KEYS = "api_keys";

/** Every key begins with this fixed, publicly-visible prefix. */
export const API_KEY_PREFIX = "pv6k_";

/** How many chars of the full key are kept for display (`pv6k_` + 7 chars). */
export const KEY_PREFIX_LENGTH = 12;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Result envelope --------------------------------------------------------

export type ApiKeyFailureCode = "not_found" | "validation";

export type ApiKeyResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiKeyFailureCode; message: string };

function fail<T>(code: ApiKeyFailureCode, message: string): ApiKeyResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): ApiKeyResult<T> {
  return { ok: true, data };
}

// ---- Row / view shapes ------------------------------------------------------

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** The one-time mint response — the ONLY place the full `key` is ever returned. */
export interface MintedApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  key: string;
}

/** Admin list item — never carries a hash or the full key. */
export interface ApiKeyListItem {
  id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** Metadata for the principal an accepted key authenticates as. */
export interface ApiKeyPrincipal {
  id: string;
  name: string;
}

// ---- Key crypto (Node built-ins only) ---------------------------------------

/** Generate a fresh full key: `pv6k_` + 32 random bytes base64url. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

/** Hex SHA-256 of the full key — what is stored and looked up (never the key). */
export function hashApiKey(fullKey: string): string {
  return crypto.createHash("sha256").update(fullKey).digest("hex");
}

/** The first 12 chars of the full key, kept for display. */
export function keyPrefix(fullKey: string): string {
  return fullKey.slice(0, KEY_PREFIX_LENGTH);
}

// ---- Validation -------------------------------------------------------------

const mintSchema = z
  .object({ name: z.string().trim().min(1, "name must be a non-empty string") })
  .strict();

// ---- Admin operations -------------------------------------------------------

/**
 * Mint a new key. Returns the full `key` EXACTLY ONCE — it is never persisted or
 * retrievable again (only its hash + display prefix are stored).
 */
export async function mintApiKey(input: unknown): Promise<ApiKeyResult<MintedApiKey>> {
  const parsed = mintSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", parsed.error.issues[0]?.message ?? "invalid name");
  }

  const fullKey = generateApiKey();
  const [row] = await getDb()<ApiKeyRow>(API_KEYS)
    .insert({
      name: parsed.data.name,
      key_prefix: keyPrefix(fullKey),
      key_hash: hashApiKey(fullKey),
    })
    .returning(["id", "name", "key_prefix", "created_at"]);

  return ok({
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    key: fullKey,
  });
}

/** List all keys, newest first. Never includes hashes or full keys. */
export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  return getDb()<ApiKeyRow>(API_KEYS)
    .select(
      "id",
      "name",
      "key_prefix",
      "created_at",
      "last_used_at",
      "revoked_at"
    )
    .orderBy("created_at", "desc");
}

/**
 * Revoke a key by id — idempotent: revoking an already-revoked key is still a
 * success (its original `revoked_at` is preserved), and an unknown id is 404.
 */
export async function revokeApiKey(id: string): Promise<ApiKeyResult<ApiKeyListItem>> {
  if (!UUID_RE.test(id)) return fail("not_found", "api key not found");

  const db = getDb();
  const row = await db<ApiKeyRow>(API_KEYS).where({ id }).first();
  if (!row) return fail("not_found", "api key not found");

  if (!row.revoked_at) {
    await db<ApiKeyRow>(API_KEYS).where({ id }).update({ revoked_at: db.fn.now() });
  }

  const updated = await db<ApiKeyRow>(API_KEYS)
    .select(
      "id",
      "name",
      "key_prefix",
      "created_at",
      "last_used_at",
      "revoked_at"
    )
    .where({ id })
    .first();
  return ok(updated as ApiKeyListItem);
}

// ---- Authentication (used by requireAdminOrMachine) -------------------------

/**
 * Authenticate a raw bearer as an ACTIVE api key. Hashes the incoming key and
 * looks it up by the unique `key_hash` index with `revoked_at IS NULL` — the hash
 * is the credential equalizer, so no raw-key comparison ever happens. Returns the
 * principal on a match, or null for a revoked/unknown/malformed key. Never logs
 * the key.
 */
export async function verifyApiKey(rawKey: string): Promise<ApiKeyPrincipal | null> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) return null;

  const row = await getDb()<ApiKeyRow>(API_KEYS)
    .select("id", "name")
    .where({ key_hash: hashApiKey(rawKey) })
    .whereNull("revoked_at")
    .first();

  return row ? { id: row.id, name: row.name } : null;
}

/**
 * Fire-and-forget stamp of `last_used_at`. A failed touch must NEVER fail the
 * request, so this returns immediately and swallows any error.
 */
export function touchApiKeyLastUsed(id: string): void {
  const db = getDb();
  void db<ApiKeyRow>(API_KEYS)
    .where({ id })
    .update({ last_used_at: db.fn.now() })
    .catch(() => {
      /* a failed touch never affects the request */
    });
}
