/**
 * GitHub service — TECH_SPEC_V1.md §3.4/§3.5 (`github` live section) / task #580
 * (GitHub Explorer v1.10). Supersedes the v1.2 GraphQL-`viewer`-calendar proxy.
 *
 * WHY THE REWORK: the portfolio's contribution count MUST match Ben's public
 * GitHub profile. The GraphQL `viewer` query (an authenticated self-view)
 * counts PRIVATE contributions and no GraphQL argument can exclude them, so the
 * API reported ~3267 while github.com showed ~2870. GitHub's own profile page
 * renders its calendar from a PUBLIC, no-auth endpoint —
 * `https://github.com/users/<login>/contributions?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * (HTML) — which is public-only by definition, so its totals match the profile
 * exactly, and its from/to window makes the section browsable by year.
 *
 * The stored PAT (§4.7) is still used, but ONLY for the GraphQL `viewer` query
 * that resolves `login` (feeds the public URL) and `createdAt` (its year is the
 * lower bound of the year picker). That resolution is cached until the PAT
 * changes. The calendar HTML fetch is unauthenticated — the PAT NEVER rides it.
 *
 * SECURITY — the PAT is a real secret. It is sent only in the `Authorization`
 * header of the GraphQL request; it never appears in a URL (the public calendar
 * URL contains only the public login), in any response body, in an error, or in
 * a log line (only status codes / error messages are logged — the §4.6 Spotify
 * convention).
 *
 * DEGRADE — ANY upstream failure (no stored PAT, GraphQL error/timeout/`errors`
 * array, contributions HTTP error/timeout, or HTML shape drift) degrades to
 * `{ available: false }`, never a 5xx (§3.5). Only a SUCCESSFUL result is cached
 * (per window), so a transient failure retries rather than staying dark ~1h.
 */

/** GitHub GraphQL API endpoint — used ONCE (cached) to resolve login/createdAt. */
export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/**
 * Public per-user contributions endpoint GitHub's own profile renders from. It
 * is public-only (no PRIVATE contributions) and needs no auth, so totals match
 * github.com exactly. The login is public; the PAT never touches this URL.
 */
export const GITHUB_CONTRIBUTIONS_BASE = "https://github.com/users";

/** In-memory cache TTL (§3.5 "~1h") — applies to both meta and window caches. */
export const GITHUB_CACHE_TTL_MS = 60 * 60 * 1000;

/** Upstream fetch timeout — a hung GitHub must not hang the public endpoint. */
export const GITHUB_UPSTREAM_TIMEOUT_MS = 4_000;

/**
 * GitHub REQUIRES a User-Agent header on every request and rejects those
 * without one. We send a stable, identifying value.
 */
export const GITHUB_USER_AGENT =
  "portfolio-v6-api/1.0 (+https://benkile.com)";

/** The `service_tokens.service` key the stored GitHub PAT lives under (§4.7). */
export const GITHUB_SERVICE_KEY = "github";

/**
 * Resolve the viewer's public login and account-creation timestamp. `login`
 * feeds the public contributions URL; `createdAt`'s year bounds the year picker.
 * This is the ONLY authenticated (PAT-bearing) call, and it is cached.
 */
export const GITHUB_VIEWER_QUERY = `query {
  viewer {
    login
    createdAt
  }
}`;

/** A single day in the contribution calendar (§3.5 curated shape). */
export interface GithubDay {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** The day's contribution count. */
  count: number;
  /** Quantized intensity 0–4 (GitHub's `data-level`). */
  level: number;
}

/** Curated per-week shape — a week is its ordered daily cells, Sun → Sat. */
export interface GithubWeek {
  days: GithubDay[];
}

/** Curated /api/github payload (§3.5). Never contains the PAT. */
export type GithubResult =
  | { available: false }
  | {
      available: true;
      total: number;
      from: string;
      to: string;
      /** Every year account-creation → current, newest first (year picker). */
      years: number[];
      /** Weeks oldest → newest; days Sun → Sat. */
      weeks: GithubWeek[];
    };

const UNAVAILABLE: GithubResult = { available: false };

/** Resolved viewer meta — login for the URL, createdYear for the year picker. */
interface ViewerMeta {
  login: string;
  createdYear: number;
}

interface MetaCacheEntry {
  /** Which PAT this cached meta belongs to (invalidate on change). */
  pat: string;
  login: string;
  createdYear: number;
  expiresAt: number;
}

interface WindowCacheEntry {
  /** Which PAT this cached window belongs to (invalidate on change). */
  pat: string;
  result: GithubResult;
  expiresAt: number;
}

