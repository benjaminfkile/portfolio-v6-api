import express, { Request, Response } from "express";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { mintPreviewToken } from "../services/previewTokenService";
import { success } from "../utils/envelope";

/**
 * Admin auth router — the preview-token mint endpoint (TECH_SPEC_V1.md §4.2, §7).
 *
 * Behind `requireAdminOrMachine()` (API Keys v1.16): an AI editing agent needs to
 * mint a preview token to preview its drafts, the same way an admin does.
 */
const adminAuthRouter = express.Router();

/**
 * POST /api/admin/preview-token — mint an opaque 15-minute read-only preview
 * token (§7). Behind requireAdminOrMachine(): admins and machine keys can both
 * mint a preview token to serialize a draft.
 */
adminAuthRouter.post(
  "/preview-token",
  requireAdminOrMachine(),
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
