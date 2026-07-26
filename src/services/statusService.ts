/**
 * Status service — TECH_SPEC_V1.md §3.5 (`status` live section) / task #442.
 *
 * `GET /api/status` is served by portfolio-v6-api, NOT by the gateway directly.
 * The gateway's own `/api/health` enumerates every internal service and port and
 * returns **503 when any enrolled service is down** — which for this endpoint is a
 * VALID "degraded" payload, not an error (§3.5). Proxying it here means:
 *   - the exposed shape is a deliberate, curated choice (never the gateway's raw
 *     internal format),
 *   - the response is cached server-side ~30s so a traffic spike does not become a
 *     health-check storm against the gateway, and
 *   - the public site is decoupled from the gateway's response format.
 *
 * The service NEVER throws: an unreachable / timing-out / malformed upstream maps
 * to a degraded-shape payload (§3.5 "degrade rather than error"), so the router
 * can always answer 200 and never a 5xx.
 */

/**
 * One curated service entry in the /api/status payload. The shape is the
 * public-site contract (`portfolio-v6/src/lib/api.ts` `ServiceStatus`): a name,
 * a boolean `ok`, and an optional response time.
 */
export interface StatusServiceEntry {
  name: string;
  ok: boolean;
  /** Optional upstream response time, surfaced only when the gateway reports it. */
  response_time_ms?: number;
}

/**
 * The curated /api/status payload (§3.5), matching the public site's
 * `StatusResponse`: `degraded` is the overall flag (gateway 5xx/503 or any
 * service down), `services` the per-service breakdown.
 */
export interface StatusPayload {
  degraded: boolean;
  services: StatusServiceEntry[];
}

/** In-memory cache TTL (§3.5 "~30s"). */
export const STATUS_CACHE_TTL_MS = 30_000;

/** Upstream fetch timeout — a slow gateway must not hang the public endpoint. */
export const STATUS_UPSTREAM_TIMEOUT_MS = 4_000;

interface CacheEntry {
  payload: StatusPayload;
  expiresAt: number;
}

// Module-level cache + single-flight guard. The single-flight promise ensures a
// burst of concurrent cache-miss requests collapses into ONE upstream fetch —
// which is the whole point of the ~30s cache under a traffic spike (§3.5).
let cache: CacheEntry | null = null;
let inFlight: Promise<StatusPayload> | null = null;

/** Upstream `status` values that count as healthy; everything else is degraded. */
const HEALTHY_VALUES = new Set([
  "up",
  "ok",
  "healthy",
  "pass",
  "passing",
  "operational",
  "available",
  "true",
  "200",
]);

function normalizeStatus(raw: unknown): "up" | "degraded" {
  if (raw === true || raw === 200) return "up";
  if (typeof raw === "number") return raw >= 200 && raw < 300 ? "up" : "degraded";
  if (typeof raw === "string" && HEALTHY_VALUES.has(raw.trim().toLowerCase())) {
    return "up";
  }
  return "degraded";
}

function firstNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && c.trim() !== "" && Number.isFinite(Number(c))) {
      return Number(c);
    }
  }
  return undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }
  return undefined;
}

/**
 * Normalize one raw service record (from an array element or an object-map value)
 * into the curated entry shape. Defensive about field names because the gateway's
 * internal format is not owned here — `name`/`service`/`id`, and a handful of
 * common response-time keys, are all accepted.
 */
function normalizeEntry(
  raw: unknown,
  fallbackName: string
): StatusServiceEntry | null {
  if (raw == null || typeof raw !== "object") {
    // A bare status value keyed by service name (e.g. { "wmsfo": "up" }).
    if (raw === undefined) return null;
    return { name: fallbackName, ok: normalizeStatus(raw) === "up" };
  }
  const rec = raw as Record<string, unknown>;
  const name =
    firstString(rec.name, rec.service, rec.id, rec.key) ?? fallbackName;
  const ok = normalizeStatus(
    rec.status ?? rec.health ?? rec.state ?? rec.ok
  ) === "up";
  const responseTime = firstNumber(
    rec.response_time_ms,
    rec.responseTimeMs,
    rec.responseTime,
    rec.latency_ms,
    rec.latencyMs,
    rec.latency,
    rec.duration_ms,
    rec.durationMs
  );
  const entry: StatusServiceEntry = { name, ok };
  if (responseTime !== undefined) entry.response_time_ms = responseTime;
  return entry;
}

/** Pull the service records out of the gateway body, array- or map-shaped. */
function extractServices(body: unknown): StatusServiceEntry[] {
  if (body == null || typeof body !== "object") return [];
  const container = (body as Record<string, unknown>).services ?? body;

  if (Array.isArray(container)) {
    return container
      .map((el, i) => normalizeEntry(el, `service-${i}`))
      .filter((e): e is StatusServiceEntry => e !== null);
  }
  if (container && typeof container === "object") {
    return Object.entries(container as Record<string, unknown>)
      .map(([key, val]) => normalizeEntry(val, key))
      .filter((e): e is StatusServiceEntry => e !== null);
  }
  return [];
}

/**
 * Map a raw gateway response (HTTP status + parsed body) to the curated payload.
 * A 503 is treated as a valid degraded payload (§3.5), not a failure: its body is
 * still parsed for the per-service breakdown. Overall status is "degraded" if the
 * gateway 503'd or any enumerated service is degraded.
 */
export function mapGatewayResponse(
  httpStatus: number,
  body: unknown
): StatusPayload {
  const services = extractServices(body);
  const anyDegraded = services.some((s) => !s.ok);
  return {
    degraded: httpStatus === 503 || httpStatus >= 500 || anyDegraded,
    services,
  };
}

/** The payload returned when the gateway is unreachable or unparseable (§3.5). */
function degradedFallback(): StatusPayload {
  return { degraded: true, services: [] };
}

async function fetchStatus(gatewayHealthUrl: string): Promise<StatusPayload> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    STATUS_UPSTREAM_TIMEOUT_MS
  );
  try {
    const res = await fetch(gatewayHealthUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    // 503 is expected and meaningful (§3.5); any other non-2xx that still carries
    // a JSON body is mapped too. A body that will not parse degrades gracefully.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.status === 503) return mapGatewayResponse(503, body);
    if (res.ok) return mapGatewayResponse(res.status, body);
    // Any other upstream status (500, 404, …): honor a parsed body if present,
    // otherwise degrade. Never surface it as an error to the caller.
    return body ? mapGatewayResponse(res.status, body) : degradedFallback();
  } catch (err) {
    // Timeout, DNS failure, connection refused — the gateway is unreachable.
    console.error(
      "[statusService] gateway health fetch failed; serving degraded:",
      err instanceof Error ? err.message : err
    );
    return degradedFallback();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the curated status payload, served from a ~30s in-memory cache. Concurrent
 * cache-miss callers share a single upstream fetch (single-flight). Always
 * resolves — never rejects — so `GET /api/status` never returns a 5xx (§3.5).
 */
export async function getStatus(
  gatewayHealthUrl: string
): Promise<StatusPayload> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.payload;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const payload = await fetchStatus(gatewayHealthUrl);
    cache = { payload, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
    return payload;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Test-only: clear the module cache and any in-flight fetch. */
export function _resetStatusCacheForTests(): void {
  cache = null;
  inFlight = null;
}
