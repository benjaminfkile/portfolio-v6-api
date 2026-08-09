import fs from "fs";
import path from "path";
import request from "supertest";

/**
 * /api/github tests — TECH_SPEC_V1.md §3.4/§3.5/§4.1 (v1.10 GitHub Explorer) /
 * task #580.
 *
 * ALL upstream HTTP is mocked (global `fetch`); the credential store is mocked so
 * no DB is touched. Two upstreams are exercised: the GraphQL `viewer` query
 * (PAT-authenticated, cached, resolves login/createdAt) and the PUBLIC
 * contributions HTML endpoint (no auth, per-window). Covered: HTML parsing off a
 * realistic fixture (total = day-count sum, level parsing, "No contributions",
 * data-count preference, requantize), week grouping, viewer curation + years
 * derivation, the default + explicit-year windows, per-window caching +
 * single-flight, every degrade case → `{ available: false }`, `?year=`
 * validation (400s), the `github` section schema (weeks removed), and that the
 * PAT appears NOWHERE in a URL, log, or response.
 */

// The store is mocked so the router resolves a PAT without a database. Keep
// every other export real (resolveEncryptionKey etc.) via requireActual.
jest.mock("../src/services/serviceTokenStore", () => {
  const actual = jest.requireActual("../src/services/serviceTokenStore");
  return { ...actual, getStoredServiceToken: jest.fn() };
});

import app from "../src/app";
import { getStoredServiceToken } from "../src/services/serviceTokenStore";
import {
  getGithub,
  resolveGithubYears,
  parseContributions,
  buildGithubResult,
  curateViewer,
  _resetGithubCacheForTests,
  GITHUB_GRAPHQL_URL,
  GITHUB_CACHE_TTL_MS,
  GithubDay,
} from "../src/services/githubService";
import { githubData, SECTION_DATA_SCHEMAS, SECTION_TYPES } from "../src/schemas";

const mockStore = getStoredServiceToken as jest.Mock;
const mockFetch = jest.fn();

// A secret-looking PAT that must never surface in a response, a URL, or a log.
const PAT = "ghp_SECRET-personal-access-token-xxxxxxxxxxxx";
const LOGIN = "benkile";
const CREATED_YEAR = 2019;
const CURRENT_YEAR = new Date().getUTCFullYear();

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "github-contributions.html"),
  "utf8"
);

/** The 14 fixture days sum to 50 contributions across two full Sun→Sat weeks. */
const FIXTURE_TOTAL = 50;

/** A well-shaped `viewer` GraphQL body: public login + account creation date. */
function viewerPayload(login = LOGIN, createdAt = `${CREATED_YEAR}-03-15T08:00:00Z`) {
  return { data: { viewer: { login, createdAt } } };
}

function graphqlResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function htmlResponse(html: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => html,
  } as unknown as Response;
}

/** Wire the mock so GraphQL returns the viewer and everything else the HTML. */
function wireUpstream(html = FIXTURE, viewer: unknown = viewerPayload()): void {
  mockFetch.mockImplementation(async (url: unknown) =>
    String(url) === GITHUB_GRAPHQL_URL
      ? graphqlResponse(viewer)
      : htmlResponse(html)
  );
}

const graphqlCalls = () =>
  mockFetch.mock.calls.filter(([u]) => String(u) === GITHUB_GRAPHQL_URL);
const contributionsCalls = () =>
  mockFetch.mock.calls.filter(([u]) => String(u).includes("/contributions"));

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  mockStore.mockReset();
  _resetGithubCacheForTests();
});

