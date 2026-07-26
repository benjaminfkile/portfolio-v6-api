import request from "supertest";
import app from "../src/app";
import {
  getStatus,
  mapGatewayResponse,
  _resetStatusCacheForTests,
  STATUS_CACHE_TTL_MS,
} from "../src/services/statusService";

/**
 * /api/status tests — TECH_SPEC_V1.md §3.5 / task #442.
 *
 * ALL upstream HTTP is mocked (global `fetch`); no gateway, no AWS, no DB is
 * touched. Covered: the 503→degraded mapping (a 503 is a VALID payload, not an
 * error), the ~30s in-memory cache (upstream called once within the TTL, refetched
 * after it), and the degrade-rather-than-error contract (unreachable gateway →
 * degraded-shape 200, never a 5xx).
 */

const GATEWAY_URL = "http://gateway.test/api/health";

const mockFetch = jest.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

beforeAll(() => {
  app.set("secrets", {
    node_env: "development",
    gateway_health_url: GATEWAY_URL,
  });
});

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetStatusCacheForTests();
});

describe("mapGatewayResponse (§3.5)", () => {
  it("maps a 200 healthy gateway (services array) to up with response times", () => {
    const payload = mapGatewayResponse(200, {
      status: "ok",
      services: [
        { name: "wmsfo-api", status: "up", responseTime: 12 },
        { name: "file-manager", status: "up", response_time_ms: 8 },
      ],
    });
    expect(payload).toEqual({
      status: "up",
      services: [
        { name: "wmsfo-api", status: "up", response_time_ms: 12 },
        { name: "file-manager", status: "up", response_time_ms: 8 },
      ],
    });
  });

  it("treats a 503 as a valid DEGRADED payload, not an error (§3.5)", () => {
    const payload = mapGatewayResponse(503, {
      services: [
        { name: "wmsfo-api", status: "up" },
        { name: "3gixhub", status: "down" },
      ],
    });
    expect(payload.status).toBe("degraded");
    expect(payload.services).toEqual([
      { name: "wmsfo-api", status: "up" },
      { name: "3gixhub", status: "degraded" },
    ]);
  });

  it("maps an object-map of services (name from the key)", () => {
    const payload = mapGatewayResponse(200, {
      services: {
        "wmsfo-api": { status: "up", latency: 5 },
        "lease-tracker": { status: "healthy" },
      },
    });
    expect(payload.status).toBe("up");
    expect(payload.services).toEqual([
      { name: "wmsfo-api", status: "up", response_time_ms: 5 },
      { name: "lease-tracker", status: "up" },
    ]);
  });

  it("is degraded overall when any enumerated service is down, even on a 200", () => {
    const payload = mapGatewayResponse(200, {
      services: [{ name: "a", status: "up" }, { name: "b", status: "degraded" }],
    });
    expect(payload.status).toBe("degraded");
  });
});

describe("getStatus caching (§3.5 ~30s)", () => {
  it("calls the upstream once within the TTL and serves the cache after", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { services: [{ name: "a", status: "up" }] })
    );

    const first = await getStatus(GATEWAY_URL);
    const second = await getStatus(GATEWAY_URL);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(GATEWAY_URL, expect.any(Object));
    expect(second).toEqual(first);
    expect(first.status).toBe("up");
  });

  it("collapses concurrent cache-miss callers into a single upstream fetch", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { services: [{ name: "a", status: "up" }] })
    );

    const [a, b, c] = await Promise.all([
      getStatus(GATEWAY_URL),
      getStatus(GATEWAY_URL),
      getStatus(GATEWAY_URL),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("refetches once the TTL has elapsed", async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(
        jsonResponse(200, { services: [{ name: "a", status: "up" }] })
      );

      await getStatus(GATEWAY_URL);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(STATUS_CACHE_TTL_MS + 1_000);

      await getStatus(GATEWAY_URL);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("getStatus degradation (§3.5 degrade rather than error)", () => {
  it("returns a degraded-shape payload when the gateway is unreachable — never throws", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const payload = await getStatus(GATEWAY_URL);

    expect(payload).toEqual({ status: "degraded", services: [] });
  });

  it("degrades when the upstream body will not parse as JSON", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const payload = await getStatus(GATEWAY_URL);
    expect(payload).toEqual({ status: "up", services: [] });
  });
});

describe("GET /api/status (§3.5) — public, never 5xx", () => {
  it("serves the curated payload in the success envelope on a healthy gateway", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { services: [{ name: "wmsfo-api", status: "up" }] })
    );

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      error: false,
      data: { status: "up", services: [{ name: "wmsfo-api", status: "up" }] },
    });
  });

  it("returns 200 with a degraded payload when the gateway 503s (§3.5)", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(503, { services: [{ name: "3gixhub", status: "down" }] })
    );

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("degraded");
    expect(res.body.data.services).toEqual([
      { name: "3gixhub", status: "degraded" },
    ]);
  });

  it("returns 200 (not a 5xx) when the gateway is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: "degraded", services: [] });
  });
});
