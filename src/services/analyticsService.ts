import { createHash, randomBytes } from "crypto";
import { getDb } from "../db/db";
import { IAppSecrets } from "../interfaces";
import { resolveEncryptionKey } from "./serviceTokenStore";

/**
 * Analytics v1.4 — first-party, privacy-respecting ingest (TECH_SPEC_V1.md
 * §4.8). This service owns ALL of the ingest logic; the `/api/beacon` router is
 * a thin shell that extracts a few request fields and always answers 204.
 *
 * Load-bearing privacy properties (§4.8), enforced here:
 *   - No PII is ever stored OR logged. Raw client IP and user-agent are used
 *     ONLY as hash input for `session_key = sha256(day_salt | ip | ua)[:32]`.
 *     The salt derives from the token-encryption key material + the UTC date, so
 *     keys rotate DAILY and cross-day visitor tracking is impossible by
 *     construction. When no key material exists (dev), a random per-boot salt is
 *     used instead.
 *   - Referrers are reduced to their ORIGIN (scheme+host); same-origin or
 *     unparseable referrers store null.
 *   - Known bots (coarse UA match) are dropped at ingest.
 *   - A light in-memory per-IP token bucket (~60 events/min) silently drops
 *     floods; stale buckets are pruned.
 *   - Events older than 365 days are pruned opportunistically (at most once per
 *     UTC day per process).
 *
 * ingestBeacon NEVER throws and NEVER logs request contents. Every failure —
 * invalid input, rate-limited, bot, DB down — resolves to a silent no-op so the
 * caller can unconditionally return 204 (§4.8: a broken beacon must never affect
 * a visitor, and probing it teaches nothing).
 */

/** Hard event allowlist (§4.8). Anything else is dropped. */
const EVENT_ALLOWLIST = new Set([
  "pageview",
  "link_out",
  "video_play",
  "theme_toggle",
  "scroll_depth",
]);

/**
 * Per-event `meta` key allowlist (§4.8): each allowed key maps to its max string
 * length. Events not listed here allow no meta keys ({}). Unknown keys are
 * stripped, never a reason to reject the event.
 */
const META_ALLOWLIST: Record<string, Record<string, number>> = {
  link_out: { href: 200 },
  video_play: { title: 100 },
};

const MAX_PATH = 200;

/** Coarse bot filter (§4.8). */
const BOT_UA = /bot|crawler|spider|crawl|headless|lighthouse|pingdom|monitor/i;

/** Per-process random salt used when no key material exists (dev only, §4.8). */
const BOOT_SALT = randomBytes(32).toString("hex");

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** UTC calendar day as `YYYY-MM-DD`. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The daily-rotating salt (§4.8): `sha256(keyMaterial | 'analytics' | day)`
 * when key material is present, else the random per-boot salt so dev installs
 * without secrets still get a stable-per-boot key.
 */
export function computeDaySalt(keyMaterial: string, dayUtc: string): string {
  if (!keyMaterial) return BOOT_SALT;
  return sha256Hex(`${keyMaterial}|analytics|${dayUtc}`);
}

/** The 32-hex-char visitor key: `sha256(daySalt | ip | ua)` truncated. */
export function computeSessionKey(
  daySalt: string,
  clientIp: string,
  userAgent: string
): string {
  return sha256Hex(`${daySalt}|${clientIp}|${userAgent}`).slice(0, 32);
}

// ---- validation -------------------------------------------------------------

interface ValidEvent {
  event: string;
  path: string;
  referrer: string | null;
  meta: Record<string, string>;
}

/** True when `value` is a string starting with `/` and within the length cap. */
function isValidPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH &&
    value.startsWith("/")
  );
}

/**
 * Reduce a referrer to its ORIGIN (scheme+host). Returns null when it is
 * missing, unparseable, or same-origin with the beacon's own site (compared
 * against the request `Origin` header when present).
 */
function normalizeReferrer(
  referrer: unknown,
  siteOrigin: string | undefined
): string | null {
  if (typeof referrer !== "string" || referrer.length === 0) return null;
  let origin: string;
  try {
    origin = new URL(referrer).origin;
  } catch {
    return null; // unparseable → null
  }
  // `new URL` yields "null" (the string) for opaque origins (e.g. data:, file:).
  if (!origin || origin === "null") return null;
  if (siteOrigin && origin === siteOrigin) return null; // same-origin → null
  return origin;
}

/**
 * Keep only the allowlisted meta keys for this event, each a string within its
 * per-key length cap. Unknown keys, non-string values, and over-length values
 * are silently stripped — never a reason to reject the event.
 */
