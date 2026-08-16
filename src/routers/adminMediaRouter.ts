import express, { Request, Response, NextFunction } from "express";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { success, failure } from "../utils/envelope";
import {
  MediaFailureCode,
  MediaResult,
  confirmUpload,
  createUploadUrl,
  deleteAsset,
  listAssets,
  runGc,
} from "../services/mediaService";

/**
 * Admin media router — TECH_SPEC_V1.md §4.2, §6.7, §6.9.
 *
 * Presigned uploads, confirm, the media library listing, hard delete, and the
 * on-demand GC sweep. Every route is behind `requireAdminOrMachine()` (API Keys
 * v1.16 — an AI editing agent needs the full media surface for debugging as well
 * as attaching post images). Business logic and all S3 access live in
 * `mediaService`/`s3Service`; this router only shapes the request/response
 * envelope and maps `MediaResult` failure codes to HTTP status.
 */
const adminMediaRouter = express.Router();

function statusForCode(code: MediaFailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
    case "bad_request":
    default:
      return 400;
  }
}

function send<T>(res: Response, result: MediaResult<T>, okStatus = 200): Response {
  if (result.ok) {
    return res.status(okStatus).json(success(result.data));
  }
  return res.status(statusForCode(result.code)).json(failure(result.message));
}

/**
 * POST /api/admin/media/upload-url (§6.7). Validates mime + size, returns a
 * presigned PUT (Cache-Control / Content-Type / `Tagging: state=pending` pinned
 * into the signature) and inserts a pending `media_assets` row.
 */
adminMediaRouter.post(
  "/media/upload-url",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, mime, size } = req.body ?? {};
      send(res, await createUploadUrl({ filename, mime, size }), 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/media/:id/confirm (§6.7). HEADs the object, records the true
 * size, drops the pending tag, and stamps `confirmed_at`.
 */
adminMediaRouter.post(
  "/media/:id/confirm",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await confirmUpload(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/media/sweep (§6.9). Runs the GC pass on demand and returns the
 * summary of what was orphaned, rescued, and deleted.
 */
adminMediaRouter.post(
  "/media/sweep",
  requireAdminOrMachine(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(success(await runGc()));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** GET /api/admin/media (§4.2) — all assets with orphan status + deletion date. */
adminMediaRouter.get(
  "/media",
  requireAdminOrMachine(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(success({ assets: await listAssets() }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** DELETE /api/admin/media/:id (§4.2) — hard delete: S3 object + row. */
adminMediaRouter.delete(
  "/media/:id",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deleteAsset(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminMediaRouter;