describe("parseContributions (§3.5 defensive HTML parse)", () => {
  it("parses the fixture into 14 day cells with correct dates/counts/levels", () => {
    const parsed = parseContributions(FIXTURE);
    expect(parsed).not.toBeNull();
    const days = parsed!.days;
    expect(days).toHaveLength(14);

    // The total equals the SUM of the parsed day counts (matches the profile).
    const total = days.reduce((s, d) => s + d.count, 0);
    expect(total).toBe(FIXTURE_TOTAL);

    const byDate = new Map(days.map((d) => [d.date, d]));
    // A "No contributions" tool-tip → 0; a "1 contribution" (singular) → 1.
    expect(byDate.get("2023-12-31")).toEqual({
      date: "2023-12-31",
      count: 0,
      level: 0,
    });
    expect(byDate.get("2024-01-03")).toEqual({
      date: "2024-01-03",
      count: 1,
      level: 1,
    });
    // A double-digit count from a tool-tip, plus its parsed data-level.
    expect(byDate.get("2024-01-02")).toEqual({
      date: "2024-01-02",
      count: 12,
      level: 4,
    });
  });

  it("prefers a structured data-count over the tool-tip text", () => {
    const html = `
      <td class="ContributionCalendar-day" data-date="2024-02-01" data-count="8" data-level="3" id="c1"></td>
      <tool-tip for="c1">2 contributions on Thursday, February 1, 2024.</tool-tip>`;
    const parsed = parseContributions(html);
    expect(parsed!.days).toEqual([
      { date: "2024-02-01", count: 8, level: 3 },
    ]);
  });

  it("re-quantizes the level from the count when data-level is absent", () => {
    const html = `
      <td class="ContributionCalendar-day" data-date="2024-02-02" id="c2"></td>
      <tool-tip for="c2">5 contributions on Friday, February 2, 2024.</tool-tip>`;
    const parsed = parseContributions(html);
    // quantize(5) → 2 (0:0, <3:1, <6:2, <9:3, else 4).
    expect(parsed!.days).toEqual([{ date: "2024-02-02", count: 5, level: 2 }]);
  });

  it("parses comma-grouped thousands from a tool-tip", () => {
    const html = `
      <td class="ContributionCalendar-day" data-date="2024-02-03" id="c3"></td>
      <tool-tip for="c3">1,234 contributions on Saturday, February 3, 2024.</tool-tip>`;
    expect(parseContributions(html)!.days[0].count).toBe(1234);
  });

  it("defaults a day cell with no count source to 0", () => {
    const html = `<td class="ContributionCalendar-day" data-date="2024-02-04" data-level="0"></td>`;
    expect(parseContributions(html)!.days).toEqual([
      { date: "2024-02-04", count: 0, level: 0 },
    ]);
  });

  it("ignores label cells (no data-date) and malformed dates", () => {
    const html = `
      <td class="ContributionCalendar-label"><span>Mon</span></td>
      <td class="ContributionCalendar-day" data-date="not-a-date" data-level="1"></td>
      <td class="ContributionCalendar-day" data-date="2024-02-05" data-level="1" id="ok"></td>
      <tool-tip for="ok">1 contribution on Monday, February 5, 2024.</tool-tip>`;
    expect(parseContributions(html)!.days).toEqual([
      { date: "2024-02-05", count: 1, level: 1 },
    ]);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["empty string", ""],
    ["a page with no day cells", "<html><body>Not Found</body></html>"],
  ])("returns null on shape drift: %s", (_label, input) => {
    expect(parseContributions(input)).toBeNull();
  });
});

describe("buildGithubResult (§3.5 assembly)", () => {
  const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1];

  it("sums the total, derives from/to bounds, and groups Sun→Sat weeks", () => {
    // Deliberately out of order to prove sorting; a partial first + last week.
    const days: GithubDay[] = [
      { date: "2024-01-06", count: 2, level: 1 }, // Sat (week 1)
      { date: "2024-01-03", count: 1, level: 1 }, // Wed (week 1)
      { date: "2024-01-07", count: 4, level: 2 }, // Sun (week 2)
      { date: "2024-01-04", count: 0, level: 0 }, // Thu (week 1)
      { date: "2024-01-09", count: 3, level: 2 }, // Tue (week 2)
      { date: "2024-01-05", count: 5, level: 2 }, // Fri (week 1)
      { date: "2024-01-08", count: 0, level: 0 }, // Mon (week 2)
    ];
    const result = buildGithubResult(days, YEARS);
    expect(result.available).toBe(true);
    if (!result.available) return;

    expect(result.total).toBe(15);
    expect(result.from).toBe("2024-01-03");
    expect(result.to).toBe("2024-01-09");
    expect(result.years).toEqual(YEARS);

    // First week is a partial Wed→Sat; the second week starts on the Sunday.
    expect(result.weeks).toHaveLength(2);
    expect(result.weeks[0].days.map((d) => d.date)).toEqual([
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
      "2024-01-06",
    ]);
    expect(result.weeks[1].days.map((d) => d.date)).toEqual([
      "2024-01-07",
      "2024-01-08",
      "2024-01-09",
    ]);
  });

  it("degrades on an empty day list", () => {
    expect(buildGithubResult([], YEARS)).toEqual({ available: false });
  });
});

