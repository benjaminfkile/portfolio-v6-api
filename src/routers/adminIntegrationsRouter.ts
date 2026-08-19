import express, { NextFunction, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  consumeOAuthState,
  mintOAuthState,
} from "../services/spotifyOAuthService";
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
import { setSpotifyEnabled } from "../services/serviceSettingsStore";
import type { UpstreamHandle } from "../services/upstream";

/**
 * Admin integrations router (§4.7) — the generalized replacement for the §4.6
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
 * As in §4.6, the oauth callback CANNOT sit behind requireAdmin — it is a browser
 * redirect from the provider carrying no bearer token. It is guarded instead by
 * the single-use, 10-minute `state` minted at /connect (only a verified admin can
 * obtain one), so an anonymous hit can never cause a credential to be stored. No
 * token, code, secret, or stored value ever appears in a response, a redirect
 * URL, or a log line.
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
 * Compute one integration's status. Task #112 killed the static
 * `spotify_refresh_token` secrets fallback — admin-stored credentials are the
 * only grant source now, so the `secretsFallback` branch is dead for every
 * shipping integration but kept so a future one could opt in. Never throws —
 * the store degrades to null without a DB (§4.7).
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
      const upstream = getUpstream(req);
      const integrations = await Promise.all(
        INTEGRATION_DESCRIPTORS.map(async (d) => {
          // Spotify's entry carries the truthful 5-state contract (task #113)
          // — the same shape as GET /spotify/status — because the admin card
          // renders `state` directly; the presence-derived {connected,source}
          // shape remains for the credential kinds.
          if (d.key === SPOTIFY_KEY) {
            const status = await computeSpotifyStatus(secrets, upstream);
            return {
              key: d.key,
              name: d.display_name,
              auth_kind: d.auth_kind,
              ...status,
            };
          }
          return computeStatus(d, secrets);
        })
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
 * POST /integrations/:key/connect — begin an oauth flow: mint a single-use state
 * (carrying `return_to` server-side) and return the provider authorize URL. 404
 * for unknown keys, 409 for non-oauth kinds or unconfigured client credentials.
 */
async function handleConnect(
  descriptor: IntegrationDescriptor | undefined,
  req: Request,
  res: Response
): Promise<void> {
  if (!descriptor) {
    res.status(404).json(failure("Unknown integration."));
    return;
  }
  if (!descriptor.oauth) {
    res
      .status(409)
      .json(
        failure(
          `${descriptor.display_name} is not an OAuth integration — set its value instead.`
        )
      );
    return;
  }

  const secrets = getSecrets(req);
  const creds = secrets
    ? descriptor.oauth.resolveClientCredentials(secrets)
    : { clientId: "", clientSecret: "" };
  if (!creds.clientId || !creds.clientSecret) {
    res
      .status(409)
      .json(
        failure(
          `${descriptor.display_name} client credentials are not configured on the server.`
        )
      );
    return;
  }

  const returnTo = (req.body as { return_to?: unknown } | undefined)?.return_to;
  const state = await mintOAuthState(
    typeof returnTo === "string" ? returnTo : null
  );
  const authorizeUrl = descriptor.oauth.buildAuthorizeUrl(
    creds.clientId,
    descriptor.oauth.resolveRedirectUri(secrets as IAppSecrets),
    state
  );
  res.status(200).json(success({ authorize_url: authorizeUrl }));
}

adminIntegrationsRouter.post(
  "/integrations/:key/connect",
  requireAdmin(),
  (req: Request, res: Response, next: NextFunction) => {
    handleConnect(getIntegrationDescriptor(req.params.key), req, res).catch(
      (err) => next(err as Error)
    );
  }
);

/**
 * GET /integrations/:key/callback — the provider's redirect target. Consumes the
 * state, exchanges the code, and stores the (encrypted) credential. The browser
 * is redirected back with `?<key>=connected|error`, or shown a bare confirmation
 * when no return URL was captured.
 */
