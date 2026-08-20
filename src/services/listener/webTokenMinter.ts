import { createHmac } from "crypto";

/**
 * Web-player access token minter (task #116 in the listener series).
 *
 * The connect-listener (task #117 onward) needs the same short-lived access
 * token the Spotify web player itself carries when it opens the dealer
 * websocket. Historically the web player fetched this from
 * `open.spotify.com/get_access_token`; since 2024/2025 it GETs
 * `open.spotify.com/api/token?reason=init&productType=web-player`, carrying
 * the account's `sp_dc` session cookie in the `Cookie` header. Since 2025 it
 * also attaches a TOTP-style `totp`/`totpVer` pair computed from a
 * community-known secret (rotated periodically by Spotify) and the server's
 * current wall clock (fetched from `open.spotify.com/api/server-time`).
 *
 * -----------------------------------------------------------------------------
 * FRAGILE, REVERSE-ENGINEERED CONSTANTS BELOW
 * -----------------------------------------------------------------------------
 * Every string, byte, and number in the `FRAGILE` block is derived by reading
 * the current Spotify web-player bundle and observing what it sends. Spotify
 * rotates the TOTP secret and occasionally moves the endpoint or version, so
 * these values WILL break periodically without warning; the minter will start
 * classifying every call as `invalid_cookie` (a 401 or 403 from Spotify) or
 * `transient` (unexpected body / server error). When that happens:
 *
 *   1. Open a signed-in Spotify web-player tab, capture the `/api/token`
 *      request from DevTools' network panel, and compare its `totpVer`, path,
 *      and query parameters against `FRAGILE` below.
 *   2. Locate the TOTP secret in the web-player JS bundle (search the bundle
 *      for `totpVer` and the version number one below the new one). Update
 *      `FRAGILE.totpSecretVersion` and `FRAGILE.totpSecretCipherBytes`
 *      together.
 *   3. If Spotify changes the derivation (currently: XOR every byte with a
 *      per-index constant, join as a decimal string, hex-encode, then base32
 *      the hex-utf8 bytes), update `deriveTotpBase32Secret` too.
 *   4. Run the tests in `__tests__/webTokenMinter.test.ts`. They lock in the
 *      wire shape (path, method, cookie header, query params, and totp
 *      parameter presence) so regressions show up immediately.
 *
 * NOTHING OUTSIDE THIS FILE MAY KNOW ABOUT `sp_dc`, `totp`, or the endpoint
 * layout: the connect-listener asks only for `mintWebToken(spDc)`.
 * -----------------------------------------------------------------------------
 */
const FRAGILE = {
  /**
   * The current web-player token endpoint. Spotify has moved this before
   * (`/get_access_token` was the previous path). The query string values are
   * what the current bundle sends verbatim.
   */
  tokenEndpoint: "https://open.spotify.com/api/token",
  tokenQuery: {
    reason: "init",
    productType: "web-player",
  } as const,
  /**
   * The wall-clock endpoint the web player consults before signing the TOTP,
   * so client clock skew does not invalidate the token. Response shape today
   * is `{ serverTime: <unix-seconds> }`.
   */
  serverTimeEndpoint: "https://open.spotify.com/api/server-time",
  /**
   * Cipher bytes reverse-engineered from the Spotify web-player bundle. See
   * the block header above for how to refresh them; the bytes and the version
   * MUST always be updated together (Spotify's server checks that `totpVer`
   * matches the secret it was signed with).
   */
  totpSecretVersion: 10,
  totpSecretCipherBytes: [
    61, 105, 55, 82, 76, 91, 88, 51, 76, 88, 45, 44, 79, 122, 116, 111,
  ] as readonly number[],
  /**
   * TOTP shape parameters: HMAC-SHA1, 6 digits, 30-second step. These have
   * been stable across every observed Spotify secret revision; if a future
   * version changes any of them, update them here.
   */
  totpDigits: 6,
  totpPeriodSeconds: 30,
  totpAlgorithm: "sha1" as const,
} as const;

/** Fetch timeout for every network call this module makes. */
export const WEB_TOKEN_UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Safety margin subtracted from the token's advertised expiry so callers
 * refresh slightly before it dies rather than racing a 401.
 */
export const WEB_TOKEN_EXPIRY_SAFETY_MS = 60_000;

/**
 * Categorized failure kinds surfaced by `mintWebToken`. Callers (the listener
 * loop in task #117 onward) branch on these:
 *
 *   - `invalid_cookie`: Spotify rejected the sp_dc (401 / 403 style). A stable
 *     state (retrying will keep failing) until the admin pastes a fresh
 *     cookie via the `service_tokens` write path.
 *   - `transient`: Anything else. Network error, 5xx, unexpected response
 *     shape, request timeout. Callers should back off and retry.
 */
