/**
 * Duolingo service — TECH_SPEC_V1.md §3.4/§3.5 (`duolingo` live section, v1.2) /
 * task #484. Mirrors the §4.6 Spotify proxy pattern.
 *
 * The `duolingo` live section shows the owner's streak and per-course progress.
 * Duolingo has no official public API; the API proxies the UNOFFICIAL
 * `https://www.duolingo.com/2017-06-30/users?username=<username>` endpoint
 * server-side for the same reasons the other live sections proxy their upstream
 * (§3.5): the exposed shape is a deliberate curated choice, and a ~1h in-memory
 * cache means visitor traffic never multiplies upstream calls.
 *
 * The stored username is public data (not a secret), but it is still never
 * echoed in a response — only the curated shape below is returned.
 *
 * Runtime flow:
 *   - The RAW upstream payload is cached in memory ~1h with single-flight, so a
 *     burst of concurrent cache-miss requests collapses to one upstream call.
 *   - Each request curates from the cached payload, selecting the course whose
 *     `learningLanguage` matches the requested `language` (default `es`), so
 *     different sections/visitors can ask for different courses off one cache.
 *   - ANY failure — no stored username, upstream error/timeout, shape drift
 *     (missing `users[0]`/`streak`/`courses`), unknown language — degrades to
 *     `{ available: false }`, never a 5xx (§3.5). The endpoint is UNOFFICIAL;
 *     every field is treated as possibly-absent.
 */

import { LANGUAGE_CODE_REGEX } from "../schemas/sections";

/** Unofficial Duolingo users endpoint (§3.5, v1.2). */
export const DUOLINGO_USERS_URL =
  "https://www.duolingo.com/2017-06-30/users";

/** In-memory upstream-payload cache TTL (§3.5 "~1h"). */
export const DUOLINGO_CACHE_TTL_MS = 60 * 60 * 1000;

/** Upstream fetch timeout — a hung Duolingo must not hang the public endpoint. */
export const DUOLINGO_UPSTREAM_TIMEOUT_MS = 4_000;

/**
 * A browser-ish User-Agent. The unofficial endpoint returns 403 to obviously
 * scripted clients, so we present a normal-looking one.
 */
export const DUOLINGO_USER_AGENT =
  "Mozilla/5.0 (compatible; portfolio-v6-api/1.0; +https://benkile.com)";

/** Default course code when the request omits (or malforms) `?language=`. */
export const DEFAULT_LANGUAGE = "es";

/** The `service_tokens.service` key the stored Duolingo username lives under. */
export const DUOLINGO_SERVICE_KEY = "duolingo";

/** Curated per-course shape (§3.5) — deliberately NOT Duolingo's raw payload. */
export interface DuolingoCourse {
  title: string;
  xp: number;
  crowns: number;
}

/** Curated /api/duolingo payload (§3.5). Never contains the username. */
export type DuolingoResult =
  | { available: false }
  | { available: true; streak: number; course: DuolingoCourse };

const UNAVAILABLE: DuolingoResult = { available: false };

interface CacheEntry {
  /** Which username this cached payload belongs to (invalidate on change). */
  username: string;
  /** The raw upstream JSON body, kept verbatim for per-request curation. */
  payload: unknown;
  expiresAt: number;
}

// Module-level state: the ~1h raw-payload cache and a single-flight guard so a
// burst of concurrent cache-miss requests collapses to one upstream call (§3.5).
let cache: CacheEntry | null = null;
let inFlight: Promise<unknown> | null = null;

function timeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DUOLINGO_UPSTREAM_TIMEOUT_MS
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Resolve the effective course code from a raw `?language=` query value:
 * a string matching the shared lowercase course-code regex is honored, anything
 * else (absent, wrong type, malformed) falls back to the default `es`. This is
 * the "validated against the same regex, default 'es'" rule (§3.5).
 */
export function resolveLanguage(raw: unknown): string {
  if (typeof raw === "string" && LANGUAGE_CODE_REGEX.test(raw)) {
    return raw;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Fetch the raw upstream user payload for `username`. Returns the parsed body on
 * a 200, or `null` on ANY failure (non-2xx, timeout, network error, unparseable
 * body) — the caller degrades to `{ available: false }`. Never throws.
 */
async function fetchUpstream(username: string): Promise<unknown> {
  const { signal, clear } = timeoutSignal();
  try {
    const url = `${DUOLINGO_USERS_URL}?username=${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      headers: {
        "user-agent": DUOLINGO_USER_AGENT,
        accept: "application/json",
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Duolingo users returned status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    // The username is public, so it is safe to omit here regardless — we log the
    // message only, never the payload, keeping logs free of any stored value.
    console.error(
      "[duolingoService] upstream fetch failed; serving { available: false }:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clear();
  }
}

/**
 * Get the raw upstream payload from the ~1h cache, fetching on a miss with
 * single-flight (concurrent misses share one fetch). Only a successful payload
 * is cached — a failure returns `null` without poisoning the ~1h window, so the
 * next request retries rather than staying dark for an hour.
 */
async function getUpstreamPayload(username: string): Promise<unknown> {
  const now = Date.now();
  if (cache && cache.username === username && cache.expiresAt > now) {
    return cache.payload;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const payload = await fetchUpstream(username);
    if (payload != null) {
      cache = {
        username,
        payload,
        expiresAt: Date.now() + DUOLINGO_CACHE_TTL_MS,
      };
    }
    return payload;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Curate a raw upstream payload into the public shape (§3.5), selecting the
 * course whose `learningLanguage` equals `language`. Defensive about every
 * field — a missing `users[0]`, a non-numeric `streak`, an absent `courses`
 * array, or no course for the requested language all degrade to unavailable.
 */
export function curateDuolingo(
  payload: unknown,
  language: string
): DuolingoResult {
  if (payload == null || typeof payload !== "object") return UNAVAILABLE;

  const users = (payload as Record<string, unknown>).users;
  if (!Array.isArray(users) || users.length === 0) return UNAVAILABLE;

  const user = users[0];
  if (user == null || typeof user !== "object") return UNAVAILABLE;
  const rec = user as Record<string, unknown>;

  const streak = rec.streak;
  if (typeof streak !== "number") return UNAVAILABLE;

  const courses = rec.courses;
  if (!Array.isArray(courses)) return UNAVAILABLE;

  const match = courses.find(
    (c) =>
      c != null &&
      typeof c === "object" &&
      (c as Record<string, unknown>).learningLanguage === language
  ) as Record<string, unknown> | undefined;
  if (!match) return UNAVAILABLE;

  const course: DuolingoCourse = {
    title: typeof match.title === "string" ? match.title : "",
    xp: typeof match.xp === "number" ? match.xp : 0,
    crowns: typeof match.crowns === "number" ? match.crowns : 0,
  };
  return { available: true, streak, course };
}

/**
 * Get the curated Duolingo payload for `username`, served from the ~1h cache and
 * filtered to the given (already-resolved) `language`. Always resolves — never
 * rejects — so `GET /api/duolingo` never returns a 5xx (§3.5). With no stored
 * username there is nothing to fetch: it returns `{ available: false }` and
 * makes no upstream call.
 */
export async function getDuolingo(
  username: string | null | undefined,
  language: string
): Promise<DuolingoResult> {
  if (!username) return UNAVAILABLE;
  const payload = await getUpstreamPayload(username);
  return curateDuolingo(payload, language);
}

/** Test-only: clear the module cache and any in-flight fetch. */
export function _resetDuolingoCacheForTests(): void {
  cache = null;
  inFlight = null;
}
