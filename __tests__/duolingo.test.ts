import request from "supertest";

/**
 * /api/duolingo tests — TECH_SPEC_V1.md §3.4/§3.5/§4.1 (v1.2) / task #484.
 *
 * ALL upstream HTTP is mocked (global `fetch`); the credential store is mocked so
 * no DB is touched. Covered: the curated happy path incl. language selection, the
 * ~1h cache (upstream called once), single-flight, every degrade case →
 * `{ available: false }` (no username, upstream error/timeout, shape drift,
 * unknown language), the `duolingo` section schema (language regex, defaults,
 * draft leniency), and that the stored username never leaks into a response.
 */

// The store is mocked so the router resolves a username without a database. Keep
// every other export real (resolveEncryptionKey etc.) via requireActual.
jest.mock("../src/services/serviceTokenStore", () => {
  const actual = jest.requireActual("../src/services/serviceTokenStore");
  return { ...actual, getStoredServiceToken: jest.fn() };
});

import app from "../src/app";
import { getStoredServiceToken } from "../src/services/serviceTokenStore";
import {
  getDuolingo,
  curateDuolingo,
  resolveLanguage,
  _resetDuolingoCacheForTests,
  DUOLINGO_USERS_URL,
  DUOLINGO_CACHE_TTL_MS,
  DEFAULT_LANGUAGE,
} from "../src/services/duolingoService";
import { duolingoData, SECTION_DATA_SCHEMAS, SECTION_TYPES } from "../src/schemas";

const mockStore = getStoredServiceToken as jest.Mock;
const mockFetch = jest.fn();

const USERNAME = "ben-SECRET-username";

/** A well-shaped upstream payload with two courses to select between. */
function upstreamPayload(): unknown {
  return {
    users: [
      {
        username: USERNAME,
        streak: 42,
        courses: [
          { title: "Spanish", learningLanguage: "es", xp: 12000, crowns: 30 },
          { title: "French", learningLanguage: "fr", xp: 3000, crowns: 8 },
        ],
      },
    ],
  };
}

function usersResponse(payload: unknown, status = 200): Response {
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
  _resetDuolingoCacheForTests();
});

describe("curateDuolingo (§3.5 curated shape)", () => {
  it("selects the course matching the requested language", () => {
    expect(curateDuolingo(upstreamPayload(), "es")).toEqual({
      available: true,
      streak: 42,
      course: { title: "Spanish", xp: 12000, crowns: 30 },
    });
    expect(curateDuolingo(upstreamPayload(), "fr")).toEqual({
      available: true,
      streak: 42,
      course: { title: "French", xp: 3000, crowns: 8 },
    });
  });

  it("defaults missing numeric course fields to 0 (unofficial endpoint)", () => {
    const payload = {
      users: [{ streak: 5, courses: [{ title: "Welsh", learningLanguage: "cy" }] }],
    };
    expect(curateDuolingo(payload, "cy")).toEqual({
      available: true,
      streak: 5,
      course: { title: "Welsh", xp: 0, crowns: 0 },
    });
  });

  it.each([
    ["null payload", null],
    ["non-object payload", "nope"],
    ["missing users", { foo: 1 }],
    ["empty users array", { users: [] }],
    ["null users[0]", { users: [null] }],
    ["non-numeric streak", { users: [{ streak: "x", courses: [] }] }],
    ["missing courses", { users: [{ streak: 1 }] }],
    ["courses not an array", { users: [{ streak: 1, courses: {} }] }],
  ])("degrades to unavailable on %s", (_label, payload) => {
    expect(curateDuolingo(payload, "es")).toEqual({ available: false });
  });

  it("degrades to unavailable when no course matches the language", () => {
    // 'de' is a valid code by the regex, but the account has no German course.
    expect(curateDuolingo(upstreamPayload(), "de")).toEqual({ available: false });
  });
});

describe("resolveLanguage (§3.5 — regex, default 'es')", () => {
  it("honors a well-formed lowercase course code", () => {
    expect(resolveLanguage("es")).toBe("es");
    expect(resolveLanguage("fr")).toBe("fr");
    expect(resolveLanguage("zh-cn")).toBe("zh-cn");
  });

  it("falls back to the default for absent, wrong-type, or malformed values", () => {
    expect(resolveLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage(["es"])).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage("ES")).toBe(DEFAULT_LANGUAGE); // uppercase
    expect(resolveLanguage("e")).toBe(DEFAULT_LANGUAGE); // too short
    expect(resolveLanguage("englishh")).toBe("englishh"); // 8 chars, still valid
    expect(resolveLanguage("englishhh")).toBe(DEFAULT_LANGUAGE); // 9 chars, too long
    expect(resolveLanguage("es!")).toBe(DEFAULT_LANGUAGE); // illegal char
  });
});