// Module-level state. The meta cache holds the PAT-keyed login/createdAt (one
// GraphQL call, reused across every window). The window cache holds one curated
// result per window ("default" or a specific year) with a single-flight guard
// each so a burst of concurrent cache-miss requests for the SAME window
// collapses to one upstream call. The PAT is held only in server memory here.
let metaCache: MetaCacheEntry | null = null;
let metaInFlight: Promise<ViewerMeta | null> | null = null;
const windowCache = new Map<string, WindowCacheEntry>();
const windowInFlight = new Map<string, Promise<GithubResult>>();

function timeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GITHUB_UPSTREAM_TIMEOUT_MS
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * If the PAT changed since anything was cached, drop every cached result — the
 * login/createdAt AND all window HTML belong to the previous credential.
 */
function invalidateIfPatChanged(pat: string): void {
  if (metaCache && metaCache.pat !== pat) {
    metaCache = null;
    windowCache.clear();
  }
}

/**
 * POST the viewer query with the PAT in the `Authorization` header. Returns the
 * parsed JSON body on a 200 (which may still carry a GraphQL `errors` array —
 * curation handles that), or `null` on ANY transport failure. Never throws, and
 * never lets the PAT reach a log line — only the status/error message is logged.
 */
async function fetchViewer(pat: string): Promise<unknown> {
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
      body: JSON.stringify({ query: GITHUB_VIEWER_QUERY }),
      signal,
    });
    if (!res.ok) {
      // Log the STATUS ONLY — never the body, which could echo the credential.
      throw new Error(`GitHub GraphQL returned status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.error(
      "[githubService] viewer fetch failed; serving { available: false }:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clear();
  }
}

/**
 * Curate a raw GraphQL `viewer` response into `{ login, createdYear }`.
 * Defensive: a GraphQL `errors` array (returned WITH a 200), a missing
 * `data`/`viewer`, a non-string/empty `login`, or an unparseable `createdAt`
 * all yield `null` (→ degrade).
 */
export function curateViewer(payload: unknown): ViewerMeta | null {
  if (payload == null || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;

  // GitHub returns partial/failed GraphQL results as `{ errors: [...] }` with a
  // 200 status — that is a failure, not a success.
  if (Array.isArray(rec.errors) && rec.errors.length > 0) return null;

  const data = rec.data;
  if (data == null || typeof data !== "object") return null;

  const viewer = (data as Record<string, unknown>).viewer;
  if (viewer == null || typeof viewer !== "object") return null;
  const v = viewer as Record<string, unknown>;

  const login = v.login;
  if (typeof login !== "string" || login.length === 0) return null;

  const createdAt = v.createdAt;
  if (typeof createdAt !== "string") return null;
  const createdYear = Number(createdAt.slice(0, 4));
  if (!Number.isInteger(createdYear) || createdYear < 2000 || createdYear > 3000) {
    return null;
  }

  return { login, createdYear };
}

/**
 * Resolve the viewer meta for `pat`, served from the ~1h cache with
 * single-flight. Cached until the PAT changes (§4.7 PAT-keyed convention).
 * Returns `null` on any failure — the caller degrades.
 */
async function resolveMeta(pat: string): Promise<ViewerMeta | null> {
  invalidateIfPatChanged(pat);

  const now = Date.now();
  if (metaCache && metaCache.pat === pat && metaCache.expiresAt > now) {
    return { login: metaCache.login, createdYear: metaCache.createdYear };
  }
  if (metaInFlight) return metaInFlight;

  metaInFlight = (async () => {
    const payload = await fetchViewer(pat);
    const meta = curateViewer(payload);
    if (meta) {
      metaCache = {
        pat,
        login: meta.login,
        createdYear: meta.createdYear,
        expiresAt: Date.now() + GITHUB_CACHE_TTL_MS,
      };
    }
    return meta;
  })();

  try {
    return await metaInFlight;
  } finally {
    metaInFlight = null;
  }
}

/**
 * Every year from the account-creation year to the current year, newest first —
 * this drives the client's year picker.
 */
function yearsList(createdYear: number, currentYear: number): number[] {
  const min = Math.min(createdYear, currentYear);
  const max = Math.max(createdYear, currentYear);
  const years: number[] = [];
  for (let y = max; y >= min; y--) years.push(y);
  return years;
}

/**
 * The from/to window passed to the public contributions URL. No year → the
 * DEFAULT view (the trailing 12 months ending today — the endpoint's own
 * default, so both bounds are omitted). A year → that calendar year, clamped to
 * today for the current (or a future-edge) year.
 */
function windowBounds(
  year: number | undefined,
  currentYear: number,
  now: Date
): { from?: string; to?: string } {
  if (year === undefined) return {};
  const from = `${year}-01-01`;
  const to =
    year >= currentYear ? now.toISOString().slice(0, 10) : `${year}-12-31`;
  return { from, to };
}

/**
 * GET the public contributions HTML for `login` within the optional from/to
 * window. Returns the HTML text on a 200, or `null` on ANY failure (non-2xx,
 * timeout, network error). NO PAT is sent — this endpoint is public; the URL
 * carries only the public login. Never throws.
 */
async function fetchContributionsHtml(
  login: string,
  from: string | undefined,
  to: string | undefined
): Promise<string | null> {
  const { signal, clear } = timeoutSignal();
  try {
    let url = `${GITHUB_CONTRIBUTIONS_BASE}/${encodeURIComponent(
      login
    )}/contributions`;
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    if (qs) url += `?${qs}`;

    const res = await fetch(url, {
      headers: {
        "user-agent": GITHUB_USER_AGENT,
        accept: "text/html",
        // GitHub serves the calendar fragment to XHR-style requests.
        "x-requested-with": "XMLHttpRequest",
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub contributions returned status ${res.status}`);
    }
    return await res.text();
  } catch (err) {
    console.error(
      "[githubService] contributions fetch failed; serving { available: false }:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clear();
  }
}

