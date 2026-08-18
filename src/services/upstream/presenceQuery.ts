/**
 * Presence owner API client (task #95, viewer-aware Spotify cadence).
 *
 * The gateway realtime hub exposes an internal owner endpoint the API can hit
 * to learn how many clients are currently subscribed to a `{service}:{topic}`
 * channel. We use it as the primary "is anyone watching?" signal for the
 * Spotify lane; a positive count means at least one browser has an open
 * realtime subscription for now-playing and the fast cadence should stay on.
 *
 * The endpoint is authenticated with the SAME `X-Gateway-Realtime-Token` the
 * publisher already carries, so no new secret is introduced. Failure — HTTP
 * error, timeout, malformed body — throws; the lane treats a throw as
 * "presence up in the air, keep polling fast" (fail open).
 */

/**
 * Header the gateway checks on every internal call. Duplicated from
 * `realtimePublisher.ts` so this module has no cross-import dependency.
 */
export const PRESENCE_TOKEN_HEADER = "X-Gateway-Realtime-Token";

/** How long a presence GET is allowed to hang before we give up. */
export const PRESENCE_TIMEOUT_MS = 2_000;

/**
 * Build the URL for the presence owner API. `{service}:now-playing` is the
 * channel the browser subscribes to on the portfolio page.
 */
export function presenceUrl(
  gatewayInternalUrl: string,
  serviceName: string,
  topic: string
): string {
  const trimmed = gatewayInternalUrl.replace(/\/+$/, "");
  return `${trimmed}/internal/presence/${encodeURIComponent(
    `${serviceName}:${topic}`
  )}`;
}

/** Config the presence query needs. All fields are env-sourced. */
export interface PresenceQueryConfig {
  gatewayInternalUrl: string;
  realtimeToken: string;
  serviceName: string;
  topic: string;
}

/**
 * GET the current subscriber count for `{serviceName}:{topic}`. Throws on any
 * error — the lane's caller treats a throw as "fail open" (count the tick as
 * active) so a gateway hiccup never disables the fast-cadence feature.
 */
export async function fetchPresenceCount(
  config: PresenceQueryConfig
): Promise<number> {
  const url = presenceUrl(
    config.gatewayInternalUrl,
    config.serviceName,
    config.topic
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRESENCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        [PRESENCE_TOKEN_HEADER]: config.realtimeToken,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Gateway presence returned status ${res.status}`);
    }
    const body = (await res.json()) as { count?: unknown };
    const count = typeof body?.count === "number" ? body.count : NaN;
    if (!Number.isFinite(count)) {
      throw new Error("Gateway presence returned no numeric count");
    }
    return count;
  } finally {
    clearTimeout(timer);
  }
}