describe("getDuolingo (§3.5)", () => {
  it("fetches upstream once and returns the curated shape for the language", async () => {
    mockFetch.mockResolvedValue(usersResponse(upstreamPayload()));

    const es = await getDuolingo(USERNAME, "es");
    expect(es).toEqual({
      available: true,
      streak: 42,
      course: { title: "Spanish", xp: 12000, crowns: 30 },
    });

    // A browser-ish User-Agent is sent, and the username is in the query string.
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe(
      `${DUOLINGO_USERS_URL}?username=${encodeURIComponent(USERNAME)}`
    );
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(
      /Mozilla/
    );
  });

  it("serves the ~1h cache — upstream called once, different languages off one payload", async () => {
    mockFetch.mockResolvedValue(usersResponse(upstreamPayload()));

    const es = await getDuolingo(USERNAME, "es");
    const fr = await getDuolingo(USERNAME, "fr");

    expect(es).toMatchObject({ course: { title: "Spanish" } });
    expect(fr).toMatchObject({ course: { title: "French" } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the ~1h TTL elapses", async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(usersResponse(upstreamPayload()));

      await getDuolingo(USERNAME, "es");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(DUOLINGO_CACHE_TTL_MS + 1_000);

      await getDuolingo(USERNAME, "es");
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

    const inFlight = Promise.all([
      getDuolingo(USERNAME, "es"),
      getDuolingo(USERNAME, "fr"),
      getDuolingo(USERNAME, "es"),
    ]);
    resolveFetch(usersResponse(upstreamPayload()));
    const [a, b, c] = await inFlight;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ course: { title: "Spanish" } });
    expect(b).toMatchObject({ course: { title: "French" } });
    expect(c).toMatchObject({ course: { title: "Spanish" } });
  });

  it("returns { available: false } and makes NO upstream call with no username", async () => {
    expect(await getDuolingo("", "es")).toEqual({ available: false });
    expect(await getDuolingo(null, "es")).toEqual({ available: false });
    expect(await getDuolingo(undefined, "es")).toEqual({ available: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns { available: false } on an upstream non-2xx", async () => {
    mockFetch.mockResolvedValue(usersResponse({}, 403));
    expect(await getDuolingo(USERNAME, "es")).toEqual({ available: false });
  });

  it("returns { available: false } when the network call rejects (timeout)", async () => {
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));
    expect(await getDuolingo(USERNAME, "es")).toEqual({ available: false });
  });

  it("returns { available: false } on shape drift (missing users)", async () => {
    mockFetch.mockResolvedValue(usersResponse({ nope: true }));
    expect(await getDuolingo(USERNAME, "es")).toEqual({ available: false });
  });

  it("returns { available: false } for an unknown language (no matching course)", async () => {
    mockFetch.mockResolvedValue(usersResponse(upstreamPayload()));
    expect(await getDuolingo(USERNAME, "de")).toEqual({ available: false });
  });

  it("does not cache a failure — the next request retries", async () => {
    mockFetch.mockResolvedValueOnce(usersResponse({}, 500));
    expect(await getDuolingo(USERNAME, "es")).toEqual({ available: false });

    mockFetch.mockResolvedValueOnce(usersResponse(upstreamPayload()));
    expect(await getDuolingo(USERNAME, "es")).toMatchObject({ available: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("duolingo section schema (§3.4/§3.5, §3.9)", () => {
  it("is a registered publishable section type", () => {
    expect(SECTION_TYPES).toContain("duolingo");
    expect(SECTION_DATA_SCHEMAS.duolingo).toBeDefined();
  });

  it("defaults language to 'es' and accepts optional heading/score_label", () => {
    const res = duolingoData.safeParse({ heading: "Learning", score_label: "XP" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.language).toBe("es");
      expect(res.data.heading).toBe("Learning");
      expect(res.data.score_label).toBe("XP");
    }
  });

  it("accepts lowercase course codes and rejects malformed ones", () => {
    expect(duolingoData.safeParse({ language: "fr" }).success).toBe(true);
    expect(duolingoData.safeParse({ language: "zh-cn" }).success).toBe(true);
    expect(duolingoData.safeParse({ language: "ES" }).success).toBe(false); // uppercase
    expect(duolingoData.safeParse({ language: "e" }).success).toBe(false); // too short
    expect(duolingoData.safeParse({ language: "englishhh" }).success).toBe(false); // 9 chars
    expect(duolingoData.safeParse({ language: "e s" }).success).toBe(false); // illegal char
  });

  it("rejects unknown keys (strict)", () => {
    expect(duolingoData.safeParse({ language: "es", surprise: 1 }).success).toBe(
      false
    );
  });

  it("draft-lenient variant: language may be absent but a bad one still fails (§3.9)", () => {
    const draft = SECTION_DATA_SCHEMAS.duolingo; // canonical, for contrast below
    expect(draft).toBeDefined();
    const { DRAFT_SECTION_DATA_SCHEMAS } = require("../src/schemas");
    const draftDuo = DRAFT_SECTION_DATA_SCHEMAS.duolingo;
    expect(draftDuo.safeParse({}).success).toBe(true);
    expect(draftDuo.safeParse({ heading: "WIP" }).success).toBe(true);
    expect(draftDuo.safeParse({ language: "ES" }).success).toBe(false);
    expect(draftDuo.safeParse({ surprise: true }).success).toBe(false);
  });
});

describe("GET /api/duolingo (§4.1) — public, never leaks the username, never 5xx", () => {
  it("returns the curated shape for the ?language= course and NO username", async () => {
    mockStore.mockResolvedValue({ token: USERNAME, authorizedAt: new Date() });
    mockFetch.mockResolvedValue(usersResponse(upstreamPayload()));

    const res = await request(app).get("/api/duolingo?language=fr");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      streak: 42,
      course: { title: "French", xp: 3000, crowns: 8 },
    });
    // The stored username never appears anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(USERNAME);
  });

  it("defaults to the 'es' course when ?language= is omitted", async () => {
    mockStore.mockResolvedValue({ token: USERNAME, authorizedAt: new Date() });
    mockFetch.mockResolvedValue(usersResponse(upstreamPayload()));

    const res = await request(app).get("/api/duolingo");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ course: { title: "Spanish" } });
  });

  it("returns 200 { available: false } (not a 5xx) when no username is configured", async () => {
    mockStore.mockResolvedValue(null);

    const res = await request(app).get("/api/duolingo");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 200 { available: false } when Duolingo is unreachable", async () => {
    mockStore.mockResolvedValue({ token: USERNAME, authorizedAt: new Date() });
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/duolingo");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });
});