/**
 * A best-effort re-quantization of a raw count into GitHub's 0–4 intensity
 * scale, used ONLY when a cell's `data-level` is absent. GitHub itself quantizes
 * by per-user quartiles (not reproducible without the whole year), so this is a
 * fixed-threshold fallback; the structured `data-level` is always preferred.
 */
function quantize(count: number): number {
  if (count <= 0) return 0;
  if (count < 3) return 1;
  if (count < 6) return 2;
  if (count < 9) return 3;
  return 4;
}

/**
 * Parse a contribution count out of a tool-tip's text, which reads like
 * "10 contributions on ...", "1 contribution on ...", or "No contributions on
 * ...". Returns the count, or `null` if the text does not look like a count.
 */
function parseCountFromText(text: string): number | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (/\bNo\s+contributions?\b/i.test(t)) return 0;
  const m = /([\d,]+)\s+contributions?\b/i.exec(t);
  if (m) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Defensively parse the contributions HTML into a flat list of day cells. Reads
 * each `<td>` carrying a `data-date` (the day cells; label cells have none),
 * pulling the count from — in order of preference — a `data-count` attribute, a
 * matching `<tool-tip>` (linked by the cell's `id` = the tool-tip's `for`), or
 * defaulting to 0 ("No contributions" days often carry no explicit count). The
 * level comes from `data-level` when present, else is re-quantized from the
 * count. ANY shape drift that yields zero recognizable day cells returns `null`
 * (→ degrade); it NEVER throws.
 */
export function parseContributions(html: unknown): { days: GithubDay[] } | null {
  if (typeof html !== "string" || html.length === 0) return null;

  // Map each tool-tip's `for` target → its parsed count.
  const tipCounts = new Map<string, number>();
  const tipRe = /<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/gi;
  let tip: RegExpExecArray | null;
  while ((tip = tipRe.exec(html)) !== null) {
    const forM = /\bfor="([^"]*)"/.exec(tip[1]);
    if (!forM) continue;
    const count = parseCountFromText(tip[2]);
    if (count !== null) tipCounts.set(forM[1], count);
  }

  const days: GithubDay[] = [];
  const tdRe = /<td\b([^>]*)>/gi;
  let td: RegExpExecArray | null;
  while ((td = tdRe.exec(html)) !== null) {
    const attrs = td[1];

    const dateM = /\bdata-date="([^"]*)"/.exec(attrs);
    if (!dateM) continue; // a label cell, not a day cell
    const date = dateM[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    // Count: prefer the structured data-count, then the linked tool-tip, else 0.
    let count: number | null = null;
    const dataCountM = /\bdata-count="([^"]*)"/.exec(attrs);
    if (dataCountM) {
      const n = Number(dataCountM[1]);
      if (Number.isFinite(n)) count = n;
    }
    if (count === null) {
      const idM = /\bid="([^"]*)"/.exec(attrs);
      if (idM && tipCounts.has(idM[1])) count = tipCounts.get(idM[1]) ?? null;
    }
    if (count === null) count = 0;

    // Level: prefer data-level (0–4), else re-quantize from the count.
    let level: number | null = null;
    const levelM = /\bdata-level="([^"]*)"/.exec(attrs);
    if (levelM) {
      const l = Number(levelM[1]);
      if (Number.isInteger(l) && l >= 0 && l <= 4) level = l;
    }
    if (level === null) level = quantize(count);

    days.push({ date, count, level });
  }

  if (days.length === 0) return null;
  return { days };
}