export type WebTokenErrorKind = "invalid_cookie" | "transient";

/**
 * Typed error the minter throws. The `kind` field is the whole point; the
 * message is deliberately status-shape-only (never the sp_dc, never the
 * returned access token, never a raw response body).
 */
export class WebTokenMintError extends Error {
  readonly kind: WebTokenErrorKind;
  constructor(kind: WebTokenErrorKind, message: string) {
    super(message);
    this.name = "WebTokenMintError";
    this.kind = kind;
  }
}

export interface MintedWebToken {
  token: string;
  expiresAtMs: number;
}

interface CacheEntry {
  cookieFingerprint: string;
  token: string;
  expiresAtMs: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<MintedWebToken> | null = null;
let inFlightCookieFingerprint: string | null = null;

/**
 * Cheap, non-reversible fingerprint of the sp_dc value used to invalidate the
 * cache when the admin rotates the cookie without holding the plaintext in
 * module state. Truncated so no useful fragment ever appears in memory.
 */
function fingerprintCookie(spDc: string): string {
  return createHmac("sha256", "webTokenMinter:fingerprint:v1")
    .update(spDc)
    .digest("hex")
    .slice(0, 16);
}

function base32Encode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  while (output.length % 8 !== 0) {
    output += "=";
  }
  return output;
}

/**
 * Derive the base32 TOTP secret from the current cipher bytes. The
 * transformation (XOR per index, decimal-string join, utf8-hex-string, then
 * base32 of the hex bytes) mirrors what the Spotify web-player bundle does.
 * Isolated so a single function needs to change when Spotify rotates the
 * scheme rather than the cipher bytes.
 */
function deriveTotpBase32Secret(): string {
  const processed = FRAGILE.totpSecretCipherBytes.map(
    (byte, index) => byte ^ ((index % 33) + 9)
  );
  const decimalJoined = processed.join("");
  const utf8 = Buffer.from(decimalJoined, "utf8");
  const hex = utf8.toString("hex");
  const hexBytes = Buffer.from(hex, "utf8");
  return base32Encode(hexBytes).replace(/=+$/, "");
}

/**
 * Base32 → bytes for the HMAC key. Restricted to the RFC 4648 alphabet, which
 * is all `deriveTotpBase32Secret` ever produces.
 */
function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = secret.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Compute the current TOTP for the given unix-second server time. Standard
 * HOTP-of-counter, hex-encoded as a 6-digit decimal per RFC 6238.
 */
