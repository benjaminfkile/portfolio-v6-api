import { createHash, randomBytes } from "crypto";
import { getDb } from "../db/db";

/**
 * Preview tokens — TECH_SPEC_V1.md §7.
 *
 * The admin embeds the real public site in a preview iframe (§7). The public
 * bundle has no Cognito SDK and no bearer token by design (§2.1), so the two
 * preview-serialization routes accept an opaque, single-purpose, short-lived
 * token instead. This token grants read-only access to draft content and nothing
 * else, so it is safe to place in a URL (`?preview=<token>`).
 *
 * The store is a shared Postgres table (`preview_tokens`) because the API runs
 * as multiple instances behind a load balancer: a preview iframe's fetches
 * round-robin across nodes, so the mint on one instance must be validatable on
 * any other. Same shared-record-is-authoritative philosophy as the Spotify
 * suspension work (task #97). Only the sha256 hash of each token is persisted;
 * the raw token is returned to the caller once and never lives in the database.
 */

/** Token lifetime: 15 minutes (§7). */
export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

const PREVIEW_TOKENS_TABLE = "preview_tokens";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedPreviewToken {
  token: string;
  /** ISO-8601 absolute expiry, convenient for the client. */
  expiresAt: string;
  /** Milliseconds until expiry, for the response body. */
  expiresInMs: number;
}

/**
 * Mint a cryptographically random opaque token with a 15-minute expiry, storing
 * only its sha256 hash in the shared `preview_tokens` table so any instance can
 * validate it. 32 random bytes (256 bits) hex-encoded — not a JWT, carries no
 * claims, and is only ever a lookup key. Expired rows are dropped
 * opportunistically here so the table self-cleans as tokens are minted.
 */
export async function mintPreviewToken(
  now: number = Date.now()
): Promise<MintedPreviewToken> {
  const token = randomBytes(32).toString("hex");
  const expiry = now + PREVIEW_TOKEN_TTL_MS;
  const db = getDb();
  await db(PREVIEW_TOKENS_TABLE).where("expires_at", "<=", new Date(now)).del();
  await db(PREVIEW_TOKENS_TABLE).insert({
    token_hash: hashToken(token),
    expires_at: new Date(expiry),
  });
  return {
    token,
    expiresAt: new Date(expiry).toISOString(),
    expiresInMs: PREVIEW_TOKEN_TTL_MS,
  };
}

/**
 * True iff the presented token hashes to a stored, unexpired row. An expired
 * row hit during lookup is deleted so the table self-cleans on validation too.
 * Unknown and expired tokens are indistinguishable to the caller (both false) —
 * callers return 401 for either (§7).
 */
export async function isValidPreviewToken(
  token: string | undefined | null,
  now: number = Date.now()
): Promise<boolean> {
  if (!token) {
    return false;
  }
  const db = getDb();
  const tokenHash = hashToken(token);
  const row = (await db(PREVIEW_TOKENS_TABLE)
    .where({ token_hash: tokenHash })
    .select("expires_at")
    .first()) as { expires_at: Date } | undefined;
  if (!row) {
    return false;
  }
  if (new Date(row.expires_at).getTime() <= now) {
    await db(PREVIEW_TOKENS_TABLE).where({ token_hash: tokenHash }).del();
    return false;
  }
  return true;
}

/** Drop every token. Test-only helper so suites start from a clean store. */
export async function clearPreviewTokens(): Promise<void> {
  await getDb()(PREVIEW_TOKENS_TABLE).del();
}