function sanitizeMeta(event: string, meta: unknown): Record<string, string> {
  const allowed = META_ALLOWLIST[event];
  const out: Record<string, string> = {};
  if (!allowed || typeof meta !== "object" || meta === null) return out;
  for (const [key, max] of Object.entries(allowed)) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0 && value.length <= max) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate + normalize a raw beacon body. Returns null when the event is off the
 * allowlist or the path is invalid — the two hard rejects; everything else
 * (referrer, meta) degrades to null/stripped rather than rejecting.
 */
function parseBody(
  body: unknown,
  siteOrigin: string | undefined
): ValidEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const { event, path, referrer, meta } = body as Record<string, unknown>;
  if (typeof event !== "string" || !EVENT_ALLOWLIST.has(event)) return null;
  if (!isValidPath(path)) return null;
  return {
    event,
    path,
    referrer: normalizeReferrer(referrer, siteOrigin),
    meta: sanitizeMeta(event, meta),
  };
}

// ---- rate limiting ----------------------------------------------------------

interface Bucket {
  tokens: number;
  last: number;
}

const BUCKET_CAPACITY = 60; // ~60 events/min burst
const REFILL_PER_MS = BUCKET_CAPACITY / 60000; // full refill over one minute
const BUCKET_IDLE_MS = 60000; // a bucket idle this long is fully refilled → prunable

const buckets = new Map<string, Bucket>();
let lastPrune = 0;

/** Drop buckets that have been idle long enough to be fully refilled anyway. */
function pruneBuckets(now: number): void {
  if (now - lastPrune < BUCKET_IDLE_MS) return;
  lastPrune = now;
  for (const [ip, b] of buckets) {
    if (now - b.last >= BUCKET_IDLE_MS) buckets.delete(ip);
  }
}

/** True iff this IP is under its rate limit; consumes one token when allowed. */
function underRateLimit(clientIp: string, now: number): boolean {
  pruneBuckets(now);
  let b = buckets.get(clientIp);
  if (!b) {
    b = { tokens: BUCKET_CAPACITY, last: now };
    buckets.set(clientIp, b);
  } else {
    const refill = (now - b.last) * REFILL_PER_MS;
    b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ---- retention --------------------------------------------------------------

let lastRetentionDay = "";

/**
 * Prune events older than 365 days, at most once per UTC day per process
 * (§4.8). Gated in memory and best-effort: the gate is claimed before the DELETE
 * so a DB error just skips this day rather than hammering a down database.
 */
async function maybePruneRetention(dayUtc: string): Promise<void> {
  if (lastRetentionDay === dayUtc) return;
  lastRetentionDay = dayUtc;
  try {
    await getDb().raw(
      `DELETE FROM analytics_events WHERE occurred_at < now() - interval '365 days'`
    );
  } catch {
    /* DB down / not migrated — swallow; retention is opportunistic. */
  }
}

// ---- ingest -----------------------------------------------------------------

export interface BeaconInput {
  /** The raw parsed JSON body (may be anything, including undefined). */
  body: unknown;
  /** First X-Forwarded-For entry when present, else the socket address. */
  clientIp: string;
  /** Raw user-agent header (hash input only — never stored or logged). */
  userAgent: string;
  /** The request `Origin` header, used only for same-origin referrer detection. */
  siteOrigin: string | undefined;
  secrets: IAppSecrets | undefined;
}

/**
 * Ingest one beacon. Returns silently on ANY drop condition (bot, rate limit,
 * invalid input, DB failure); the router always answers 204 regardless. Never
 * throws, never logs request contents.
 */
export async function ingestBeacon(input: BeaconInput): Promise<void> {
  try {
    const { body, clientIp, userAgent, siteOrigin, secrets } = input;

    // Bots first — they never fire interaction events; drop before doing work.
    if (BOT_UA.test(userAgent)) return;

    // Rate limit per client IP (before validation so a flood of garbage is cheap).
    if (!underRateLimit(clientIp, Date.now())) return;

    const parsed = parseBody(body, siteOrigin);
    if (!parsed) return;

    const daySalt = computeDaySalt(resolveEncryptionKey(secrets), utcDay());
    const sessionKey = computeSessionKey(daySalt, clientIp, userAgent);

    try {
      await getDb()("analytics_events").insert({
        session_key: sessionKey,
        event: parsed.event,
        path: parsed.path,
        referrer: parsed.referrer,
        meta: parsed.meta,
      });
    } catch {
      // DB down / not migrated — still a 204, and nothing about the request is
      // logged (§4.8). Skip retention below since the DB is evidently unhappy.
      return;
    }

    await maybePruneRetention(utcDay());
  } catch {
    // Absolute belt-and-braces: ingest must never throw (§4.8).
  }
}

/** Test-only: reset the in-memory rate-limit + retention gates. */
export function _resetAnalyticsStateForTests(): void {
  buckets.clear();
  lastPrune = 0;
  lastRetentionDay = "";
}
