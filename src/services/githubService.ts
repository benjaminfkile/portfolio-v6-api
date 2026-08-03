/**
 * GitHub service — TECH_SPEC_V1.md §3.4/§3.5 (`github` live section, v1.2) /
 * task #485. Mirrors the §4.6 Spotify proxy pattern and the sibling §4.7
 * Duolingo proxy (`duolingoService.ts`).
 *
 * The `github` live section renders the owner's contribution graph. The API
 * proxies GitHub's GraphQL API server-side for the same reasons the other live
 * sections proxy their upstream (§3.5): the stored personal access token (PAT)
 * stays server-side and is NEVER exposed, the returned shape is a deliberate
 * curated choice, and a ~1h in-memory cache means visitor traffic never
 * multiplies upstream calls (protecting GitHub's rate limit).
 *
 * SECURITY — the PAT is a real secret. It is sent only in the `Authorization`
 * header of the upstream request; it never appears in the URL, in any response
 * body, in an error, or in a log line (only status codes are logged — the
 * spotifyService convention, §4.6).
 *
 * Runtime flow:
 *   - The curated result is cached in memory ~1h with single-flight, so a burst
 *     of concurrent cache-miss requests collapses to one upstream call. Only a
 *     SUCCESSFUL (`available: true`) result is cached — any failure returns
 *     `{ available: false }` without poisoning the ~1h window, so the next
 *     request retries rather than staying dark for an hour.
 *   - ANY failure — no stored PAT, HTTP error/timeout, a GraphQL `errors` array
 *     (which GitHub returns with a 200), or shape drift — degrades to
 *     `{ available: false }`, never a 5xx (§3.5).
 */

/** GitHub GraphQL API endpoint (§3.5, v1.2). */
export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/** In-memory curated-result cache TTL (§3.5 "~1h"). */
export const GITHUB_CACHE_TTL_MS = 60 * 60 * 1000;

/** Upstream fetch timeout — a hung GitHub must not hang the public endpoint. */
export const GITHUB_UPSTREAM_TIMEOUT_MS = 4_000;

/**
 * GitHub REQUIRES a User-Agent header on every request and rejects those
 * without one (§ task #485). We send a stable, identifying value.
 */
export const GITHUB_USER_AGENT =
  "portfolio-v6-api/1.0 (+https://benkile.com)";

/** The `service_tokens.service` key the stored GitHub PAT lives under (§4.7). */
export const GITHUB_SERVICE_KEY = "github";

/**
 * The contribution-calendar GraphQL query (§3.4). `viewer` resolves to the PAT's
 * own account, so no username is needed. GitHub returns the calendar oldest →
 * newest already.
 */
export const GITHUB_CONTRIBUTIONS_QUERY = `query {
  viewer {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
          }
        }
      }
    }
  }
}`;

/** Curated per-week shape (§3.5) — a week is its ordered daily counts. */
export interface GithubWeek {
  /** Daily contribution counts, oldest → newest (up to 7). */
  days: number[];
}

/** Curated /api/github payload (§3.5). Never contains the PAT. */
export type GithubResult =
  | { available: false }
  | { available: true; total: number; weeks: GithubWeek[] };

const UNAVAILABLE: GithubResult = { available: false };

interface CacheEntry {
  /** Which PAT this cached result belongs to (invalidate on change). */
  pat: string;
  /** The curated, ready-to-serve payload (only successful results are cached). */
  result: GithubResult;
  expiresAt: number;
}

// Module-level state: the ~1h curated-result cache and a single-flight guard so
// a burst of concurrent cache-miss requests collapses to one upstream call
// (§3.5). The PAT is held only in server memory here, never emitted anywhere.
let cache: CacheEntry | null = null;
let inFlight: Promise<GithubResult> | null = null;

function timeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GITHUB_UPSTREAM_TIMEOUT_MS
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * POST the contribution-calendar query with the PAT in the `Authorization`
 * header. Returns the parsed JSON body on a 200 (which may still carry a GraphQL
 * `errors` array — curation handles that), or `null` on ANY transport failure
 * (non-2xx, timeout, network error, unparseable body). Never throws, and never
 * lets the PAT reach a log line — only the status code is logged.
 */
