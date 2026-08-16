import express, { Request, Response, NextFunction } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { success, failure } from "../utils/envelope";
import { FailureCode, ServiceResult } from "../services/sectionsService";
import {
  createBlog,
  deleteBlog,
  listBlogs,
  updateBlog,
} from "../services/blogsService";

/**
 * Admin blogs router — Blogs v1.13. Mirrors `adminPagesRouter`: all logic in
 * `blogsService`, and the service's `ServiceResult` failure codes mapped to HTTP
 * statuses here (§4.3 envelope). Every route is behind `requireAdmin()` EXCEPT the
 * read-only `GET /blogs`, which is behind `requireAdminOrMachine()` (API Keys
 * v1.16) so the posting bot can resolve a `blog_id` with its API key.
 */
const adminBlogsRouter = express.Router();

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

// ---- Routes -----------------------------------------------------------------

/**
 * GET /api/admin/blogs — all blogs (with post_count) ordered by name. Behind
 * `requireAdminOrMachine()` (API Keys v1.16): read-only, so a machine key can
 * resolve a `blog_id` when creating a post. The write routes below stay
 * admin-only, so a pv6k_ bearer gets 401 on POST/PATCH/DELETE (it is not a
 * valid Cognito ID token).
 */
adminBlogsRouter.get(
  "/blogs",
  requireAdminOrMachine(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(success({ blogs: await listBlogs() }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** POST /api/admin/blogs — create a blog (409 on duplicate slug). */
adminBlogsRouter.post(
  "/blogs",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug, name } = req.body ?? {};
      send(res, await createBlog({ slug, name }), 201);
    } catch (err) {
      next(err as Error);
    }
  }
);

/** PATCH /api/admin/blogs/:id — update slug/name (precondition, §4.5). */
adminBlogsRouter.patch(
  "/blogs/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expected = requireExpectedUpdatedAt(req, res);
      if (expected === null) return;
      const { slug, name } = req.body ?? {};
      send(
        res,
        await updateBlog(req.params.id, {
          expected_updated_at: expected,
          slug,
          name,
        })
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** DELETE /api/admin/blogs/:id — always allowed; assigned posts get blog_id NULL. */
adminBlogsRouter.delete(
  "/blogs/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deleteBlog(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminBlogsRouter;
