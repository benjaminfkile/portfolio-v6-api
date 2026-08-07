import express, { Request, Response, NextFunction } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  IconFailureCode,
  IconResult,
  getDeviconManifest,
  importIcon,
} from "../services/iconsService";

/**
 * Admin icons router — §Icons v1.6 (task #532), §4.3 envelopes.
 *
 *   - GET  /api/admin/icons/devicon-manifest → the pinned, cached, slimmed
 *     devicon manifest.
 *   - POST /api/admin/icons/import { name, variant } → downloads the pinned SVG
 *     server-side, stores it under the `icons/` prefix in the existing media S3
 *     bucket, and returns its media-CDN URL. Deterministic key + idempotent.
 *
 * Every route is behind `requireAdmin()`. All upstream fetch + S3 logic lives in
 * `iconsService`/`s3Service`; this router only shapes the envelope and maps
 * `IconResult` failure codes to HTTP status.
 */
const adminIconsRouter = express.Router();

function statusForCode(code: IconFailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "upstream":
      // Upstream CDN failure — the request was fine, the dependency was not.
      return 502;
    case "validation":
    case "bad_request":
    default:
      return 400;
  }
}

function send<T>(res: Response, result: IconResult<T>, okStatus = 200): Response {
  if (result.ok) {
    return res.status(okStatus).json(success(result.data));
  }
  return res.status(statusForCode(result.code)).json(failure(result.message));
}

/** The media-CDN base domain (§6.8), resolved from the app's loaded secrets. */
function cdnDomain(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cdn_domain ?? "";
}

/**
 * GET /api/admin/icons/devicon-manifest (§Icons v1.6). Serves the pinned devicon
 * manifest, slimmed to `{ version, icons: [{ name, altnames, tags, versions,
 * color }] }` and cached ~24h. An upstream failure is a 502 with a clear message.
 */
adminIconsRouter.get(
  "/icons/devicon-manifest",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await getDeviconManifest());
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/icons/import (§Icons v1.6). Validates `{ name, variant }`
 * against the manifest, downloads the pinned SVG server-side, stores it under the
 * `icons/` prefix (image/svg+xml, long-lived cache), and returns `{ url }`.
 * Idempotent: an already-imported icon returns its URL without re-uploading.
 */
adminIconsRouter.post(
  "/icons/import",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, variant } = req.body ?? {};
      send(res, await importIcon({ name, variant }, cdnDomain(req)));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminIconsRouter;