async function fetchUpstream(pat: string): Promise<unknown> {
  const { signal, clear } = timeoutSignal();
  try {
    const res = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        // The ONLY place the PAT appears — the upstream auth header.
        authorization: `bearer ${pat}`,
        "user-agent": GITHUB_USER_AGENT,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query: GITHUB_CONTRIBUTIONS_QUERY }),
      signal,
    });
    if (!res.ok) {
      // Log the STATUS ONLY — never the body, which could echo the credential.
      throw new Error(`GitHub GraphQL returned status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    // The message here is a status code or a network error string — never the
    // PAT (which lives only in the request header, not the URL or the error).
    console.error(
      "[githubService] upstream fetch failed; serving { available: false }:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clear();
  }
}

/**
 * Curate a raw GraphQL response into the public shape (§3.5). Defensive about
 * every level of the payload — a GraphQL `errors` array (returned WITH a 200),
 * a missing `data`/`viewer`/`contributionsCollection`/`contributionCalendar`, a
 * non-numeric `totalContributions`, or a non-array `weeks`/`contributionDays`
 * all degrade to `{ available: false }`. A missing/non-numeric daily count
 * within an otherwise-valid week defaults to 0.
 */
export function curateGithub(payload: unknown): GithubResult {
  if (payload == null || typeof payload !== "object") return UNAVAILABLE;
  const rec = payload as Record<string, unknown>;

  // GitHub returns partial/failed GraphQL results as `{ errors: [...] }` with a
  // 200 status — that is a failure, not a success (§ task #485).
  if (Array.isArray(rec.errors) && rec.errors.length > 0) return UNAVAILABLE;

  const data = rec.data;
  if (data == null || typeof data !== "object") return UNAVAILABLE;

  const viewer = (data as Record<string, unknown>).viewer;
  if (viewer == null || typeof viewer !== "object") return UNAVAILABLE;

  const collection = (viewer as Record<string, unknown>)
    .contributionsCollection;
  if (collection == null || typeof collection !== "object") return UNAVAILABLE;

  const calendar = (collection as Record<string, unknown>)
    .contributionCalendar;
  if (calendar == null || typeof calendar !== "object") return UNAVAILABLE;
  const cal = calendar as Record<string, unknown>;

  const total = cal.totalContributions;
  if (typeof total !== "number") return UNAVAILABLE;

  const weeksRaw = cal.weeks;
  if (!Array.isArray(weeksRaw)) return UNAVAILABLE;

  const weeks: GithubWeek[] = [];
  for (const week of weeksRaw) {
    if (week == null || typeof week !== "object") return UNAVAILABLE;
    const daysRaw = (week as Record<string, unknown>).contributionDays;
    if (!Array.isArray(daysRaw)) return UNAVAILABLE;
    const days = daysRaw.map((day) => {
      const count =
        day != null && typeof day === "object"
          ? (day as Record<string, unknown>).contributionCount
          : undefined;
      return typeof count === "number" ? count : 0;
    });
    weeks.push({ days });
  }

  return { available: true, total, weeks };
}

/**
 * Get the curated GitHub contribution payload for `pat`, served from the ~1h
 * cache with single-flight. Always resolves — never rejects — so `GET
 * /api/github` never returns a 5xx (§3.5). With no stored PAT there is nothing
 * to fetch: it returns `{ available: false }` and makes no upstream call.
 */
export async function getGithub(
  pat: string | null | undefined
): Promise<GithubResult> {
  if (!pat) return UNAVAILABLE;

  const now = Date.now();
  if (cache && cache.pat === pat && cache.expiresAt > now) {
    return cache.result;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const payload = await fetchUpstream(pat);
    const result = curateGithub(payload);
    // Cache ONLY a successful result — a failure must not stick for an hour.
    if (result.available) {
      cache = { pat, result, expiresAt: Date.now() + GITHUB_CACHE_TTL_MS };
    }
    return result;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Test-only: clear the module cache and any in-flight fetch. */
export function _resetGithubCacheForTests(): void {
  cache = null;
  inFlight = null;
}
