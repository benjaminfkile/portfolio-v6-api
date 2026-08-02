import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routers/healthRouter";
import schemaRouter from "./routers/schemaRouter";
import adminAuthRouter from "./routers/adminAuthRouter";
import adminPagesRouter from "./routers/adminPagesRouter";
import adminSectionsRouter from "./routers/adminSectionsRouter";
import adminPublishRouter from "./routers/adminPublishRouter";
import adminMediaRouter from "./routers/adminMediaRouter";
import adminPostsRouter from "./routers/adminPostsRouter";
import adminSpotifyRouter from "./routers/adminSpotifyRouter";
import contentRouter from "./routers/contentRouter";
import postsRouter from "./routers/postsRouter";
import statusRouter from "./routers/statusRouter";
import nowPlayingRouter from "./routers/nowPlayingRouter";
import { isLocal } from "./config/loadConfig";
import { failure } from "./utils/envelope";

const app: Express = express();

// Express auto-generates weak ETags for every response by default. The browser
// then revalidates with If-None-Match and Express answers 304 — which axios
// treats as an error (non-2xx), breaking the admin ("could not load the working
// set" on any repeat GET). Conditional caching is wanted ONLY where we manage
// it explicitly with version-keyed ETags (/api/content, /api/posts/:slug —
// §3.3/§4.1); those set their own ETag headers and handle If-None-Match
// themselves, so disabling the automatic one changes nothing for them.
app.set("etag", false);

app.use(helmet());

// CORS is enabled only for direct local access (IS_LOCAL). In production the
// gateway owns CORS — TECH_SPEC_V1.md §5 / §10.
if (isLocal()) {
  app.use(cors());
}

app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  const secrets = req.app.get("secrets") as { node_env?: string } | undefined;
  const suffix = secrets?.node_env === "production" ? "" : "-dev";
  res.send(`portfolio-v6-api${suffix}`);
});

app.use("/api/health", healthRouter);
app.use("/api/schema", schemaRouter);
// Public content endpoint (§4.1): latest published snapshot, media resolved to
// CDN URLs, ETag/304 caching.
app.use("/api/content", contentRouter);
// Public blog endpoints (§4.1): published post summaries with keyset pagination
// and one published post (published_body only, media resolved, ETag).
app.use("/api/posts", postsRouter);
// Public live-section endpoints (§3.5, §4.6): the gateway-health proxy and the
// Spotify now-playing proxy. Both serve from a ~30s in-memory cache and DEGRADE
// rather than error — an unreachable upstream yields a degraded/idle payload, a
// 200, never a 5xx. No Spotify token ever appears in a response (§4.6).
app.use("/api/status", statusRouter);
app.use("/api/now-playing", nowPlayingRouter);
// Admin responses are live editing state and must never be cached or
// revalidated by the browser — always fresh, always 200 (§4.2, §4.5).
app.use("/api/admin", (_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store");
  next();
});
// Preview-token mint route (§7), the sections/items CRUD (§4.2), and the publish
// pipeline (§4.2: publish/versions/restore/preview). All mount under /api/admin;
// each router guards its own routes with requireAdmin() (or, for the preview
// route, requireAdminOrPreviewToken()), and requests one router does not match
// fall through to the next. Later tasks (440–441) add their routers likewise.
app.use("/api/admin", adminAuthRouter);
// Pages CRUD + nav reorder (§4.2 v1.1, §3.10). Mounted before the sections
// router; both live under /api/admin and non-matching requests fall through.
app.use("/api/admin", adminPagesRouter);
app.use("/api/admin", adminSectionsRouter);
app.use("/api/admin", adminPublishRouter);
// Media pipeline (§4.2, §6.7–§6.9): presigned uploads, confirm, library, delete,
// GC sweep. All S3 access is isolated in src/aws/s3Service.ts.
app.use("/api/admin", adminMediaRouter);
// Blog admin pipeline (§4.2, §3.6, §3.7): post CRUD, publish/unpublish lifecycle,
// and the draft-body preview route (requireAdminOrPreviewToken).
app.use("/api/admin", adminPostsRouter);
// Spotify reconnect flow (§4.6): status/connect/disconnect are requireAdmin();
// the OAuth callback is guarded by its single-use state instead of a bearer
// token, since it arrives as a browser redirect from Spotify.
app.use("/api/admin", adminSpotifyRouter);

// JSON error handler ported from file-manager-api (§4.4). No view engine is
// configured, so errors return a clean JSON 500, never res.render.
app.use(function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (res.headersSent) {
    return next(err);
  }
  console.error("[ErrorHandler]", err);
  res.status(500).json(failure(err.message));
});

export default app;
