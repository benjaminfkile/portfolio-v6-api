import express, { Request, Response, NextFunction } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { success, failure } from "../utils/envelope";
import {
  FailureCode,
  ServiceResult,
  createItem,
  createSection,
  deleteItem,
  deleteSection,
  getWorkingSet,
  reorderItems,
  reorderSections,
  updateItem,
  updateSection,
} from "../services/sectionsService";

/**
 * Admin sections & items router — TECH_SPEC_V1.md §4.2 (the sections/items rows
 * of the admin table), §4.5 (optimistic concurrency), §3.9 (Zod validation).
 *
 * Every route is behind `requireAdmin()`. Business logic and DB access live in
 * `sectionsService`; this router only parses/validates the request envelope,
 * enforces the `expected_updated_at` precondition's *presence* on PATCH routes,
 * and maps the service's `ServiceResult` failure codes to HTTP statuses.
 */
const adminSectionsRouter = express.Router();

// ---- HTTP mapping helpers ---------------------------------------------------

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

/** Send a `ServiceResult`: 200 + envelope on success, mapped status on failure. */
function send<T>(res: Response, result: ServiceResult<T>, okStatus = 200): Response {
  if (result.ok) {
    return res.status(okStatus).json(success(result.data));
  }
  return res.status(statusForCode(result.code)).json(failure(result.message));
}

/**
 * Read the required `expected_updated_at` precondition from a PATCH body (§4.5).
 * The field is REQUIRED, not optional — an unconditional overwrite must be
 * impossible to express — so a missing/blank value is a 400 before any write.
 */
function requireExpectedUpdatedAt(req: Request, res: Response): string | null {
  const value = req.body?.expected_updated_at;
  if (typeof value !== "string" || value.trim().length === 0) {
    res.status(400).json(failure("expected_updated_at is required"));
    return null;
  }
  return value;
}

/** Accept the reorder payload as either a bare array or `{ order: [...] }`. */
function extractOrder(body: unknown): unknown {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    return (body as { order?: unknown }).order;
  }
  return undefined;
}

// ---- Sections ---------------------------------------------------------------

/** GET /api/admin/sections — full working set, drafts included, items nested. */
adminSectionsRouter.get(
  "/sections",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const sections = await getWorkingSet();
      res.status(200).json(success({ sections }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** POST /api/admin/sections — create a section. */
adminSectionsRouter.post(
  "/sections",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, data, is_hidden } = req.body ?? {};
      send(res, await createSection({ type, data, is_hidden }), 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * PUT /api/admin/sections/order — full-array reorder (§4.2). Registered with a
 * literal path so it is never shadowed by `/sections/:id` (different method, but
 * kept explicit for clarity). Exempt from the precondition (§4.5).
 */
adminSectionsRouter.put(
  "/sections/order",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await reorderSections(extractOrder(req.body) as string[]));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** PATCH /api/admin/sections/:id — update data / is_hidden (precondition). */
adminSectionsRouter.patch(
  "/sections/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expected = requireExpectedUpdatedAt(req, res);
      if (expected === null) return;
      const { data, is_hidden } = req.body ?? {};
      send(
        res,
        await updateSection(req.params.id, {
          expected_updated_at: expected,
          data,
          is_hidden,
        })
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** DELETE /api/admin/sections/:id — delete (cascades to items). */
adminSectionsRouter.delete(
  "/sections/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deleteSection(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

// ---- Items ------------------------------------------------------------------

/** POST /api/admin/sections/:id/items — create an item. */
adminSectionsRouter.post(
  "/sections/:id/items",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { data, is_hidden } = req.body ?? {};
      send(res, await createItem(req.params.id, { data, is_hidden }), 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/** PUT /api/admin/sections/:id/items/order — reorder a section's items. */
adminSectionsRouter.put(
  "/sections/:id/items/order",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(
        res,
        await reorderItems(req.params.id, extractOrder(req.body) as string[])
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** PATCH /api/admin/items/:id — update an item (precondition). */
adminSectionsRouter.patch(
  "/items/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expected = requireExpectedUpdatedAt(req, res);
      if (expected === null) return;
      const { data, is_hidden } = req.body ?? {};
      send(
        res,
        await updateItem(req.params.id, {
          expected_updated_at: expected,
          data,
          is_hidden,
        })
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** DELETE /api/admin/items/:id — delete an item. */
adminSectionsRouter.delete(
  "/items/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deleteItem(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminSectionsRouter;
