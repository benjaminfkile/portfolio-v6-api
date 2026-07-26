import express, { Request, Response, NextFunction } from "express";
import { IAppSecrets } from "../interfaces";
import { success } from "../utils/envelope";
import { getLatestContent } from "../services/publishService";

/**
 * Public content router — TECH_SPEC_V1.md §4.1 (GET /api/content).
 *
 * Serves the latest published document with media refs resolved to absolute CDN
 * URLs (§6.8). No authentication. Strong caching (§3.3 / §4.1): the response
 * carries `ETag: W/"v<version>"` and a matching `If-None-Match` gets a 304. If no
 * version was ever published it returns 200 with an empty `sections` array (never
 * a 404) so the public site renders an empty page rather than an error.
 */
const contentRouter = express.Router();

function etagForVersion(version: number): string {
  return `W/"v${version}"`;
}

function cdnDomain(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cdn_domain ?? "";
}

contentRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const content = await getLatestContent(cdnDomain(req));
      const etag = etagForVersion(content.version);

      // Version-keyed caching (§3.3): the document is immutable per version, so a
      // client holding the current version needs no body.
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string" && ifNoneMatchMatches(ifNoneMatch, etag)) {
        return res.status(304).end();
      }

      res.status(200).json(success(content));
    } catch (err) {
      next(err as Error);
    }
  }
);

/**
 * Compare an `If-None-Match` header against our weak ETag. The header may carry a
 * comma-separated list and `*`; a weak comparison ignores the `W/` prefix, which
 * is the correct semantics for cache validation (RFC 7232 §3.2).
 */
function ifNoneMatchMatches(header: string, etag: string): boolean {
  const normalize = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || normalize(t) === target);
}

export default contentRouter;
