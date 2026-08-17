import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getNewestConfirmedResume,
  streamNewestResumeForDownload,
} from "../services/resumesService";

/**
 * Public resume router — task #92.
 *
 * `GET /api/resume` and `GET /api/resume/download`, both public, both raw
 * (§4.3), both degrade rather than 5xx (§3.5-style): an unexpected DB or S3
 * failure resolves to `{available:false}` / 404, never to a 5xx. Metadata is
 * `Cache-Control: no-store` — a new upload must go live immediately, so the
 * public site never revalidates a stale copy. The download always flows
 * through this endpoint (the CDN cannot force `Content-Disposition: attachment`
 * cross-origin), which sets attachment + the stored filename.
 */
const resumeRouter = express.Router();

const UNAVAILABLE = { available: false as const };

function cdnDomain(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cdn_domain ?? "";
}

/**
 * `Content-Disposition: attachment; filename="<stored filename>"`. Quotes and
 * backslashes inside the stored filename are escaped so a filename containing
 * `"` cannot break the header, and any non-ASCII character is stripped from
 * the header-quoted form and re-provided via the RFC 5987 `filename*` form
 * (UTF-8 URL-encoded). Together these guarantee the header is always a valid
 * ASCII header while preserving Unicode filenames for compliant browsers.
 */
function contentDispositionFor(filename: string): string {
  const quoted = filename.replace(/[\\"]/g, (m) => `\\${m}`);
  const asciiOnly = quoted.replace(/[^\x20-\x7E]/g, "_");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${asciiOnly}"; filename*=UTF-8''${utf8}`;
}

resumeRouter.get("/", async (req: Request, res: Response) => {
  // no-store: a new upload must go live immediately on /api/resume.
  res.setHeader("Cache-Control", "no-store");
  try {
    const payload = await getNewestConfirmedResume(cdnDomain(req));
    res.status(200).json(payload);
  } catch (err) {
    console.error(
      "[resumeRouter] unexpected error on GET /api/resume; degrading:",
      err
    );
    res.status(200).json(UNAVAILABLE);
  }
});

resumeRouter.get("/download", async (_req: Request, res: Response) => {
  try {
    const stream = await streamNewestResumeForDownload();
    if (!stream) {
      // Raw 404 body — no admin envelope on public routes (§4.3).
      return res
        .status(404)
        .setHeader("Content-Type", "text/plain; charset=utf-8")
        .send("resume not available");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDispositionFor(stream.filename));
    // no-store for the same reason as the metadata endpoint — a new upload
    // must serve immediately, and this endpoint is a live pipe from S3.
    res.setHeader("Cache-Control", "no-store");
    if (stream.contentLength != null) {
      res.setHeader("Content-Length", String(stream.contentLength));
    }
    res.status(200);
    stream.body.on("error", (err) => {
      console.error("[resumeRouter] S3 stream error mid-response:", err);
      // Headers are already sent — closing the socket is all we can do. Do
      // NOT re-send a JSON error (that would corrupt the PDF response).
      res.destroy(err);
    });
    stream.body.pipe(res);
  } catch (err) {
    console.error(
      "[resumeRouter] unexpected error on GET /api/resume/download:",
      err
    );
    if (!res.headersSent) {
      res
        .status(404)
        .setHeader("Content-Type", "text/plain; charset=utf-8")
        .send("resume not available");
    } else {
      res.destroy(err as Error);
    }
  }
});

export default resumeRouter;