describe("curateViewer (§3.5 login/createdAt resolution)", () => {
  it("extracts the public login and creation year", () => {
    expect(curateViewer(viewerPayload("octocat", "2011-01-25T18:44:36Z"))).toEqual({
      login: "octocat",
      createdYear: 2011,
    });
  });

  it.each([
    ["null", null],
    ["a GraphQL errors array with 200", { errors: [{ message: "Bad credentials" }] }],
    ["missing data", { foo: 1 }],
    ["missing viewer", { data: {} }],
    ["empty login", { data: { viewer: { login: "", createdAt: "2019-01-01T00:00:00Z" } } }],
    ["non-string login", { data: { viewer: { login: 5, createdAt: "2019-01-01T00:00:00Z" } } }],
    ["missing createdAt", { data: { viewer: { login: "x" } } }],
    ["unparseable createdAt", { data: { viewer: { login: "x", createdAt: "nope" } } }],
  ])("returns null on %s", (_label, payload) => {
    expect(curateViewer(payload)).toBeNull();
  });
});

describe("getGithub (§3.5)", () => {
  it("resolves the default window: viewer via GraphQL, calendar via public HTML", async () => {
    wireUpstream();
    const result = await getGithub(PAT);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.total).toBe(FIXTURE_TOTAL);
    expect(result.from).toBe("2023-12-31");
    expect(result.to).toBe("2024-01-13");
    expect(result.weeks).toHaveLength(2);
    expect(result.weeks[0].days).toHaveLength(7);
    // years: creation year → current year, newest first.
    expect(result.years[0]).toBe(CURRENT_YEAR);
    expect(result.years[result.years.length - 1]).toBe(CREATED_YEAR);
  });

  it("sends the PAT ONLY in the GraphQL auth header — never in a URL or the result", async () => {
    wireUpstream();
    const result = await getGithub(PAT);

    const [gqlUrl, gqlInit] = graphqlCalls()[0];
    expect(String(gqlUrl)).toBe(GITHUB_GRAPHQL_URL);
    expect(gqlInit.method).toBe("POST");
    expect((gqlInit.headers as Record<string, string>).authorization).toBe(
      `bearer ${PAT}`
    );

    // The public contributions URL carries only the public login — no PAT, no
    // auth header.
    const [htmlUrl, htmlInit] = contributionsCalls()[0];
    expect(String(htmlUrl)).toContain(`/users/${LOGIN}/contributions`);
    expect(String(htmlUrl)).not.toContain(PAT);
    expect((htmlInit.headers as Record<string, string>).authorization).toBeUndefined();

    expect(JSON.stringify(result)).not.toContain(PAT);
  });

  it("passes from/to for an explicit past year", async () => {
    wireUpstream();
    await getGithub(PAT, 2023);
    const [url] = contributionsCalls()[0];
    expect(String(url)).toContain("from=2023-01-01");
    expect(String(url)).toContain("to=2023-12-31");
  });

  it("clamps the current year's window to today", async () => {
    wireUpstream();
    await getGithub(PAT, CURRENT_YEAR);
    const today = new Date().toISOString().slice(0, 10);
    const [url] = contributionsCalls()[0];
    expect(String(url)).toContain(`from=${CURRENT_YEAR}-01-01`);
    expect(String(url)).toContain(`to=${today}`);
  });

  it("sends NO from/to for the default window", async () => {
    wireUpstream();
    await getGithub(PAT);
    const [url] = contributionsCalls()[0];
    expect(String(url)).not.toContain("from=");
    expect(String(url)).not.toContain("to=");
  });

  it("caches per window: one GraphQL + one HTML per distinct window", async () => {
    wireUpstream();

    await getGithub(PAT); // default
    await getGithub(PAT); // default again → both caches hit
    expect(graphqlCalls()).toHaveLength(1);
    expect(contributionsCalls()).toHaveLength(1);

    await getGithub(PAT, 2022); // a new window → new HTML fetch, meta reused
    expect(graphqlCalls()).toHaveLength(1);
    expect(contributionsCalls()).toHaveLength(2);

    await getGithub(PAT, 2022); // that window now cached too
    expect(contributionsCalls()).toHaveLength(2);
  });

  it("re-fetches a window after the ~1h TTL elapses", async () => {
    jest.useFakeTimers();
    try {
      wireUpstream();
      await getGithub(PAT);
      expect(contributionsCalls()).toHaveLength(1);

      jest.advanceTimersByTime(GITHUB_CACHE_TTL_MS + 1_000);
      await getGithub(PAT);
      expect(contributionsCalls()).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("collapses a burst of concurrent same-window misses to one HTML fetch", async () => {
    // Prime the meta cache WITHOUT fetching any window (resolveGithubYears only
    // resolves the viewer), so the single-flight under test is the HTML fetch and
    // the concurrent burst below cannot fan out into extra GraphQL calls either.
    mockFetch.mockImplementation(async () => graphqlResponse(viewerPayload()));
    await resolveGithubYears(PAT);
    expect(graphqlCalls()).toHaveLength(1);

    // A slow HTML response so all three misses overlap on the same in-flight
    // fetch before any of them resolves.
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url) === GITHUB_GRAPHQL_URL) return graphqlResponse(viewerPayload());
      await new Promise((r) => setTimeout(r, 20));
      return htmlResponse(FIXTURE);
    });

    const [a, b, c] = await Promise.all([
      getGithub(PAT),
      getGithub(PAT),
      getGithub(PAT),
    ]);

    expect(contributionsCalls()).toHaveLength(1);
    expect(graphqlCalls()).toHaveLength(1);
    expect(a.available).toBe(true);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("returns { available: false } and makes NO upstream call with no PAT", async () => {
    expect(await getGithub("")).toEqual({ available: false });
    expect(await getGithub(null)).toEqual({ available: false });
    expect(await getGithub(undefined)).toEqual({ available: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("degrades — and skips the HTML fetch — when the GraphQL viewer fails", async () => {
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url) === GITHUB_GRAPHQL_URL
        ? graphqlResponse({}, 401)
        : htmlResponse(FIXTURE)
    );
    expect(await getGithub(PAT)).toEqual({ available: false });
    expect(contributionsCalls()).toHaveLength(0);
  });

  it("degrades on a GraphQL errors array returned WITH a 200", async () => {
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url) === GITHUB_GRAPHQL_URL
        ? graphqlResponse({ data: { viewer: null }, errors: [{ message: "bad" }] })
        : htmlResponse(FIXTURE)
    );
    expect(await getGithub(PAT)).toEqual({ available: false });
    expect(contributionsCalls()).toHaveLength(0);
  });

  it("degrades on a contributions HTTP error", async () => {
    wireUpstream();
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url) === GITHUB_GRAPHQL_URL
        ? graphqlResponse(viewerPayload())
        : htmlResponse("", 503)
    );
    expect(await getGithub(PAT)).toEqual({ available: false });
  });

  it("degrades on contributions HTML shape drift", async () => {
    mockFetch.mockImplementation(async (url: unknown) =>
      String(url) === GITHUB_GRAPHQL_URL
        ? graphqlResponse(viewerPayload())
        : htmlResponse("<html><body>nope</body></html>")
    );
    expect(await getGithub(PAT)).toEqual({ available: false });
  });

  it("does not cache a window failure — the next request retries", async () => {
    let htmlOk = false;
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url) === GITHUB_GRAPHQL_URL) return graphqlResponse(viewerPayload());
      return htmlOk ? htmlResponse(FIXTURE) : htmlResponse("", 500);
    });

    expect(await getGithub(PAT)).toEqual({ available: false });
    htmlOk = true;
    const ok = await getGithub(PAT);
    expect(ok.available).toBe(true);
    expect(contributionsCalls()).toHaveLength(2);
  });
});