/**
 * Group day cells (sorted ascending) into weeks that start on Sunday, so weeks
 * run oldest → newest and each week's days run Sun → Sat. The first and last
 * weeks may be partial (the window rarely starts on a Sunday / ends on a
 * Saturday), matching what GitHub renders.
 */
function groupIntoWeeks(sorted: GithubDay[]): GithubWeek[] {
  const weeks: GithubWeek[] = [];
  let current: GithubDay[] = [];
  for (const day of sorted) {
    const dow = new Date(`${day.date}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
    if (dow === 0 && current.length > 0) {
      weeks.push({ days: current });
      current = [];
    }
    current.push(day);
  }
  if (current.length > 0) weeks.push({ days: current });
  return weeks;
}

/**
 * Assemble the curated result from parsed day cells. `total` is the SUM of the
 * daily counts (so it matches the public profile exactly — never a header value
 * that might include private contributions); `from`/`to` are the actual data
 * bounds; `weeks` are Sunday-grouped; `years` is the picker range.
 */
export function buildGithubResult(
  days: GithubDay[],
  years: number[]
): GithubResult {
  if (days.length === 0) return UNAVAILABLE;
  const sorted = [...days].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const total = sorted.reduce((sum, d) => sum + d.count, 0);
  return {
    available: true,
    total,
    from: sorted[0].date,
    to: sorted[sorted.length - 1].date,
    years,
    weeks: groupIntoWeeks(sorted),
  };
}

/**
 * Resolve the year-picker list for `pat` (account-creation year → current year,
 * newest first), or `null` if the viewer meta cannot be resolved. The router
 * uses this to validate `?year=` against the account's real range.
 */
export async function resolveGithubYears(
  pat: string | null | undefined
): Promise<number[] | null> {
  if (!pat) return null;
  const meta = await resolveMeta(pat);
  if (!meta) return null;
  const currentYear = new Date().getUTCFullYear();
  return yearsList(meta.createdYear, currentYear);
}

/**
 * Get the curated GitHub contribution payload for `pat` and the requested
 * window — `year === undefined` is the default (trailing-12-months) view, a
 * number is that calendar year (assumed already range-validated by the router).
 * Served from the ~1h per-window cache with per-window single-flight. Always
 * resolves — never rejects — so `GET /api/github` never returns a 5xx (§3.5).
 * With no stored PAT, or if the viewer meta cannot be resolved, it returns
 * `{ available: false }` without an unnecessary contributions fetch.
 */
export async function getGithub(
  pat: string | null | undefined,
  year?: number
): Promise<GithubResult> {
  if (!pat) return UNAVAILABLE;

  const meta = await resolveMeta(pat);
  if (!meta) return UNAVAILABLE;

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const years = yearsList(meta.createdYear, currentYear);
  const windowKey = year === undefined ? "default" : String(year);

  const cached = windowCache.get(windowKey);
  if (cached && cached.pat === pat && cached.expiresAt > Date.now()) {
    return cached.result;
  }
  const existing = windowInFlight.get(windowKey);
  if (existing) return existing;

  const promise = (async () => {
    const { from, to } = windowBounds(year, currentYear, now);
    const html = await fetchContributionsHtml(meta.login, from, to);
    const parsed = parseContributions(html);
    if (!parsed) return UNAVAILABLE;
    const result = buildGithubResult(parsed.days, years);
    // Cache ONLY a successful result — a failure must not stick for an hour.
    if (result.available) {
      windowCache.set(windowKey, {
        pat,
        result,
        expiresAt: Date.now() + GITHUB_CACHE_TTL_MS,
      });
    }
    return result;
  })();
  windowInFlight.set(windowKey, promise);

  try {
    return await promise;
  } finally {
    windowInFlight.delete(windowKey);
  }
}

/** Test-only: clear every module cache and any in-flight fetch. */
export function _resetGithubCacheForTests(): void {
  metaCache = null;
  metaInFlight = null;
  windowCache.clear();
  windowInFlight.clear();
}
