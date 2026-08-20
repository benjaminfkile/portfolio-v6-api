import express, { NextFunction, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  deleteStoredServiceToken,
  getStoredServiceToken,
  resolveEncryptionKey,
  saveServiceToken,
} from "../services/serviceTokenStore";
import {
  AuthKind,
  IntegrationDescriptor,
  INTEGRATION_DESCRIPTORS,
  getIntegrationDescriptor,
} from "../services/integrationsService";
import { computeSpotifyStatus } from "../services/spotifyStatusService";
import {
  deleteListenerCredential,
  saveListenerCredential,
} from "../services/listenerCredentialStore";
import type { UpstreamHandle } from "../services/upstream";

/**
 * Admin integrations router (§4.7) - the generalized replacement for the §4.6
 * Spotify-only reconnect router, driving every integration from its descriptor.
 *
 * New surface (all under /api/admin):
 *   GET    /integrations                 (admin)  status of every integration
 *   PUT    /integrations/:key/value      (admin)  set an api_key/value credential
 *   POST   /integrations/:key/connect    (admin)  begin an oauth flow
 *   GET    /integrations/:key/callback   (state)  oauth redirect target
 *   DELETE /integrations/:key            (admin)  remove the stored credential
 *
 * Legacy aliases (kept working so the currently-deployed admin keeps functioning
 * until its own task lands): /api/admin/spotify/status|connect|callback and
 * DELETE /api/admin/spotify all forward to the same handlers with key=spotify.
 *
 * As in §4.6, the oauth callback CANNOT sit behind requireAdmin - it is a browser
 * redirect from the provider carrying no bearer token. It is guarded instead by
 * the single-use, 10-minute `state` minted at /connect (only a verified admin can
 * obtain one), so an anonymous hit can never cause a credential to be stored. No
 * token, code, secret, or stored value ever appears in a response, a redirect
 * URL, or a log line.
 *
 * ---------------------------------------------------------------------------
 * GET /api/admin/integrations - response shape (as of task #122)
 * ---------------------------------------------------------------------------
 *
 * Envelope: { data: { integrations: IntegrationEntry[] } } via `success(...)`.
 * The array carries one entry per descriptor (`spotify`, `github`, `duolingo`).
 *
 * Spotify entry (the "whole machine" - drives the admin Integrations card):
 *   {
 *     key:              "spotify",
 *     name:             "Spotify",
 *     auth_kind:        "oauth",
 *
 *     // Task #113 - the truthful 5-state POLLING lane contract.
 *     state:            "connected" | "auth_broken" | "rate_limited"
 *                      | "disconnected" | "disabled",
 *
 *     // Task #122 - which lane is actually serving now-playing right now.
 *     //   "listener" iff the shared listener health record is `connected`.
 *     //   "polling"  iff `state === "connected"` (grant stored, not
 *     //              disabled/rate-limited/auth-broken) AND the listener is
 *     //              NOT connected.
 *     //   "none"     otherwise.
 *     source:           "listener" | "polling" | "none",
 *
 *     // Task #122 - curated connect-listener snapshot read from the shared
 *     // Redis health record written by the leader (task series 4/9). Redis
 *     // outage degrades `state` to "unknown" - never a 5xx.
 *     listener: {
 *       state:              "idle" | "connecting" | "connected" | "backoff"
 *                          | "credential_dead" | "no_credential" | "unknown",
 *       last_event_at:      string (ISO 8601) | null,
 *       error_kind:         string | null,     // e.g. "invalid_cookie",
 *                                              //      "transient"
 *       credential_present: boolean,           // true iff sp_dc row exists
 *     },
 *
 *     // Task #113 - polling-lane observations (shared health mirror).
 *     last_success_at:  string (ISO 8601) | null,
 *     last_error:       { kind: "invalid_grant" | "rate_limited" | "other",
 *                         at:   string (ISO 8601) }
 *                       | null,
 *     rate_limited_until: string (ISO 8601) | null,
 *     authorized_at:      string (ISO 8601) | null,
 *     expires_at:         string (ISO 8601) | null,  // authorized_at + 180d
 *
 *     // Task #120 - daily Web API call budget (task 6/9). Always present.
 *     //   { used, cap, resets_at }  when either Redis or the in-process
 *     //                             fallback has data,
 *     //   null                      otherwise.
 *     budget: { used: number, cap: number, resets_at: string (ISO 8601) }
 *           | null,
 *   }
 *
 * GitHub / Duolingo entries (api_key / value kinds, unchanged):
 *   { key, name, auth_kind, connected: boolean, source: "admin"|"secrets"|null,
 *     authorized_at: string|null, expires_at: string|null }
 *
 * Never-5xx contract: every read (Postgres, Redis, in-process mirror) is
 * caught and degraded to the safe answer under a fixed precedence, so the
 * endpoint is safe to poll from the admin UI even during a Redis outage.
 * The legacy /api/admin/spotify/status endpoint returns the same Spotify
 * entry shape (minus the outer `integrations` wrapper), so admin code can
 * migrate at leisure.
 */
const adminIntegrationsRouter = express.Router();

function getSecrets(req: Request): IAppSecrets | undefined {
  return req.app.get("secrets") as IAppSecrets | undefined;
}

/** Where a connection's credential comes from. */
export type IntegrationSource = "admin" | "secrets";

export interface IntegrationStatus {
  key: string;
  name: string;
  auth_kind: AuthKind;
  connected: boolean;
  source: IntegrationSource | null;
  authorized_at: string | null;
  expires_at: string | null;
}