describe("resolveGithubYears (§3.5 year-picker range)", () => {
  it("returns creation year → current year, newest first", async () => {
    wireUpstream();
    const years = await resolveGithubYears(PAT);
    expect(years).not.toBeNull();
    expect(years![0]).toBe(CURRENT_YEAR);
    expect(years![years!.length - 1]).toBe(CREATED_YEAR);
    // Contiguous and strictly descending.
    for (let i = 1; i < years!.length; i++) {
      expect(years![i]).toBe(years![i - 1] - 1);
    }
  });

  it("returns null with no PAT or when the viewer can't be resolved", async () => {
    expect(await resolveGithubYears("")).toBeNull();

    mockFetch.mockResolvedValue(graphqlResponse({}, 401));
    expect(await resolveGithubYears(PAT)).toBeNull();
  });
});

describe("github section schema (§3.4/§3.5, §3.9)", () => {
  it("is a registered publishable section type", () => {
    expect(SECTION_TYPES).toContain("github");
    expect(SECTION_DATA_SCHEMAS.github).toBeDefined();
  });

  it("accepts optional heading/intro and round-trips an empty config", () => {
    const res = githubData.safeParse({ heading: "Contributions", intro: "A year." });
    expect(res.success).toBe(true);
    const empty = githubData.parse({});
    expect("weeks" in empty).toBe(false);
  });

  it("rejects the removed `weeks` key and any other unknown key (strict)", () => {
    expect(githubData.safeParse({ weeks: 52 }).success).toBe(false);
    expect(githubData.safeParse({ surprise: 1 }).success).toBe(false);
  });

  it("draft-lenient variant still rejects the removed `weeks` key (§3.9)", () => {
    const { DRAFT_SECTION_DATA_SCHEMAS } = require("../src/schemas");
    const draftGithub = DRAFT_SECTION_DATA_SCHEMAS.github;
    expect(draftGithub.safeParse({}).success).toBe(true);
    expect(draftGithub.safeParse({ heading: "WIP" }).success).toBe(true);
    expect(draftGithub.safeParse({ weeks: 52 }).success).toBe(false);
  });
});

