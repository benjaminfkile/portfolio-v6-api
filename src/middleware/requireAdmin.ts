import { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyAdminIdToken } from "../aws/cognitoAuth";
import { isValidPreviewToken } from "../services/previewTokenService";
import { IAppSecrets } from "../interfaces";
import { failure } from "../utils/envelope";

// The verified admin's Cognito `sub` is attached to the request for handlers
// that want to attribute a write (§5.3). No `users` row is loaded — portfolio v6
// has a single class of user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminSub?: string;
    }
  }
}

/**
 * Header (case-insensitive) and query params the preview token is accepted on.
 *
 * DOCUMENTED CHOICE (§7): the primary transport is the `?token=<token>` query
 * param — it is what the public site's preview fetches send (`lib/api.ts`), kept
 * distinct from the public site's own `?preview=` page parameter. `?preview=` is
 * also accepted for tolerance, and the `X-Preview-Token` header for callers
 * (e.g. server-side fetches) that would rather not put the token in the URL.
 */
export const PREVIEW_TOKEN_QUERY_PARAMS = ["token", "preview"] as const;
export const PREVIEW_TOKEN_HEADER = "x-preview-token";

function getSecrets(req: Request): IAppSecrets | undefined {
  return req.app.get("secrets") as IAppSecrets | undefined;
}

function bearerToken(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

interface AdminAuthResult {
  ok: boolean;
  status?: 401 | 403;
  message?: string;
  sub?: string;
}

/**
 * Core admin check shared by both middlewares (§5.3): verify signature, expiry,
 * pool, and client via the Cognito verifier, then require `cognito:groups` to
 * include "admins". Returns a discriminated result rather than writing the
 * response, so `requireAdminOrPreviewToken` can compose it.
 *
 * - missing/invalid/expired token → 401
 * - valid token but not in "admins" → 403
 */
async function checkAdmin(req: Request): Promise<AdminAuthResult> {
  const token = bearerToken(req);
  if (!token) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const secrets = getSecrets(req);
  if (!secrets) {
    // Misconfiguration, not a client error — surface as 500 via the caller.
    throw new Error("App secrets are not configured on the app instance");
  }

  let payload;
  try {
    payload = await verifyAdminIdToken(
      token,
      secrets.cognito_user_pool_id,
      secrets.cognito_client_id
    );
  } catch {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const groups = (payload["cognito:groups"] as string[] | undefined) ?? [];
  if (!groups.includes("admins")) {
    return { ok: false, status: 403, message: "Forbidden" };
  }

  return { ok: true, sub: payload.sub };
}

/**
 * requireAdmin() — TECH_SPEC_V1.md §5.3. Guards every admin route except the two
 * preview-serialization routes (§4.2). On success attaches `req.adminSub` and
 * calls next(); otherwise responds 401 (missing/invalid) or 403 (wrong group).
 */
export function requireAdmin(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await checkAdmin(req);
      if (!result.ok) {
        return res
          .status(result.status as number)
          .json(failure(result.message as string));
      }
      req.adminSub = result.sub;
      next();
    } catch (err) {
      next(err as Error);
    }
  };
}

function extractPreviewToken(req: Request): string | undefined {
  const headerVal = req.headers[PREVIEW_TOKEN_HEADER];
  if (typeof headerVal === "string" && headerVal.length > 0) {
    return headerVal;
  }
  for (const param of PREVIEW_TOKEN_QUERY_PARAMS) {
    const queryVal = req.query[param];
    if (typeof queryVal === "string" && queryVal.length > 0) {
      return queryVal;
    }
  }
  return undefined;
}

/**
 * requireAdminOrPreviewToken() — TECH_SPEC_V1.md §4.2 / §7. Guards ONLY the two
 * read-only preview-serialization routes. Accepts EITHER a valid admin bearer
 * token OR a valid preview token, and grants read-only access.
 *
 * Resolution order:
 *  1. If an `Authorization: Bearer` header is present, run the full admin check
 *     (so an admin's browser is authorized the same way it is everywhere else,
 *     and a wrong-group admin token still yields 403).
 *  2. Otherwise, if a preview token is supplied (query param or header), accept
 *     the request iff it is valid and unexpired; an expired/unknown token is 401.
 *  3. Otherwise 401.
 *
 * The preview token authorizes exactly these routes — it is never checked by
 * `requireAdmin`, so it cannot reach any mutating endpoint (single-purpose scope).
 */
export function requireAdminOrPreviewToken(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Admin bearer path takes precedence when an Authorization header exists.
      if (bearerToken(req)) {
        const result = await checkAdmin(req);
        if (!result.ok) {
          return res
            .status(result.status as number)
            .json(failure(result.message as string));
        }
        req.adminSub = result.sub;
        return next();
      }

      // Preview-token path: read-only, opaque, 15-minute token (§7).
      const previewToken = extractPreviewToken(req);
      if (previewToken && isValidPreviewToken(previewToken)) {
        return next();
      }

      return res.status(401).json(failure("Unauthorized"));
    } catch (err) {
      next(err as Error);
    }
  };
}
