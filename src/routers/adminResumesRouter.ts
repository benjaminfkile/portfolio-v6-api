import express, { Request, Response, NextFunction } from "express";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  ResumeFailureCode,
  ResumeResult,
  confirmResumeUpload,
  createResumeUploadUrl,
  deleteResume,
  listResumes,
} from "../services/resumesService";

/**
 * Admin resumes router — task #92.
 *
 * Presigned uploads, confirm, the resume version list, and hard delete. Every
 * route is behind `requireAdminOrMachine()` (API Keys v1.16 — the AI editing
 * agent needs the resume surface the same way it needs the media surface).
 * Business logic and all S3 access live in `resumesService` / `s3Service`;
 * this router only shapes the request/response envelope and maps
 * `ResumeResult` failure codes to HTTP status.
 */
const adminResumesRouter = express.Router();

function statusForCode(code: ResumeFailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
    case "bad_request":
    default:
      return 400;
  }
}

function send<T>(res: Response, result: ResumeResult<T>, okStatus = 200): Response {
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
 * Attribution for the uploaded_by column (mirrors publishService's actor
 * resolution): admin sub for a human admin, `key:<name>` for a key-driven
 * upload; falls back to `"unknown"` so the NOT NULL column always has a value.
 */
function uploadedBy(req: Request): string {
  if (req.adminSub) return req.adminSub;
  if (req.apiKeyName) return `key:${req.apiKeyName}`;
  return "unknown";
}

/**
 * POST /api/admin/resumes/upload-url (task #92). Validates the filename (.pdf)
 * and size (≤ 10 MB), returns a presigned PUT (Content-Type application/pdf
 * pinned into the signature), and inserts a pending `resumes` row.
 */
adminResumesRouter.post(
  "/resumes/upload-url",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, size } = req.body ?? {};
      send(
        res,
        await createResumeUploadUrl({ filename, size }, uploadedBy(req)),
        201
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/resumes/:id/confirm (task #92). HEADs the object, records
 * the true size, and stamps `confirmed_at`.
 */
adminResumesRouter.post(
  "/resumes/:id/confirm",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await confirmResumeUpload(req.params.id, cdnDomain(req)));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** GET /api/admin/resumes (task #92) — all versions, newest first. */
adminResumesRouter.get(
  "/resumes",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res
        .status(200)
        .json(success({ resumes: await listResumes(cdnDomain(req)) }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * DELETE /api/admin/resumes/:id (task #92) — hard delete: S3 object + row. If
 * this was the newest confirmed version, the next-newest confirmed version is
 * promoted to /api/resume simply by being the next hit on the lookup.
 */
adminResumesRouter.delete(
  "/resumes/:id",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deleteResume(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminResumesRouter;
