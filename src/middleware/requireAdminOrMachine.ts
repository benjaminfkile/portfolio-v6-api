import { Request, Response, NextFunction, RequestHandler } from "express";
import { checkAdmin } from "./requireAdmin";
import { checkMachine } from "./machineAuth";
import { failure } from "../utils/envelope";

/**
 * requireAdminOrMachine() — Machine Auth v1.15. Guards the NARROW machine surface
 * (the posts admin CRUD + publish/unpublish, the post-image media routes, and the
 * read-only `GET /api/admin/blogs`). Everything else stays behind `requireAdmin`.
 *
 * Resolution order:
 *  1. Try the existing admin ID-token path VERBATIM (`checkAdmin`) — same 401/403
 *     semantics as `requireAdmin`. On success attach `req.adminSub` and proceed,
 *     so a human admin is authorized here exactly as everywhere else.
 *  2. If that fails AND `machine_client_id` is configured, classify the bearer as
 *     a Cognito client-credentials ACCESS token for the machine app client:
 *       - valid token WITH the required scope → attach `req.machineClient` and
 *         proceed;
 *       - valid token WITHOUT the scope → 403 (authenticated, not authorized);
 *       - anything else (no/invalid/expired token, or feature off) → fall back to
 *         the admin failure result, preserving its 401 (missing/invalid) or 403
 *         (wrong group). With the feature off this is identical to `requireAdmin`.
 *
 * The token is never logged. A machine principal reaching any OTHER admin route
 * is denied there by `requireAdmin` (403), so this middleware is the only place a
 * machine token can succeed.
 */
export function requireAdminOrMachine(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminResult = await checkAdmin(req);
      if (adminResult.ok) {
        req.adminSub = adminResult.sub;
        return next();
      }

      const machine = await checkMachine(req);
      if (machine.status === "valid") {
        if (!machine.hasScope) {
          return res.status(403).json(failure("Forbidden"));
        }
        req.machineClient = machine.clientId;
        return next();
      }

      // Feature off, or the bearer is not a valid machine token: preserve the
      // admin path's outcome (401 missing/invalid signature, 403 wrong group).
      return res
        .status(adminResult.status as number)
        .json(failure(adminResult.message as string));
    } catch (err) {
      next(err as Error);
    }
  };
}