describe("GET /api/github (§4.1) — public, never leaks the PAT, never 5xx", () => {
  it("returns the curated calendar (default window) and NO PAT", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });
    wireUpstream();

    const res = await request(app).get("/api/github");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.total).toBe(FIXTURE_TOTAL);
    expect(res.body.years[0]).toBe(CURRENT_YEAR);
    expect(JSON.stringify(res.body)).not.toContain(PAT);
  });

  it("serves an in-range explicit year", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });
    wireUpstream();

    const res = await request(app).get(`/api/github?year=${CREATED_YEAR}`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it("400s a non-numeric year with a named message (raw shape, no envelope)", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });

    const res = await request(app).get("/api/github?year=abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/year/i);
    // Raw shape — not the { status, error, errorMsg } admin envelope.
    expect(res.body.status).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("400s a year before the account creation year", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });
    wireUpstream();

    const res = await request(app).get(`/api/github?year=${CREATED_YEAR - 1}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between/i);
    // A valid range was resolvable, so no contributions fetch happened.
    expect(contributionsCalls()).toHaveLength(0);
  });

  it("400s a year after the current year", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });
    wireUpstream();

    const res = await request(app).get(`/api/github?year=${CURRENT_YEAR + 1}`);
    expect(res.status).toBe(400);
  });

  it("returns 200 { available: false } (not a 5xx) with no PAT configured", async () => {
    mockStore.mockResolvedValue(null);

    const res = await request(app).get("/api/github");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 200 { available: false } when GitHub is unreachable", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/github");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });
});
