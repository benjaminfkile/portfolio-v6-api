import express, { Request, Response, NextFunction } from "express";
import { requireAdmin, requireAdminOrPreviewToken } from "../middleware/requireAdmin";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  PublishFailureCode,
  PublishResult,
  publish,
  listVersions,
  restoreVersion,
  getDraftContent,
} from "../services/publishService";
import { runGcSafely } from "../services/mediaService";

/**
 * Admin publish router — TECH_SPEC_V1.md §4.2, §3.3, §7.
 *
 * Owns the snapshot-publishing endpoints: publish the working set, list version
 * history, restore an old version (re-publish + working-set rebuild), and the
 * draft preview. All routes are behind `requireAdmin()` except the preview route,
 * which is behind `requireAdminOrPreviewToken()` (§4.2 †, §7) so the public site
 * can serialize the draft inside its preview iframe with a short-lived token.
 * Business logic lives in `publishService`; this router maps `PublishResult`
 * failure codes to HTTP statuses and reads `req.adminSub` for attribution.
 */
const adminPublishRouter = express.Router();

function statusForCode(code: PublishFailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
    case "bad_request":
    default:
      return 400;
  }
}

function send<T>(res: Response, result: PublishResult<T>, okStatus = 200): Response {
  if (result.ok) {
    return res.status(okStatus).json(success(result.data));
  }
  return res.status(statusForCode(result.code)).json(failure(result.message));
}

function cdnDomain(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cdn_domain ?? "";
}

/**
 * POST /api/admin/publish (§4.2). Validates the entire working set (§3.9) and,
 * on success, snapshots it as a new version attributed to the authenticated
 * admin (`req.adminSub`). A validation failure returns 400 and refuses to
 * publish. No precondition — publish snapshots the current working set (§4.5).
 */
adminPublishRouter.post(
  "/publish",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await publish(req.adminSub ?? "unknown");
      // Version pruning is what creates most orphans, so a successful publish is
      // the natural GC trigger — run the sweep in the same request (§6.9). It is
      // fire-and-safe: a sweep failure must not fail an already-committed publish.
      if (result.ok) await runGcSafely();
      send(res, result, 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/** GET /api/admin/versions (§4.2) — version history, newest first. */
adminPublishRouter.get(
  "/versions",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(success({ versions: await listVersions() }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/versions/:v/restore (§4.2). Re-publishes version `v` as a new
 * version AND rebuilds the working set from it, in one transaction. A non-integer
 * `:v` is a 400; an unknown version is a 404.
 */
adminPublishRouter.post(
  "/versions/:v/restore",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const v = Number(req.params.v);
      if (!Number.isInteger(v)) {
        return res.status(400).json(failure("version must be an integer"));
      }
      const result = await restoreVersion(v, req.adminSub ?? "unknown");
      // Restore re-publishes and prunes versions, so it orphans media the same
      // way a plain publish does — sweep here too (§6.9).
      if (result.ok) await runGcSafely();
      send(res, result, 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * GET /api/admin/preview † (§4.2, §7). Serializes the DRAFT working set in
 * exactly the /api/content shape, with media resolved to CDN URLs. Behind
 * `requireAdminOrPreviewToken()` so the public preview iframe can reach it with a
 * preview token (the public bundle has no Cognito SDK, §2.1). Because the
 * consumer is the PUBLIC site's renderer, the body is raw like /api/content —
 * not the admin envelope (§4.1 vs §4.3).
 */
adminPublishRouter.get(
  "/preview",
  requireAdminOrPreviewToken(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(await getDraftContent(cdnDomain(req)));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminPublishRouter;
