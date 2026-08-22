import { createHash, randomBytes } from "crypto";
import { getDb } from "../db/db";
import { IAppSecrets } from "../interfaces";
import { resolveEncryptionKey } from "./serviceTokenStore";

/**
 * Analytics v1.4 — first-party, privacy-respecting ingest (TECH_SPEC_V1.md
 * §4.8). This service owns ALL of the ingest logic; the `/api/beacon` router is
 * a thin shell that extracts a few request fields and always answers 204.
 *
 * Load-bearing privacy + hardening properties (§4.8), enforced here:
 *   - No PII is ever stored OR logged. Raw client IP and user-agent are used
 *     ONLY as hash input for `session_key = sha256(day_salt | ip | ua)[:32]`.
 *     The salt derives from the token-encryption key material + the UTC date, so
 *     keys rotate DAILY and cross-day visitor tracking is impossible by
 *     construction. When no key material exists (dev), a random per-boot salt is
 *     used instead.
 *   - Referrers are reduced to their ORIGIN (scheme+host); same-origin or
 *     unparseable referrers store null.
 *   - Known bots (coarse UA match) are dropped at ingest.
 *   - Client IP is picked by TRUSTED hop count from `X-Forwarded-For` (see
 *     beaconRouter.ts): client-supplied leading entries cannot influence
 *     `session_key` or the per-IP rate limit (task #135).
 *   - Origin allowlist (`BEACON_ALLOWED_ORIGINS`, task #135): when set, a
 *     beacon whose `Origin` header is missing, unparseable, or not an exact
 *     match against the allowlist is silently dropped. When unset/empty (dev),
 *     every origin is accepted.
 *   - A light in-memory per-IP token bucket (~60 events/min) silently drops
 *     floods; stale buckets are pruned.
 *   - Events older than 365 days are pruned opportunistically (at most once per
 *     UTC day per process).
 *
 * ingestBeacon NEVER throws and NEVER logs request contents. Every failure —
 * invalid input, rate-limited, bot, disallowed Origin, DB down — resolves to a
 * silent no-op so the caller can unconditionally return 204 (§4.8: a broken
 * beacon must never affect a visitor, and probing it teaches nothing).
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
  /**
   * The raw parsed JSON body (may be anything, including undefined).
   */
  body: unknown;
  /**
   * Client IP picked by trusted-hop count from `X-Forwarded-For`, else the
   * socket address (see beaconRouter.clientIpOf). Never a client-supplied
   * XFF leading entry. Used as hash input for `session_key` and as the
   * per-IP rate-limit key; never stored, never logged.
   */
  clientIp: string;
  /** Raw user-agent header (hash input only — never stored or logged). */
  userAgent: string;
  /**
   * The request `Origin` header verbatim (or undefined when absent). Used
   * both for same-origin referrer detection AND for the Origin allowlist
   * check (§4.8, task #135).
   */
  siteOrigin: string | undefined;
  secrets: IAppSecrets | undefined;
}

/**
 * Parse `secrets.beacon_allowed_origins` into a set of exact-match origins.
 * Empty / unset means "no allowlist configured" — accept every origin (dev
 * behavior). Whitespace-only entries are skipped.
 */
function parseAllowedOrigins(
  secrets: IAppSecrets | undefined
): Set<string> | null {
  const raw = secrets?.beacon_allowed_origins;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return null;
  return new Set(entries);
}

/**
 * True when the beacon should be admitted for this request Origin (§4.8):
 * - allowlist null (unset/empty) → accept everything (dev).
 * - allowlist set → the request Origin must be present, parseable as a URL,
 *   and its origin must be an EXACT string match. A missing, malformed, or
 *   non-matching Origin fails the check and the beacon is silently dropped.
 */
function isOriginAllowed(
  origin: string | undefined,
  allowlist: Set<string> | null
): boolean {
  if (!allowlist) return true;
  if (typeof origin !== "string" || origin.length === 0) return false;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  if (!normalized || normalized === "null") return false;
  return allowlist.has(normalized);
}

/**
 * Ingest one beacon. Returns silently on ANY drop condition (bot, rate limit,
 * disallowed Origin, invalid input, DB failure); the router always answers 204
 * regardless. Never throws, never logs request contents.
 */
