import express, { Request, Response, NextFunction } from "express";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { success, failure } from "../utils/envelope";
import { FailureCode, ServiceResult } from "../services/sectionsService";
import {
  createPage,
  deletePage,
  listPages,
  reorderPages,
  updatePage,
} from "../services/pagesService";

/**
 * Admin pages router — TECH_SPEC_V1.md §4.2 (the v1.1 pages rows), §4.5
 * (optimistic concurrency), §3.10 (pages model). Mirrors `adminSectionsRouter`:
 * every route behind `requireAdminOrMachine()` (API Keys v1.16 — an AI editing
 * agent needs to touch pages the same way an admin does), all logic in
 * `pagesService`, and the service's `ServiceResult` failure codes mapped to HTTP
 * statuses here.
 */
const adminPagesRouter = express.Router();

// ---- HTTP mapping helpers (identical contract to adminSectionsRouter) --------

function statusForCode(code: FailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "validation":
    case "bad_request":
    default:
      return 400;
  }
}

function send<T>(res: Response, result: ServiceResult<T>, okStatus = 200): Response {
  if (result.ok) {
    return res.status(okStatus).json(success(result.data));
  }
  return res.status(statusForCode(result.code)).json(failure(result.message));
}

/**
 * Read the required `expected_updated_at` precondition from a PATCH body (§4.5) —
 * REQUIRED, so a missing/blank value is a 400 before any write.
 */
function requireExpectedUpdatedAt(req: Request, res: Response): string | null {
  const value = req.body?.expected_updated_at;
  if (typeof value !== "string" || value.trim().length === 0) {
    res.status(400).json(failure("expected_updated_at is required"));
    return null;
  }
  return value;
}

/** Accept the reorder payload as a bare array or `{ order: [...] }` / `{ ids }`. */
function extractOrder(body: unknown): unknown {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as { order?: unknown; ids?: unknown };
    return b.order !== undefined ? b.order : b.ids;
  }
  return undefined;
}

// ---- Routes -----------------------------------------------------------------

/** GET /api/admin/pages — all pages ordered by nav_position (§4.2). */
adminPagesRouter.get(
  "/pages",
  requireAdminOrMachine(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const pages = await listPages();
      res.status(200).json(success({ pages }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** POST /api/admin/pages — create a page (slug validated, reserved list). */
adminPagesRouter.post(
  "/pages",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug, title, nav_label, nav_position } = req.body ?? {};
      send(res, await createPage({ slug, title, nav_label, nav_position }), 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * PUT /api/admin/pages/order — full-array nav reorder (§4.2). Literal path
 * registered before `/pages/:id` (different method, kept explicit). Exempt from
 * the precondition (§4.5).
 */
adminPagesRouter.put(
  "/pages/order",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await reorderPages(extractOrder(req.body)));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** PATCH /api/admin/pages/:id — update metadata (precondition, §4.5). */
adminPagesRouter.patch(
  "/pages/:id",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expected = requireExpectedUpdatedAt(req, res);
      if (expected === null) return;
      const { slug, title, nav_label, nav_position, is_hidden } = req.body ?? {};
      send(
        res,
        await updatePage(req.params.id, {
          expected_updated_at: expected,
          slug,
          title,
          nav_label,
          nav_position,
          is_hidden,
        })
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** DELETE /api/admin/pages/:id — delete page + its sections (cascade, §3.10). */
adminPagesRouter.delete(
  "/pages/:id",
  requireAdminOrMachine(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deletePage(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminPagesRouter;
