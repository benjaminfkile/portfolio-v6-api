import request from "supertest";

/**
 * /api/github tests — TECH_SPEC_V1.md §3.4/§3.5/§4.1 (v1.2) / task #485.
 *
 * ALL upstream HTTP is mocked (global `fetch`); the credential store is mocked so
 * no DB is touched. Covered: the curated happy path (GraphQL shape → curated
 * shape), that the `Authorization` header carries the stored PAT AND the PAT
 * appears NOWHERE in the response body, the ~1h cache (upstream called once),
 * single-flight, every degrade case → `{ available: false }` (no PAT, HTTP error,
 * timeout, a GraphQL `errors` array returned WITH a 200, shape drift), the
 * `github` section schema (weeks bounds, defaults, strictness, draft leniency),
 * and that a failure is not cached.
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
  curateGithub,
  _resetGithubCacheForTests,
  GITHUB_GRAPHQL_URL,
  GITHUB_CACHE_TTL_MS,
} from "../src/services/githubService";
import { githubData, SECTION_DATA_SCHEMAS, SECTION_TYPES } from "../src/schemas";

const mockStore = getStoredServiceToken as jest.Mock;
const mockFetch = jest.fn();

// A secret-looking PAT that must never surface in a response or a log.
const PAT = "ghp_SECRET-personal-access-token-xxxxxxxxxxxx";

/**
 * A well-shaped GraphQL response: two weeks, seven days each, plus a total.
 * GitHub returns weeks oldest → newest already.
 */