export async function ingestBeacon(input: BeaconInput): Promise<void> {
  try {
    const { body, clientIp, userAgent, siteOrigin, secrets } = input;

    // Bots first — they never fire interaction events; drop before doing work.
    if (BOT_UA.test(userAgent)) return;

    // Origin allowlist (§4.8, task #135). Checked BEFORE the rate-limit
    // bucket touch so a disallowed origin cannot fill up an IP's bucket.
    if (!isOriginAllowed(siteOrigin, parseAllowedOrigins(secrets))) return;

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

// ---- aggregates (read half, §4.8) -------------------------------------------

/**
 * The admin analytics summary shape (§4.8). Every count is a plain number; the
 * raw pg `bigint`/`count` strings are coerced here so the router just wraps this
 * in the §4.3 envelope.
 */
export interface AnalyticsSummary {
  days: number;
  totals: { pageviews: number; visitors: number; engaged: number };
  daily: { date: string; pageviews: number; visitors: number }[];
  top_pages: { path: string; views: number }[];
  top_referrers: { origin: string; count: number }[];
  events: { event: string; count: number }[];
  top_outbound: { href: string; count: number }[];
}

/** Allowed lookback windows (§4.8). Anything else falls back to 30. */
const ALLOWED_DAYS = new Set([7, 30, 90]);
const DEFAULT_DAYS = 30;

/**
 * Parse the `?days=` query param (§4.8): only 7 | 30 | 90 are honored; every
 * other value — missing, non-numeric, out of the set — degrades to 30 rather
 * than erroring.
 */
export function parseDays(raw: unknown): number {
  const value =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return ALLOWED_DAYS.has(value) ? value : DEFAULT_DAYS;
}

/** COUNT()/bigint columns arrive from pg as strings — coerce to a number. */
function toNum(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * Compute the curated admin analytics summary over `occurred_at >= now() - days`
 * (§4.8). All aggregation happens in Postgres via grouped queries — rows are
 * NEVER loaded into JS — and the six independent queries run concurrently.
 *
 * `days` is expected to already be one of the allowlisted windows (see
 * `parseDays`); it is bound as an integer either way, so it is never string
 * interpolation. UTC-day bucketing for `daily` is explicit (`AT TIME ZONE
 * 'UTC'`) so day boundaries do not drift with the server/session timezone, and
 * `date` is formatted to `YYYY-MM-DD` text in SQL rather than relying on the pg
 * `date`-type parser.
 */
export async function getAnalyticsSummary(
  days: number
): Promise<AnalyticsSummary> {
  const db = getDb();
  // Shared trailing window. `make_interval(days => ?)` keeps `days` a bound
  // integer, never interpolated SQL.
  const since = db.raw("now() - make_interval(days => ?)", [days]);

  const [totalsRows, dailyRows, pagesRows, referrersRows, eventRows, outRows] =
    await Promise.all([
      db.raw(
        `SELECT
           count(*) FILTER (WHERE event = 'pageview')            AS pageviews,
           count(DISTINCT session_key)                            AS visitors,
           count(DISTINCT session_key) FILTER
             (WHERE event <> 'pageview')                          AS engaged
         FROM analytics_events
         WHERE occurred_at >= ?`,
        [since]
      ),
      db.raw(
        `SELECT
           to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'),
                   'YYYY-MM-DD')                                  AS date,
           count(*) FILTER (WHERE event = 'pageview')            AS pageviews,
           count(DISTINCT session_key)                            AS visitors
         FROM analytics_events
         WHERE occurred_at >= ?
         GROUP BY 1
         ORDER BY 1 ASC`,
        [since]
      ),
      db.raw(
        `SELECT path, count(*) AS views
         FROM analytics_events
         WHERE occurred_at >= ? AND event = 'pageview'
         GROUP BY path
         ORDER BY views DESC, path ASC
         LIMIT 10`,
        [since]
      ),
      db.raw(
        `SELECT referrer AS origin, count(*) AS count
         FROM analytics_events
         WHERE occurred_at >= ? AND referrer IS NOT NULL
         GROUP BY referrer
         ORDER BY count DESC, referrer ASC
         LIMIT 10`,
        [since]
      ),
      db.raw(
        `SELECT event, count(*) AS count
         FROM analytics_events
         WHERE occurred_at >= ? AND event <> 'pageview'
         GROUP BY event
         ORDER BY count DESC, event ASC`,
        [since]
      ),
      db.raw(
        `SELECT meta->>'href' AS href, count(*) AS count
         FROM analytics_events
         WHERE occurred_at >= ?
           AND event = 'link_out'
           AND meta->>'href' IS NOT NULL
         GROUP BY meta->>'href'
         ORDER BY count DESC, href ASC
         LIMIT 10`,
        [since]
      ),
    ]);

  const totals = totalsRows.rows[0] ?? {};

  return {
    days,
    totals: {
      pageviews: toNum(totals.pageviews),
      visitors: toNum(totals.visitors),
      engaged: toNum(totals.engaged),
    },
    daily: dailyRows.rows.map(
      (r: { date: string; pageviews: unknown; visitors: unknown }) => ({
        date: r.date,
        pageviews: toNum(r.pageviews),
        visitors: toNum(r.visitors),
      })
    ),
    top_pages: pagesRows.rows.map((r: { path: string; views: unknown }) => ({
      path: r.path,
      views: toNum(r.views),
    })),
    top_referrers: referrersRows.rows.map(
      (r: { origin: string; count: unknown }) => ({
        origin: r.origin,
        count: toNum(r.count),
      })
    ),
    events: eventRows.rows.map((r: { event: string; count: unknown }) => ({
      event: r.event,
      count: toNum(r.count),
    })),
    top_outbound: outRows.rows.map((r: { href: string; count: unknown }) => ({
      href: r.href,
      count: toNum(r.count),
    })),
  };
}
