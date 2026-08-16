import { Request, Response, NextFunction, RequestHandler } from "express";
import { checkAdmin, bearerToken } from "./requireAdmin";
import {
  API_KEY_PREFIX,
  touchApiKeyLastUsed,
  verifyApiKey,
} from "../services/apiKeysService";
import { failure } from "../utils/envelope";

/**
 * The principal a dashboard-minted API key authenticates as (API Keys v1.16). The
 * key's id and name are attached to the request so the publish handler can
 * attribute a key-driven publish as `key:<name>` (§ contract 4/5). The key itself
 * is never attached or logged.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyId?: string;
      apiKeyName?: string;
    }
  }
}

/**
 * requireAdminOrMachine() — API Keys v1.16. Guards the full content-editing
 * surface reachable by an AI editing agent: pages, sections/items, posts,
 * blogs, media, publish/versions/restore, preview-token, analytics, and icons.
 * The humans-only surface — `/api/admin/api-keys/*` and
 * `/api/admin/integrations/*` (plus the legacy `/api/admin/spotify/*` aliases)
 * — stays behind `requireAdmin` so a key can never mint another key or read/
 * write stored credentials.
 *
 * Resolution order:
 *  1. Try the existing admin ID-token path VERBATIM (`checkAdmin`) — same 401/403
 *     semantics as `requireAdmin`. On success attach `req.adminSub` and proceed,
 *     so a human admin is authorized here exactly as everywhere else.
 *  2. If that fails AND the bearer is a `pv6k_` API key, authenticate it against
 *     the `api_keys` table (hash lookup by the unique index; the key is never
 *     compared raw and never logged):
 *       - an ACTIVE (unrevoked) key → attach `req.apiKeyId` / `req.apiKeyName`,
 *         fire-and-forget stamp `last_used_at` (a failed touch never fails the
 *         request), and proceed;
 *       - a revoked or unknown `pv6k_` key → 401.
 *  3. Otherwise (no bearer, or a non-`pv6k_` bearer that failed the admin check)
 *     fall back to the admin failure result, preserving its 401 (missing/invalid)
 *     or 403 (wrong group).
 *
 * A key principal reaching any humans-only admin route (api-keys, integrations,
 * legacy spotify aliases) is denied there by `requireAdmin` (a `pv6k_` bearer is
 * not a valid admin ID token → 401), so this middleware is the only place an
 * API key can succeed.
 */
export function requireAdminOrMachine(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminResult = await checkAdmin(req);
      if (adminResult.ok) {
        req.adminSub = adminResult.sub;
        return next();
      }

      const token = bearerToken(req);
      if (token && token.startsWith(API_KEY_PREFIX)) {
        const principal = await verifyApiKey(token);
        if (principal) {
          req.apiKeyId = principal.id;
          req.apiKeyName = principal.name;
          // Fire-and-forget: a failed touch must never fail the request.
          touchApiKeyLastUsed(principal.id);
          return next();
        }
        // A `pv6k_` bearer that matches no active key: revoked or unknown → 401.
        return res.status(401).json(failure("Unauthorized"));
      }

      // Not an API key: preserve the admin path's outcome (401 missing/invalid
      // signature, 403 wrong group).
      return res
        .status(adminResult.status as number)
        .json(failure(adminResult.message as string));
    } catch (err) {
      next(err as Error);
    }
  };
}