async function handleCallback(
  descriptor: IntegrationDescriptor | undefined,
  req: Request,
  res: Response
): Promise<void> {
  if (!descriptor || !descriptor.oauth) {
    return finishPlain(
      res,
      404,
      "This integration does not support an OAuth callback."
    );
  }
  const flag = descriptor.key;

  const { valid, returnTo } = await consumeOAuthState(
    typeof req.query.state === "string" ? req.query.state : null
  );
  if (!valid) {
    // No trusted return URL exists for an invalid state, so never redirect.
    return finishPlain(
      res,
      400,
      `This ${descriptor.display_name} authorization link is invalid or has ` +
        "expired. Start again from the admin Integrations page."
    );
  }

  if (typeof req.query.error === "string" && req.query.error) {
    console.error(
      `[adminIntegrationsRouter] ${descriptor.key} authorization denied/failed: ${req.query.error}`
    );
    return finishRedirect(res, returnTo, flag, "error", descriptor);
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const secrets = getSecrets(req);
  if (!code || !secrets) {
    return finishRedirect(res, returnTo, flag, "error", descriptor);
  }

  try {
    const creds = descriptor.oauth.resolveClientCredentials(secrets);
    const credential = await descriptor.oauth.exchangeCode(
      creds.clientId,
      creds.clientSecret,
      descriptor.oauth.resolveRedirectUri(secrets),
      code
    );
    await saveServiceToken(
      descriptor.key,
      resolveEncryptionKey(secrets),
      credential
    );
    // Drop any in-memory runtime state so the next request runs on the new
    // authorization (Spotify: its access token + ~30s cache).
    descriptor.onTokenChanged?.();
    return finishRedirect(res, returnTo, flag, "connected", descriptor);
  } catch (err) {
    console.error(
      `[adminIntegrationsRouter] ${descriptor.key} reconnect failed:`,
      err instanceof Error ? err.message : err
    );
    return finishRedirect(res, returnTo, flag, "error", descriptor);
  }
}

adminIntegrationsRouter.get(
  "/integrations/:key/callback",
  (req: Request, res: Response, next: NextFunction) => {
    handleCallback(getIntegrationDescriptor(req.params.key), req, res).catch(
      (err) => next(err as Error)
    );
  }
);

/**
 * DELETE /integrations/:key — remove the stored credential (any kind). 404 for
 * unknown keys. For an oauth integration with a static secrets fallback, that
 * fallback still applies afterwards (§4.6 Spotify degrade).
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

// ---- /api/admin/spotify/* — the admin-owned Spotify control surface ---------
// The admin panel builds against this surface (task #113). The status endpoint
// returns the truthful, precedence-derived contract; enable/disable/disconnect
// are humans-only writes that persist across instances (service_settings row
// or service_tokens delete). The legacy /spotify/connect|callback|DELETE
// endpoints are kept working so the currently-deployed admin keeps functioning
// during rollout.

const SPOTIFY_KEY = "spotify";

function getUpstream(req: Request): UpstreamHandle | null {
  const u = req.app.get("upstream") as UpstreamHandle | undefined;
  return u ?? null;
}

/**
 * GET /api/admin/spotify/status — the truthful status contract (task #113).
 * State precedence: disabled > disconnected > rate_limited > auth_broken >
 * connected. NEVER reports connected merely because credentials exist.
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
 * POST /api/admin/spotify/enable — clear the disabled flag. The poller resumes
 * on its next tick (using whatever grant is stored, or reporting disconnected).
 */
adminIntegrationsRouter.post(
  "/spotify/enable",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await setSpotifyEnabled(true);
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
 * POST /api/admin/spotify/disable — set the disabled flag. The poller makes
 * zero Spotify calls regardless of whether a stored grant exists.
 */
adminIntegrationsRouter.post(
  "/spotify/disable",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await setSpotifyEnabled(false);
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
 * POST /api/admin/spotify/disconnect — delete the stored grant. Idempotent;
 * returns the truthful post-write status (which will be `disconnected` unless
 * the disabled flag is also set).
 */
adminIntegrationsRouter.post(
  "/spotify/disconnect",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const descriptor = getIntegrationDescriptor(SPOTIFY_KEY)!;
      await deleteStoredServiceToken(descriptor.key);
      descriptor.onTokenChanged?.();
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

adminIntegrationsRouter.post(
  "/spotify/connect",
  requireAdmin(),
  (req: Request, res: Response, next: NextFunction) => {
    handleConnect(getIntegrationDescriptor(SPOTIFY_KEY), req, res).catch(
      (err) => next(err as Error)
    );
  }
);

adminIntegrationsRouter.get(
  "/spotify/callback",
  (req: Request, res: Response, next: NextFunction) => {
    handleCallback(getIntegrationDescriptor(SPOTIFY_KEY), req, res).catch((err) =>
      next(err as Error)
    );
  }
);

// Legacy DELETE /spotify — kept so the currently-deployed admin keeps working
// until it migrates to POST /spotify/disconnect. Behaviour is identical.
adminIntegrationsRouter.delete(
  "/spotify",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const descriptor = getIntegrationDescriptor(SPOTIFY_KEY)!;
      const deleted = await deleteStoredServiceToken(descriptor.key);
      descriptor.onTokenChanged?.();
      res.status(200).json(success({ deleted }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** Redirect back to the admin with a result flag, or fall back to plain text. */
function finishRedirect(
  res: Response,
  returnTo: string | null,
  flag: string,
  result: "connected" | "error",
  descriptor: IntegrationDescriptor
): void {
  if (returnTo) {
    // returnTo was validated as http(s) at mint time; the flag is set via the
    // URL API so an existing query string is extended, not clobbered.
    const url = new URL(returnTo);
    url.searchParams.set(flag, result);
    res.redirect(302, url.toString());
    return;
  }
  if (result === "connected") {
    finishPlain(
      res,
      200,
      `${descriptor.display_name} is connected. You can close this tab.`
    );
  } else {
    finishPlain(
      res,
      500,
      `Connecting ${descriptor.display_name} failed — check the API logs, then ` +
        "start again from the admin Integrations page."
    );
  }
}

function finishPlain(res: Response, status: number, message: string): void {
  res.status(status).type("text/plain").send(message);
}

export default adminIntegrationsRouter;
