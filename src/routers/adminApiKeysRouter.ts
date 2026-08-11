import express, { Request, Response, NextFunction } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { success, failure } from "../utils/envelope";
import {
  ApiKeyFailureCode,
  ApiKeyResult,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
} from "../services/apiKeysService";

/**
 * Admin API-keys router — API Keys v1.16. Humans only: every route is behind the
 * plain `requireAdmin()` (an API key can never mint or revoke another key — the
 * key-management surface stays admin-only), and every response uses the §4.3
 * envelope.
 *
 *  - POST /api/admin/api-keys           mint a key — 201, returns the FULL `key`
 *                                       in this response ONLY (never again).
 *  - GET  /api/admin/api-keys           list keys, newest first, no secrets ever.
 *  - POST /api/admin/api-keys/:id/revoke  revoke (idempotent; unknown id → 404).
 */
const adminApiKeysRouter = express.Router();

function statusForCode(code: ApiKeyFailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
    default:
      return 400;
  }
}

function send<T>(res: Response, result: ApiKeyResult<T>, okStatus = 200): Response {
  if (result.ok) {
    return res.status(okStatus).json(success(result.data));
  }
  return res.status(statusForCode(result.code)).json(failure(result.message));
}

/**
 * POST /api/admin/api-keys — mint a key. The success body carries the full `key`,
 * which is returned here and NEVER again (only its hash + display prefix persist).
 */
adminApiKeysRouter.post(
  "/api-keys",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await mintApiKey(req.body ?? {}), 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/** GET /api/admin/api-keys — all keys, newest first; never any hash or full key. */
adminApiKeysRouter.get(
  "/api-keys",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(success(await listApiKeys()));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** POST /api/admin/api-keys/:id/revoke — idempotent revoke; unknown id → 404. */
adminApiKeysRouter.post(
  "/api-keys/:id/revoke",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await revokeApiKey(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminApiKeysRouter;
