import express, { Request, Response, NextFunction } from "express";
import {
  requireAdmin,
  requireAdminOrPreviewToken,
} from "../middleware/requireAdmin";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import { runGcSafely } from "../services/mediaService";
import {
  PostFailureCode,
  PostResult,
  createPost,
  deletePost,
  getAdminPost,
  getDraftPostPreview,
  listAdminPosts,
  publishPost,
  unpublishPost,
  updatePost,
} from "../services/postsService";

/**
 * Admin posts router — TECH_SPEC_V1.md §4.2, §4.5, §3.6, §3.7, §7.
 *
 * The blog CRUD + publish lifecycle. Every route is behind `requireAdmin()`
 * except the draft-preview route, which is behind `requireAdminOrPreviewToken()`
 * (§4.2 †, §7) so the public site can serialize a post's draft body inside its
 * preview iframe. Business logic lives in `postsService`; this router parses the
 * request, enforces the `expected_updated_at` precondition's presence on PATCH
 * (§4.5), and maps `PostResult` failure codes to HTTP statuses.
 */
const adminPostsRouter = express.Router();

function statusForCode(code: PostFailureCode): number {
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

function send<T>(res: Response, result: PostResult<T>, okStatus = 200): Response {
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
 * Read the required `expected_updated_at` precondition from a PATCH body (§4.5).
 * REQUIRED, not optional — an unconditional overwrite must be impossible to
 * express — so a missing/blank value is a 400 before any write.
 */
function requireExpectedUpdatedAt(req: Request, res: Response): string | null {
  const value = req.body?.expected_updated_at;
  if (typeof value !== "string" || value.trim().length === 0) {
    res.status(400).json(failure("expected_updated_at is required"));
    return null;
  }
  return value;
}

// ---- Preview (§4.2 † GET /api/admin/preview/posts/:id) ----------------------

/**
 * Registered before `/posts/:id` variants is unnecessary (distinct path), but the
 * preview route uses the both-tokens middleware and must serialize the DRAFT
 * body. Kept here so the whole post surface lives in one router.
 */
adminPostsRouter.get(
  "/preview/posts/:id",
  requireAdminOrPreviewToken(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Consumed by the PUBLIC site's renderer in preview mode, so the success
      // body is raw like /api/posts/:slug — not the admin envelope (§4.1 vs §4.3).
      const result = await getDraftPostPreview(req.params.id, cdnDomain(req));
      if (result.ok) {
        res.status(200).json(result.data);
      } else {
        res.status(statusForCode(result.code)).json(failure(result.message));
      }
    } catch (err) {
      next(err as Error);
    }
  }
);

// ---- CRUD -------------------------------------------------------------------

/** GET /api/admin/posts — all posts, drafts included (§4.2). */
adminPostsRouter.get(
  "/posts",
  requireAdmin(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(success({ posts: await listAdminPosts() }));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** POST /api/admin/posts — create a post (§4.2). */
adminPostsRouter.post(
  "/posts",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug, title, excerpt, cover_media_id, tags, draft_body } =
        req.body ?? {};
      send(
        res,
        await createPost({
          slug,
          title,
          excerpt,
          cover_media_id,
          tags,
          draft_body,
        }),
        201
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** GET /api/admin/posts/:id — one post with draft_body (§4.2). */
adminPostsRouter.get(
  "/posts/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await getAdminPost(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** PATCH /api/admin/posts/:id — metadata or wholesale draft_body (§4.2 / §4.5). */
adminPostsRouter.patch(
  "/posts/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expected = requireExpectedUpdatedAt(req, res);
      if (expected === null) return;
      const { slug, title, excerpt, cover_media_id, tags, draft_body } =
        req.body ?? {};
      send(
        res,
        await updatePost(req.params.id, {
          expected_updated_at: expected,
          slug,
          title,
          excerpt,
          cover_media_id,
          tags,
          draft_body,
        })
      );
    } catch (err) {
      next(err as Error);
    }
  }
);

/** DELETE /api/admin/posts/:id — delete a post (§4.2). */
adminPostsRouter.delete(
  "/posts/:id",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await deletePost(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

// ---- Publish lifecycle ------------------------------------------------------

/**
 * POST /api/admin/posts/:id/publish (§4.2). Re-validates the draft body, refuses
 * an invalid one (400), then `published_body := draft_body` and stamps
 * `published_at`. Triggers the media GC pass after a successful publish (§6.9) —
 * fire-and-safe so a sweep failure never fails an already-committed publish.
 */
adminPostsRouter.post(
  "/posts/:id/publish",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await publishPost(req.params.id);
      if (result.ok) await runGcSafely();
      send(res, result);
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * POST /api/admin/posts/:id/unpublish (§4.2). Nulls `published_at` while
 * retaining `published_body`.
 */
adminPostsRouter.post(
  "/posts/:id/unpublish",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await unpublishPost(req.params.id));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminPostsRouter;
