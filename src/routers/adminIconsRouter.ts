import express, { Request, Response, NextFunction } from "express";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  IconFailureCode,
  IconResult,
  getDeviconManifest,
  getSimpleIconsManifest,
  importIcon,
  importSimpleIcon,
} from "../services/iconsService";

/**
 * Admin icons router — §Icons v1.6 (task #532), §4.3 envelopes.
 *
 *   - GET  /api/admin/icons/devicon-manifest → the pinned, cached, slimmed
 *     devicon manifest.
 *   - GET  /api/admin/icons/simpleicons-manifest → same for simple-icons.
 *   - POST /api/admin/icons/import { name, variant } → downloads the pinned SVG
 *     server-side, stores it under the `icons/` prefix in the existing media S3
 *     bucket, and returns its media-CDN URL. Deterministic key + idempotent.
 *
 * Every route is behind `requireAdminOrMachine()` (API Keys v1.16 — an AI editing
 * agent needs to import icons for the pages it builds, same as an admin). All
 * upstream fetch + S3 logic lives in `iconsService`/`s3Service`; this router only
 * shapes the envelope and maps `IconResult` failure codes to HTTP status.
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
  requireAdminOrMachine(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await getDeviconManifest());
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * GET /api/admin/icons/simpleicons-manifest (§Icons v1.6.1). Serves the pinned
 * simple-icons catalog, slimmed to `{ version, icons: [{ slug, title }] }` and
 * cached ~24h. Mirror of the devicon manifest endpoint. Upstream failure → 502.
 */
adminIconsRouter.get(
  "/icons/simpleicons-manifest",
  requireAdminOrMachine(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await getSimpleIconsManifest());
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/icons/import (§Icons v1.6 / v1.6.1). Two body shapes:
 *
 *   - `{ name, variant }` — the devicon import (unchanged): validate against the
 *     devicon manifest, download the pinned SVG, store under `icons/devicon/`.
 *   - `{ source: 'simpleicons', slug, color }` — the tinted simple-icons import:
 *     validate slug against the pinned catalog + color by regex, download the
 *     tinted SVG from cdn.simpleicons.org, store under `icons/simpleicons/`.
 *
 * Both are idempotent (deterministic key → existing object returns its URL) and
 * return `{ url }` (a media-CDN URL).
 */
adminIconsRouter.post(
  "/icons/import",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body ?? {};
      if (body.source === "simpleicons") {
        const { slug, color } = body;
        send(res, await importSimpleIcon({ slug, color }, cdnDomain(req)));
        return;
      }
      const { name, variant } = body;
      send(res, await importIcon({ name, variant }, cdnDomain(req)));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminIconsRouter;