function graphqlPayload(): unknown {
  return {
    data: {
      viewer: {
        contributionsCollection: {
          contributionCalendar: {
            totalContributions: 1234,
            weeks: [
              {
                contributionDays: [
                  { contributionCount: 0 },
                  { contributionCount: 1 },
                  { contributionCount: 2 },
                  { contributionCount: 3 },
                  { contributionCount: 4 },
                  { contributionCount: 5 },
                  { contributionCount: 6 },
                ],
              },
              {
                contributionDays: [
                  { contributionCount: 7 },
                  { contributionCount: 8 },
                  { contributionCount: 9 },
                  { contributionCount: 10 },
                  { contributionCount: 11 },
                  { contributionCount: 12 },
                  { contributionCount: 13 },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** The curated shape `graphqlPayload()` maps to. */
function curatedPayload() {
  return {
    available: true,
    total: 1234,
    weeks: [
      { days: [0, 1, 2, 3, 4, 5, 6] },
      { days: [7, 8, 9, 10, 11, 12, 13] },
    ],
  };
}

function graphqlResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  } as unknown as Response;
}

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  mockStore.mockReset();
  _resetGithubCacheForTests();
});

describe("curateGithub (§3.5 curated shape)", () => {
  it("maps the GraphQL contribution calendar to the curated shape", () => {
    expect(curateGithub(graphqlPayload())).toEqual(curatedPayload());
  });

  it("defaults a missing/non-numeric daily count to 0 within a valid week", () => {
    const payload = {
      data: {
        viewer: {
          contributionsCollection: {
            contributionCalendar: {
              totalContributions: 3,
              weeks: [
                {
                  contributionDays: [
                    { contributionCount: 3 },
                    { contributionCount: "x" },
                    {},
                  ],
                },
              ],
            },
          },
        },
      },
    };
    expect(curateGithub(payload)).toEqual({
      available: true,
      total: 3,
      weeks: [{ days: [3, 0, 0] }],
    });
  });

  it.each([
    ["null payload", null],
    ["non-object payload", "nope"],
    ["a GraphQL errors array with 200", { errors: [{ message: "Bad credentials" }] }],
    ["missing data", { foo: 1 }],
    ["null data", { data: null }],
    ["missing viewer", { data: {} }],
    ["missing contributionsCollection", { data: { viewer: {} } }],
    [
      "missing contributionCalendar",
      { data: { viewer: { contributionsCollection: {} } } },
    ],
    [
      "non-numeric totalContributions",
      {
        data: {
          viewer: {
            contributionsCollection: {
              contributionCalendar: { totalContributions: "x", weeks: [] },
            },
          },
        },
      },
    ],
    [
      "weeks not an array",
      {
        data: {
          viewer: {
            contributionsCollection: {
              contributionCalendar: { totalContributions: 1, weeks: {} },
            },
          },
        },
      },
    ],
    [
      "contributionDays not an array",
      {
        data: {
          viewer: {
            contributionsCollection: {
              contributionCalendar: {
                totalContributions: 1,
                weeks: [{ contributionDays: 5 }],
              },
            },
          },
        },
      },
    ],
  ])("degrades to unavailable on %s", (_label, payload) => {
    expect(curateGithub(payload)).toEqual({ available: false });
  });
});

describe("getGithub (§3.5)", () => {
  it("fetches upstream once, POSTs the query, and carries the PAT in the auth header", async () => {
    mockFetch.mockResolvedValue(graphqlResponse(graphqlPayload()));

    const result = await getGithub(PAT);
    expect(result).toEqual(curatedPayload());

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe(GITHUB_GRAPHQL_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // The PAT rides ONLY the Authorization header, as `bearer <PAT>`.
    expect(headers.authorization).toBe(`bearer ${PAT}`);
    // GitHub requires a User-Agent.
    expect(headers["user-agent"]).toBeTruthy();
    // The PAT never appears in the URL, and never in the curated result.
    expect(String(url)).not.toContain(PAT);
    expect(JSON.stringify(result)).not.toContain(PAT);
  });

  it("serves the ~1h cache — upstream called once for repeat reads", async () => {
    mockFetch.mockResolvedValue(graphqlResponse(graphqlPayload()));

    const a = await getGithub(PAT);
    const b = await getGithub(PAT);

    expect(a).toEqual(curatedPayload());
    expect(b).toEqual(curatedPayload());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the ~1h TTL elapses", async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(graphqlResponse(graphqlPayload()));

      await getGithub(PAT);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(GITHUB_CACHE_TTL_MS + 1_000);

      await getGithub(PAT);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("collapses a burst of concurrent cache-miss requests to one fetch (single-flight)", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const inFlight = Promise.all([getGithub(PAT), getGithub(PAT), getGithub(PAT)]);
    resolveFetch(graphqlResponse(graphqlPayload()));
    const [a, b, c] = await inFlight;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(curatedPayload());
    expect(b).toEqual(curatedPayload());
    expect(c).toEqual(curatedPayload());
  });

  it("returns { available: false } and makes NO upstream call with no PAT", async () => {
    expect(await getGithub("")).toEqual({ available: false });
    expect(await getGithub(null)).toEqual({ available: false });
    expect(await getGithub(undefined)).toEqual({ available: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns { available: false } on an upstream non-2xx", async () => {
    mockFetch.mockResolvedValue(graphqlResponse({}, 401));
    expect(await getGithub(PAT)).toEqual({ available: false });
  });

  it("returns { available: false } when the network call rejects (timeout)", async () => {
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));
    expect(await getGithub(PAT)).toEqual({ available: false });
  });

  it("returns { available: false } on a GraphQL errors array returned WITH a 200", async () => {
    mockFetch.mockResolvedValue(
      graphqlResponse({ data: { viewer: null }, errors: [{ message: "Bad credentials" }] }, 200)
    );
    expect(await getGithub(PAT)).toEqual({ available: false });
  });

  it("returns { available: false } on shape drift (missing viewer)", async () => {
    mockFetch.mockResolvedValue(graphqlResponse({ data: {} }));
    expect(await getGithub(PAT)).toEqual({ available: false });
  });

  it("does not cache a failure — the next request retries", async () => {
    mockFetch.mockResolvedValueOnce(graphqlResponse({}, 500));
    expect(await getGithub(PAT)).toEqual({ available: false });

    mockFetch.mockResolvedValueOnce(graphqlResponse(graphqlPayload()));
    expect(await getGithub(PAT)).toEqual(curatedPayload());
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a GraphQL-errors 200 — the next request retries", async () => {
    mockFetch.mockResolvedValueOnce(
      graphqlResponse({ errors: [{ message: "rate limited" }] }, 200)
    );
    expect(await getGithub(PAT)).toEqual({ available: false });

    mockFetch.mockResolvedValueOnce(graphqlResponse(graphqlPayload()));
    expect(await getGithub(PAT)).toEqual(curatedPayload());
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("github section schema (§3.4/§3.5, §3.9)", () => {
  it("is a registered publishable section type", () => {
    expect(SECTION_TYPES).toContain("github");
    expect(SECTION_DATA_SCHEMAS.github).toBeDefined();
  });

  it("defaults weeks to 52 and accepts an optional heading", () => {
    const res = githubData.safeParse({ heading: "Contributions" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.weeks).toBe(52);
      expect(res.data.heading).toBe("Contributions");
    }
  });

  it("accepts weeks within 1..53 and rejects out-of-range or non-integers", () => {
    expect(githubData.safeParse({ weeks: 1 }).success).toBe(true);
    expect(githubData.safeParse({ weeks: 53 }).success).toBe(true);
    expect(githubData.safeParse({ weeks: 0 }).success).toBe(false);
    expect(githubData.safeParse({ weeks: 54 }).success).toBe(false);
    expect(githubData.safeParse({ weeks: 12.5 }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(githubData.safeParse({ weeks: 12, surprise: 1 }).success).toBe(false);
  });

  it("draft-lenient variant: weeks may be absent but a bad one still fails (§3.9)", () => {
    const { DRAFT_SECTION_DATA_SCHEMAS } = require("../src/schemas");
    const draftGithub = DRAFT_SECTION_DATA_SCHEMAS.github;
    expect(draftGithub.safeParse({}).success).toBe(true);
    expect(draftGithub.safeParse({ heading: "WIP" }).success).toBe(true);
    expect(draftGithub.safeParse({ weeks: 99 }).success).toBe(false);
    expect(draftGithub.safeParse({ surprise: true }).success).toBe(false);
  });
});

describe("GET /api/github (§4.1) — public, never leaks the PAT, never 5xx", () => {
  it("returns the curated shape and NO PAT when a PAT is configured", async () => {
    mockStore.mockResolvedValue({ token: PAT, authorizedAt: new Date() });
    mockFetch.mockResolvedValue(graphqlResponse(graphqlPayload()));

    const res = await request(app).get("/api/github");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(curatedPayload());
    // The stored PAT never appears anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(PAT);
  });

  it("returns 200 { available: false } (not a 5xx) when no PAT is configured", async () => {
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
