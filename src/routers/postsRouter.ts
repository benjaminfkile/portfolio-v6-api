import express, { Request, Response, NextFunction } from "express";
import { IAppSecrets } from "../interfaces";
import { success, failure } from "../utils/envelope";
import {
  PostFailureCode,
  getPublishedPost,
  listPublishedPosts,
} from "../services/postsService";

/**
 * Public posts router — TECH_SPEC_V1.md §4.1 (GET /api/posts, GET /api/posts/:slug).
 *
 * No authentication. Published content only: `/api/posts` returns SUMMARIES
 * (never bodies, never drafts) with `?limit=` / `?tag=` / `?cursor=` keyset
 * pagination, and `/api/posts/:slug` returns one published post's
 * `published_body` with media resolved to CDN URLs (§6.8) plus a weak `ETag` for
 * conditional requests. An unpublished or unknown slug is a 404 — drafts are
 * invisible here (§3.6).
 */
const postsRouter = express.Router();

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

function cdnDomain(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cdn_domain ?? "";
}

/** Weak ETag over a post's `updated_at` — changes on any edit, publish, or unpublish. */
function etagForPost(slug: string, updatedAt: Date): string {
  return `W/"post-${slug}-${new Date(updatedAt).getTime()}"`;
}

/**
 * Compare an `If-None-Match` header against our weak ETag (RFC 7232 §3.2 weak
 * comparison — ignore the `W/` prefix). Mirrors the content router.
 */
function ifNoneMatchMatches(header: string, etag: string): boolean {
  const normalize = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || normalize(t) === target);
}

/** GET /api/posts — published summaries with keyset pagination (§4.1). */
postsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listPublishedPosts(
        {
          limit: req.query.limit,
          tag: req.query.tag,
          cursor: req.query.cursor,
        },
        cdnDomain(req)
      );
      if (!result.ok) {
        return res
          .status(statusForCode(result.code))
          .json(failure(result.message));
      }
      res.status(200).json(success(result.data));
    } catch (err) {
      next(err as Error);
    }
  }
);

/** GET /api/posts/:slug — one published post, `published_body` only, ETag (§4.1). */
postsRouter.get(
  "/:slug",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getPublishedPost(req.params.slug, cdnDomain(req));
      if (!result.ok) {
        return res
          .status(statusForCode(result.code))
          .json(failure(result.message));
      }

      const etag = etagForPost(result.data.post.slug, result.data.etagSource);
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

      const ifNoneMatch = req.headers["if-none-match"];
      if (
        typeof ifNoneMatch === "string" &&
        ifNoneMatchMatches(ifNoneMatch, etag)
      ) {
        return res.status(304).end();
      }

      res.status(200).json(success(result.data.post));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default postsRouter;