/**
 * Compute one integration's status. Admin-stored credentials are the only
 * grant source for every shipping integration, so the `secretsFallback` branch
 * is dead today but kept in the descriptor so a future one could opt in.
 * Never throws — the store degrades to null without a DB (§4.7).
 */
async function computeStatus(
  descriptor: IntegrationDescriptor,
  secrets: IAppSecrets | undefined
): Promise<IntegrationStatus> {
  const stored = await getStoredServiceToken(
    descriptor.key,
    resolveEncryptionKey(secrets)
  );

  if (stored) {
    const expiry = descriptor.expiresAt(stored.authorizedAt);
    return {
      key: descriptor.key,
      name: descriptor.display_name,
      auth_kind: descriptor.auth_kind,
      connected: true,
      source: "admin",
      authorized_at: stored.authorizedAt.toISOString(),
      expires_at: expiry ? expiry.toISOString() : null,
    };
  }

  if (secrets && descriptor.secretsFallback?.(secrets)) {
    return {
      key: descriptor.key,
      name: descriptor.display_name,
      auth_kind: descriptor.auth_kind,
      connected: true,
      source: "secrets",
      authorized_at: null,
      expires_at: null,
    };
  }

  return {
    key: descriptor.key,
    name: descriptor.display_name,
    auth_kind: descriptor.auth_kind,
    connected: false,
    source: null,
    authorized_at: null,
    expires_at: null,
  };
}

/**
 * GET /integrations — one status entry per descriptor. Same computation as the
 * §4.6 Spotify status, applied to every integration.
 */
adminIntegrationsRouter.get(
  "/integrations",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const secrets = getSecrets(req);
      const integrations = await Promise.all(
        INTEGRATION_DESCRIPTORS.map((d) => computeStatus(d, secrets))
      );
      res.status(200).json(success({ integrations }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * PUT /integrations/:key/value — store an admin-entered credential for the
 * api_key/value kinds (a PAT, a public username). Rejects oauth kinds with 409
 * (those use the connect/callback flow) and unknown keys with 404. The response
 * never echoes the stored value.
 */
adminIntegrationsRouter.put(
  "/integrations/:key/value",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const descriptor = getIntegrationDescriptor(req.params.key);
      if (!descriptor) {
        return res.status(404).json(failure("Unknown integration."));
      }
      if (descriptor.auth_kind === "oauth") {
        return res
          .status(409)
          .json(
            failure(
              `${descriptor.display_name} is connected via OAuth — use connect, not a value.`
            )
          );
      }

      const value = (req.body as { value?: unknown } | undefined)?.value;
      if (typeof value !== "string" || value.trim() === "") {
        return res
          .status(400)
          .json(failure("A non-empty `value` string is required."));
      }

      const secrets = getSecrets(req);
      await saveServiceToken(
        descriptor.key,
        resolveEncryptionKey(secrets),
        value.trim()
      );
      descriptor.onTokenChanged?.();

      // Respond with status only — never the value that was just stored.
      res.status(200).json(success(await computeStatus(descriptor, secrets)));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * DELETE /integrations/:key — remove the stored credential (any kind). 404 for
 * unknown keys.
 */
adminIntegrationsRouter.delete(
  "/integrations/:key",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const descriptor = getIntegrationDescriptor(req.params.key);
      if (!descriptor) {
        return res.status(404).json(failure("Unknown integration."));
      }
      const deleted = await deleteStoredServiceToken(descriptor.key);
      descriptor.onTokenChanged?.();
      res.status(200).json(success({ deleted }));
    } catch (err) {
      next(err as Error);
    }
  }
);

// ---- /api/admin/spotify/* — the admin-owned Spotify surface -----------------
// Now-playing is listener-only. The status endpoint reports which source is
// authoritative and the connect-listener's health; the credential itself (the
// `sp_dc` cookie) is managed by the listener PUT/DELETE endpoints below.

function getUpstream(req: Request): UpstreamHandle | null {
  const u = req.app.get("upstream") as UpstreamHandle | undefined;
  return u ?? null;
}

/**
 * GET /api/admin/spotify/status — the truthful listener status contract:
 * `source` ("listener" | "none") and the connect-listener's health.
 */
adminIntegrationsRouter.get(
  "/spotify/status",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await computeSpotifyStatus(
        getSecrets(req),
        getUpstream(req)
      );
      res.status(200).json(success(status));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * PUT /api/admin/integrations/spotify/listener, upsert the `sp_dc` Spotify
 * web-player session cookie the connect-listener uses (task series #115
 * through #123).
 *
 * The value is write-only: it is persisted encrypted in `service_tokens` under
 * key `spotify_listener` (§4.7) and is NEVER echoed back in a response, a
 * redirect, or a log line. Returns 204 on success, 400 on a missing/empty body.
 */
adminIntegrationsRouter.put(
  "/integrations/spotify/listener",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const spDc = (req.body as { sp_dc?: unknown } | undefined)?.sp_dc;
      if (typeof spDc !== "string" || spDc.trim() === "") {
        return res
          .status(400)
          .json(failure("A non-empty `sp_dc` string is required."));
      }

      const secrets = getSecrets(req);
      await saveListenerCredential(resolveEncryptionKey(secrets), spDc.trim());
      // 204, no body, no echo of the stored value.
      res.status(204).end();
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * DELETE /api/admin/integrations/spotify/listener, remove the stored `sp_dc`
 * cookie. Idempotent: 204 whether or not a row existed.
 */
adminIntegrationsRouter.delete(
  "/integrations/spotify/listener",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteListenerCredential();
      res.status(204).end();
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminIntegrationsRouter;
