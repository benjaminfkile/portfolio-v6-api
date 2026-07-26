import express, { Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { mintPreviewToken } from "../services/previewTokenService";
import { success } from "../utils/envelope";

/**
 * Admin auth router — the preview-token mint endpoint (TECH_SPEC_V1.md §4.2, §7).
 *
 * This is the only admin route wired in this task; the section/item/media/post
 * CRUD routers (tasks 438–441) mount later and attach `requireAdmin()` /
 * `requireAdminOrPreviewToken()` themselves.
 */
const adminAuthRouter = express.Router();

/**
 * POST /api/admin/preview-token — mint an opaque 15-minute read-only preview
 * token (§7). Behind requireAdmin(): only a real admin can create one.
 */
adminAuthRouter.post(
  "/preview-token",
  requireAdmin(),
  (_req: Request, res: Response) => {
    const minted = mintPreviewToken();
    res.status(201).json(
      success({
        token: minted.token,
        expiresAt: minted.expiresAt,
        expiresInMs: minted.expiresInMs,
      })
    );
  }
);

export default adminAuthRouter;