function computeTotp(serverTimeSeconds: number): string {
  const counter = Math.floor(serverTimeSeconds / FRAGILE.totpPeriodSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(deriveTotpBase32Secret());
  const hmac = createHmac(FRAGILE.totpAlgorithm, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const modulo = 10 ** FRAGILE.totpDigits;
  return String(binary % modulo).padStart(FRAGILE.totpDigits, "0");
}

function timeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    WEB_TOKEN_UPSTREAM_TIMEOUT_MS
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Fetch Spotify's authoritative unix-second wall clock. A failure here is
 * transient; the token exchange itself has not been tried yet.
 */
async function fetchServerTimeSeconds(): Promise<number> {
  const { signal, clear } = timeoutSignal();
  let res: Response;
  try {
    res = await fetch(FRAGILE.serverTimeEndpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    throw new WebTokenMintError(
      "transient",
      `server-time fetch failed: ${describeNetworkError(err)}`
    );
  } finally {
    clear();
  }

  if (res.status < 200 || res.status >= 300) {
    throw new WebTokenMintError(
      "transient",
      `server-time returned status ${res.status}`
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const serverTime = (body as { serverTime?: unknown } | null)?.serverTime;
  if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) {
    throw new WebTokenMintError(
      "transient",
      "server-time response missing numeric serverTime"
    );
  }
  return serverTime;
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "timeout";
    return err.name;
  }
  return "unknown";
}

/**
 * The actual token exchange. Sends the sp_dc as a `Cookie` header (never as a
 * URL fragment, never logged) and returns Spotify's raw response body. The
 * caller classifies status codes.
 */
async function exchangeSpDcForAccessToken(
  spDc: string,
  serverTimeSeconds: number
): Promise<{ accessToken: string; expiresAtMs: number }> {
  const totp = computeTotp(serverTimeSeconds);
  const url = new URL(FRAGILE.tokenEndpoint);
  for (const [key, value] of Object.entries(FRAGILE.tokenQuery)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("totp", totp);
  url.searchParams.set("totpVer", String(FRAGILE.totpSecretVersion));

  const { signal, clear } = timeoutSignal();
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: `sp_dc=${spDc}`,
      },
      signal,
    });
  } catch (err) {
    throw new WebTokenMintError(
      "transient",
      `token exchange failed: ${describeNetworkError(err)}`
    );
  } finally {
    clear();
  }

  if (res.status === 401 || res.status === 403) {
    // Spotify rejected the cookie. A stable state until an admin re-enters
    // sp_dc, so surface as `invalid_cookie` and let the listener loop
    // suspend rather than hammer the endpoint. NEVER echo any body content.
    throw new WebTokenMintError(
      "invalid_cookie",
      `token exchange rejected sp_dc with status ${res.status}`
    );
  }

  if (res.status < 200 || res.status >= 300) {
    throw new WebTokenMintError(
      "transient",
      `token exchange returned status ${res.status}`
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = body as {
    accessToken?: unknown;
    accessTokenExpirationTimestampMs?: unknown;
    isAnonymous?: unknown;
  } | null;
  const accessToken = parsed?.accessToken;
  const expiresAtRaw = parsed?.accessTokenExpirationTimestampMs;

  // Spotify signals "your cookie was accepted but you are not signed in"
  // with a 200 body that carries `isAnonymous: true` and no useful token;
  // classify that as invalid_cookie so the admin gets asked to re-paste.
  if (parsed?.isAnonymous === true) {
    throw new WebTokenMintError(
      "invalid_cookie",
      "token exchange returned anonymous session (sp_dc not signed in)"
    );
  }

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new WebTokenMintError(
      "transient",
      "token exchange body missing accessToken"
    );
  }
  if (
    typeof expiresAtRaw !== "number" ||
    !Number.isFinite(expiresAtRaw) ||
    expiresAtRaw <= 0
  ) {
    throw new WebTokenMintError(
      "transient",
      "token exchange body missing accessTokenExpirationTimestampMs"
    );
  }

  return { accessToken, expiresAtMs: expiresAtRaw };
}

/**
 * Exchange the stored sp_dc cookie for a Spotify web-player access token,
 * single-flighted and cached until just before expiry.
 *
 * Failure modes:
 *   - Throws `WebTokenMintError` with `kind: "invalid_cookie"` on 401/403 or
 *     an `isAnonymous` body. Caller should stop retrying until a fresh cookie
 *     is stored.
 *   - Throws `WebTokenMintError` with `kind: "transient"` on network errors,
 *     timeouts, 5xx, or an unexpected body. Caller should back off and retry.
 *
 * Never logs `spDc` or the minted `token`. Every error message describes only
 * status codes and shape observations.
 */
export async function mintWebToken(spDc: string): Promise<MintedWebToken> {
  if (!spDc) {
    // Not an invalid cookie per Spotify; the caller passed nothing. Still
    // classified as `invalid_cookie` so the listener loop treats "no stored
    // cookie" identically to "Spotify rejected the stored cookie".
    throw new WebTokenMintError("invalid_cookie", "no sp_dc provided");
  }

  const fingerprint = fingerprintCookie(spDc);
  const now = Date.now();

  if (
    cache &&
    cache.cookieFingerprint === fingerprint &&
    cache.expiresAtMs > now
  ) {
    return { token: cache.token, expiresAtMs: cache.expiresAtMs };
  }

  if (inFlight && inFlightCookieFingerprint === fingerprint) {
    return inFlight;
  }

  const attempt = (async (): Promise<MintedWebToken> => {
    const serverTimeSeconds = await fetchServerTimeSeconds();
    const { accessToken, expiresAtMs } = await exchangeSpDcForAccessToken(
      spDc,
      serverTimeSeconds
    );
    const effectiveExpiry = expiresAtMs - WEB_TOKEN_EXPIRY_SAFETY_MS;
    cache = {
      cookieFingerprint: fingerprint,
      token: accessToken,
      expiresAtMs: effectiveExpiry,
    };
    return { token: accessToken, expiresAtMs: effectiveExpiry };
  })();

  inFlight = attempt;
  inFlightCookieFingerprint = fingerprint;

  try {
    return await attempt;
  } finally {
    if (inFlight === attempt) {
      inFlight = null;
      inFlightCookieFingerprint = null;
    }
  }
}

/** Test-only: drop the cached token and any in-flight promise. */
export function _resetWebTokenMinterForTests(): void {
  cache = null;
  inFlight = null;
  inFlightCookieFingerprint = null;
}

/**
 * Test-only view of the fragile constants so tests can assert the wire shape
 * without duplicating literals. Kept small on purpose: no cipher bytes, no
 * derived secret material.
 */
export const _WEB_TOKEN_MINTER_WIRE = {
  tokenEndpoint: FRAGILE.tokenEndpoint,
  tokenQuery: FRAGILE.tokenQuery,
  serverTimeEndpoint: FRAGILE.serverTimeEndpoint,
  totpVersion: FRAGILE.totpSecretVersion,
  totpDigits: FRAGILE.totpDigits,
} as const;
