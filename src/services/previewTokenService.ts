import { randomBytes } from "crypto";

/**
 * Preview tokens — TECH_SPEC_V1.md §7.
 *
 * The admin embeds the real public site in a preview iframe (§7). The public
 * bundle has no Cognito SDK and no bearer token by design (§2.1), so the two
 * preview-serialization routes accept an opaque, single-purpose, short-lived
 * token instead. This token grants read-only access to draft content and nothing
 * else, so it is safe to place in a URL (`?preview=<token>`).
 *
 * The store is intentionally in-memory: tokens live 15 minutes and are cheap to
 * re-mint, so surviving a container restart is not worth a DB round-trip. A
 * container has a single admin class and low request volume, so a Map is ample.
 */

/** Token lifetime: 15 minutes (§7). */
export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

// token -> absolute expiry (epoch ms).
const store = new Map<string, number>();

export interface MintedPreviewToken {
  token: string;
  /** ISO-8601 absolute expiry, convenient for the client. */
  expiresAt: string;
  /** Milliseconds until expiry, for the response body. */
  expiresInMs: number;
}

/**
 * Mint a cryptographically random opaque token with a 15-minute expiry and hold
 * it in the in-memory store. 32 random bytes (256 bits) hex-encoded — not a JWT,
 * carries no claims, and is only ever a lookup key into this store.
 */
export function mintPreviewToken(now: number = Date.now()): MintedPreviewToken {
  const token = randomBytes(32).toString("hex");
  const expiry = now + PREVIEW_TOKEN_TTL_MS;
  store.set(token, expiry);
  return {
    token,
    expiresAt: new Date(expiry).toISOString(),
    expiresInMs: PREVIEW_TOKEN_TTL_MS,
  };
}

/**
 * True iff the token is known and not expired. An expired token is evicted on
 * access so the store self-cleans as tokens are checked. Unknown and expired
 * tokens are indistinguishable to the caller (both false) — callers return 401
 * for either (§7).
 */
export function isValidPreviewToken(
  token: string | undefined | null,
  now: number = Date.now()
): boolean {
  if (!token) {
    return false;
  }
  const expiry = store.get(token);
  if (expiry === undefined) {
    return false;
  }
  if (expiry <= now) {
    store.delete(token);
    return false;
  }
  return true;
}

/** Drop every token. Test-only helper so suites start from a clean store. */
export function clearPreviewTokens(): void {
  store.clear();
}
