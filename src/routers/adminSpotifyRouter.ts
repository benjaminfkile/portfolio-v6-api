import express, { NextFunction, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  buildAuthorizeUrl,
  consumeOAuthState,
  exchangeCodeForRefreshToken,
  mintOAuthState,
  resolveRedirectUri,
} from "../services/spotifyOAuthService";
import {
  deleteStoredSpotifyToken,
  getStoredSpotifyToken,
  saveSpotifyRefreshToken,
  SPOTIFY_REFRESH_TOKEN_LIFETIME_MS,
} from "../services/spotifyTokenStore";
import { clearSpotifyRuntimeState } from "../services/spotifyService";

/**
 * Admin Spotify reconnect flow (§4.6) — the twice-a-year re-authorization that
 * Spotify's 180-day refresh-token expiry (June 2026 policy) forces.
 *
 * Routes:
 *   GET    /api/admin/spotify/status    (admin)  connection status + expiry
 *   POST   /api/admin/spotify/connect   (admin)  mint state, return authorize URL
 *   GET    /api/admin/spotify/callback  (state)  Spotify redirect target
 *   DELETE /api/admin/spotify           (admin)  remove the stored token
 *
 * The callback CANNOT sit behind requireAdmin — it is a browser redirect from
 * Spotify carrying no bearer token. It is guarded instead by the single-use,
 * 10-minute `state` minted at /connect, which only a verified admin can obtain,
 * so an anonymous hit can never cause a token to be stored. No token, code, or
 * secret ever appears in a response, a redirect URL, or a log line.
 */
const adminSpotifyRouter = express.Router();

function getSecrets(req: Request): IAppSecrets | undefined {
  return req.app.get("secrets") as IAppSecrets | undefined;
}

/** Where the connection's refresh token comes from. */
export type SpotifyTokenSource = "admin" | "secrets";

export interface SpotifyStatusPayload {
  connected: boolean;
  /** "admin" = stored via this flow; "secrets" = the static bootstrap secret. */
  source: SpotifyTokenSource | null;
  /** Known only for admin-connected tokens (the secret's age is untracked). */
  authorized_at: string | null;
  expires_at: string | null;
}

/**
 * GET /spotify/status — whether now-playing has a refresh token and when the
 * 180-day window ends. An admin-stored token wins over the secrets fallback,
 * mirroring the resolution order in nowPlayingRouter.
 */
adminSpotifyRouter.get(
  "/spotify/status",
  requireAdmin(),
  async (req: Request, res: Response) => {
    const secrets = getSecrets(req);
    const stored = await getStoredSpotifyToken(
      secrets?.spotify_client_secret ?? ""
    );

    let payload: SpotifyStatusPayload;
    if (stored) {
      payload = {
        connected: true,
        source: "admin",
        authorized_at: stored.authorizedAt.toISOString(),
        expires_at: new Date(
          stored.authorizedAt.getTime() + SPOTIFY_REFRESH_TOKEN_LIFETIME_MS
        ).toISOString(),
      };
    } else if (secrets?.spotify_refresh_token) {
      payload = {
        connected: true,
        source: "secrets",
        authorized_at: null,
        expires_at: null,
      };
    } else {
      payload = {
        connected: false,
        source: null,
        authorized_at: null,
        expires_at: null,
      };
    }
    res.status(200).json(success(payload));
  }
);

/**
 * POST /spotify/connect — mint a single-use state and return the Spotify
 * authorize URL for the browser to navigate to. `return_to` (the admin page to
 * land back on) rides along in the server-side state entry, never in the URL.
 */
adminSpotifyRouter.post(
  "/spotify/connect",
  requireAdmin(),
  (req: Request, res: Response) => {
    const secrets = getSecrets(req);
    if (!secrets?.spotify_client_id || !secrets.spotify_client_secret) {
      return res
        .status(409)
        .json(
          failure(
            "Spotify client credentials are not configured on the server."
          )
        );
    }

    const returnTo = (req.body as { return_to?: unknown } | undefined)
      ?.return_to;
    const state = mintOAuthState(
      typeof returnTo === "string" ? returnTo : null
    );
    const authorizeUrl = buildAuthorizeUrl(
      secrets.spotify_client_id,
      resolveRedirectUri(secrets),
      state
    );
    res.status(200).json(success({ authorize_url: authorizeUrl }));
  }
);

/**
 * GET /spotify/callback — Spotify's redirect target. Consumes the state, then
 * exchanges the code and stores the (encrypted) refresh token. The browser is
 * sent back to the admin page with `?spotify=connected|error`, or shown a bare
 * confirmation when no return URL was captured.
 */
adminSpotifyRouter.get(
  "/spotify/callback",
  async (req: Request, res: Response) => {
    const { valid, returnTo } = consumeOAuthState(
      typeof req.query.state === "string" ? req.query.state : null
    );
    if (!valid) {
      // No trusted return URL exists for an invalid state, so never redirect.
      return finishPlain(
        res,
        400,
        "This Spotify authorization link is invalid or has expired. " +
          "Start again from the admin Integrations page."
      );
    }

    if (typeof req.query.error === "string" && req.query.error) {
      console.error(
        `[adminSpotifyRouter] authorization denied/failed: ${req.query.error}`
      );
      return finishRedirect(res, returnTo, "error");
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const secrets = getSecrets(req);
    if (!code || !secrets) {
      return finishRedirect(res, returnTo, "error");
    }

    try {
      const refreshToken = await exchangeCodeForRefreshToken(
        secrets.spotify_client_id,
        secrets.spotify_client_secret,
        resolveRedirectUri(secrets),
        code
      );
      await saveSpotifyRefreshToken(
        secrets.spotify_client_secret,
        refreshToken
      );
      // Drop the old access token and the ~30s cache so the very next
      // /api/now-playing request runs on the new authorization.
      clearSpotifyRuntimeState();
      return finishRedirect(res, returnTo, "connected");
    } catch (err) {
      console.error(
        "[adminSpotifyRouter] reconnect failed:",
        err instanceof Error ? err.message : err
      );
      return finishRedirect(res, returnTo, "error");
    }
  }
);

/**
 * DELETE /spotify — remove the admin-stored token. Now-playing falls back to
 * the `spotify_refresh_token` secret if one is configured, else goes idle.
 */
adminSpotifyRouter.delete(
  "/spotify",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await deleteStoredSpotifyToken();
      clearSpotifyRuntimeState();
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
  result: "connected" | "error"
): void {
  if (returnTo) {
    // returnTo was validated as http(s) at mint time; the flag is set via the
    // URL API so an existing query string is extended, not clobbered.
    const url = new URL(returnTo);
    url.searchParams.set("spotify", result);
    res.redirect(302, url.toString());
    return;
  }
  if (result === "connected") {
    finishPlain(
      res,
      200,
      "Spotify is connected. Now-playing will use the new authorization. " +
        "You can close this tab."
    );
  } else {
    finishPlain(
      res,
      500,
      "Connecting Spotify failed — check the API logs, then start again " +
        "from the admin Integrations page."
    );
  }
}

function finishPlain(res: Response, status: number, message: string): void {
  res.status(status).type("text/plain").send(message);
}

export default adminSpotifyRouter;
