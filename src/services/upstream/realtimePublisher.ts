/**
 * Realtime publisher — POSTs curated payloads to the gateway's internal publish
 * endpoint so browsers get near-instant updates (task #84).
 *
 * The gateway owns the realtime hub (see gateway-api REALTIME.md). Channels are
 * `{service}:{topic}` where `service` is this container's manifest service name,
 * so we publish on `portfolio-v6-api:now-playing` and `portfolio-v6-api:status`.
 * The endpoint requires the `X-Gateway-Realtime-Token` header carrying the
 * gateway-injected `GATEWAY_REALTIME_TOKEN` env var.
 *
 * Delivery is at-most-once (per REALTIME.md); the API keeps its polling floor —
 * events are hints, not the source of truth. That is why we ALSO emit a
 * lightweight heartbeat every ~30s: a stalled event stream is detectable by the
 * client "we haven't heard from you in a while" rule.
 *
 * Failures are logged and SWALLOWED — a broken realtime path never affects the
 * poll loop, snapshot writes, or public HTTP serving.
 */

/** The manifest service name that owns the realtime channels. */
export const REALTIME_SERVICE_NAME = "portfolio-v6-api";

/** Header the gateway checks on every internal publish. */
export const REALTIME_TOKEN_HEADER = "X-Gateway-Realtime-Token";

/**
 * Full URL to POST publish events at. Built from the gateway internal base URL
 * and the fixed `/internal/publish` path. Kept as a helper (not a constant) so
 * we honor the injected `GATEWAY_INTERNAL_URL` env var.
 */
export function publishUrl(gatewayInternalUrl: string): string {
  const trimmed = gatewayInternalUrl.replace(/\/+$/, "");
  return `${trimmed}/internal/publish`;
}

/** How long a publish is allowed to hang before we give up. */
export const PUBLISH_TIMEOUT_MS = 2_000;

/** Configuration the publisher needs. Both env-sourced. */
export interface RealtimePublisherConfig {
  gatewayInternalUrl: string;
  realtimeToken: string;
}

/** One publish request body. `event` is the client-facing event name. */
export interface PublishRequest<T> {
  /** Channel topic (e.g. `now-playing`). Prefixed with the service name here. */
  topic: string;
  /** Event name (e.g. `snapshot`, `heartbeat`). */
  event: string;
  /** Curated payload; serialized as JSON. */
  data: T;
}

/**
 * POST a publish to the gateway internal endpoint. Never throws. When the
 * config is missing (no gateway URL / no token) it silently no-ops so tests
 * and local dev never fail. The response body is discarded (fire-and-forget).
 */
export async function publish<T>(
  config: RealtimePublisherConfig,
  req: PublishRequest<T>
): Promise<void> {
  if (!config.gatewayInternalUrl || !config.realtimeToken) return;

  const url = publishUrl(config.gatewayInternalUrl);
  const body = JSON.stringify({
    channel: `${REALTIME_SERVICE_NAME}:${req.topic}`,
    event: req.event,
    data: req.data,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REALTIME_TOKEN_HEADER]: config.realtimeToken,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Log the STATUS ONLY — never the body, which could echo the token.
      throw new Error(`Gateway publish returned status ${res.status}`);
    }
  } catch (err) {
    console.error(
      "[realtimePublisher] publish failed; swallowed:",
      err instanceof Error ? err.message : err
    );
  } finally {
    clearTimeout(timer);
  }
}
