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
import adminBlogsRouter from "./routers/adminBlogsRouter";
import adminIntegrationsRouter from "./routers/adminIntegrationsRouter";
import adminAnalyticsRouter from "./routers/adminAnalyticsRouter";
import adminIconsRouter from "./routers/adminIconsRouter";
import adminApiKeysRouter from "./routers/adminApiKeysRouter";
import adminResumesRouter from "./routers/adminResumesRouter";
import contentRouter from "./routers/contentRouter";
import postsRouter from "./routers/postsRouter";
import statusRouter from "./routers/statusRouter";
import nowPlayingRouter from "./routers/nowPlayingRouter";
import duolingoRouter from "./routers/duolingoRouter";
import githubRouter from "./routers/githubRouter";
import opsRouter from "./routers/opsRouter";
import resumeRouter from "./routers/resumeRouter";
import beaconRouter from "./routers/beaconRouter";
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

// helmet defaults set Cross-Origin-Resource-Policy: same-origin, which causes
// Chrome to block the (empty) 204 that navigator.sendBeacon receives cross-
// origin — the server processes the event but the browser logs
// ERR_BLOCKED_BY_RESPONSE.NotSameOrigin on every page load. This API is
// consumed exclusively cross-origin by the Vercel frontends (wildcard CORS
// comes from the gateway in deployed envs, from cors() below under IS_LOCAL),
// so cross-origin CORP app-wide is the correct posture.
// Every other helmet default (CSP, COOP, HSTS, X-Content-Type-Options, …) is
// left untouched.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// CORS is enabled only for direct local access (IS_LOCAL). In production the
// gateway owns CORS — TECH_SPEC_V1.md §5 / §10.
if (isLocal()) {
  app.use(cors());
}

// Public analytics ingest (§4.8, v1.4). Mounted BEFORE the global JSON parser
// because it must survive a malformed JSON body (which express.json() would turn
// into a 500 via the error handler) — the beacon router parses the body itself,
// tolerates parse errors, and ALWAYS answers 204. It never throws, never logs
// request contents, and stores no raw IP/user-agent.
app.use("/api/beacon", beaconRouter);

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
// Duolingo streak/course proxy (§3.5, v1.2). Same live-section contract: a ~1h
// in-memory cache and DEGRADE rather than error — no configured username or any
// upstream failure yields { available: false }, a 200, never a 5xx. The stored
// username never appears in a response.
app.use("/api/duolingo", duolingoRouter);
// GitHub contribution-graph proxy (§3.5, v1.2). Same live-section contract: a
// ~1h in-memory cache and DEGRADE rather than error — no configured PAT or any
// upstream failure yields { available: false }, a 200, never a 5xx. The stored
// PAT is sent only in the upstream Authorization header and never appears in a
// response or log.
app.use("/api/github", githubRouter);
// Ops daily-replay reports (§3.5, v1.7). One immutable report per UTC day
// persisted to ops_reports (lazily built after 00:15 UTC); `?date=YYYY-MM-DD`
// selects a day, else the latest. 400 on a malformed date, 404 when no report
// exists, 500 on unexpected failure; Cache-Control expires just past the next
// day boundary. The dashboard name is an infra identifier resolved server-side
// and never appears in a response or log; the curated payload is
// allowlist-shaped so no ARN/instance-id/account-id leaks.
app.use("/api/ops", opsRouter);
// Public resume endpoints (task #92): the newest confirmed version as
// `{available,url,filename,bytes,uploaded_at}` (no-store — a new upload must
// go live immediately) and a streamed download with attachment
// Content-Disposition. Degrade rather than 5xx: any failure yields
// `{available:false}` (metadata) or a 404 (download).
app.use("/api/resume", resumeRouter);
// Admin responses are live editing state and must never be cached or
// revalidated by the browser — always fresh, always 200 (§4.2, §4.5).
app.use("/api/admin", (_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store");
  next();
});
// Preview-token mint route (§7), the sections/items CRUD (§4.2), and the publish
// pipeline (§4.2: publish/versions/restore/preview). All mount under /api/admin;
// each router guards its own routes with requireAdminOrMachine() (or, for the
// preview route, requireAdminOrPreviewToken()), and requests one router does not
// match fall through to the next.
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
// Blogs admin (Blogs v1.13): named-blog CRUD (post_count, optimistic
// concurrency, delete-unassigns). Non-matching requests fall through.
app.use("/api/admin", adminBlogsRouter);
// Integrations (§4.7): the generalized integrations surface — GET /integrations,
// PUT /integrations/:key/value, and the oauth connect/callback flow, plus the
// legacy /api/admin/spotify/* aliases (§4.6) kept working until the admin's own
// task migrates. requireAdmin() guards every route except the oauth callback,
// which is guarded by its single-use state (a browser redirect carries no bearer).
app.use("/api/admin", adminIntegrationsRouter);
// Analytics aggregates (§4.8 v1.4, read half): GET /api/admin/analytics returns
// the curated, privacy-respecting summary (totals/daily/top pages/referrers/
// events/outbound) over a 7/30/90-day window. Reachable by admins and machine
// keys (API Keys v1.16 — the agent uses it to debug the site); all aggregation
// runs in Postgres and the underlying rows carry no PII.
app.use("/api/admin", adminAnalyticsRouter);
// Icons (§Icons v1.6): the devicon manifest proxy (pinned, cached, slimmed) and
// the icon import that stores a pinned SVG under the `icons/` prefix in the
// existing media bucket and returns its CDN URL. Reachable by admins and
// machine keys; all upstream fetch and S3 access is server-side. The `icons/`
// prefix is deliberately outside the §6.9 media orphan sweep (icons are
// referenced by URL, not media_id).
app.use("/api/admin", adminIconsRouter);
// Resume versions (task #92): the admin uploads resume PDFs (every version is
// kept) and the public site always serves the newest confirmed one. Presigned
// PUT + confirm mirrors the media flow (§6.7) but with a PDF-only allowlist
// and 10 MB cap; resumes live under `resumes/{uuid}/{filename}` and are NOT
// media_assets rows, so the §6.9 orphan sweep never touches them.
app.use("/api/admin", adminResumesRouter);
// API keys (API Keys v1.16): mint / list / revoke dashboard-minted keys used on
// the content-editing surface in place of the removed Cognito client-credentials
// path. Humans only — every route is behind requireAdmin() (a key can never
// mint, list, or revoke another key); the full key is returned once at mint and
// only its SHA-256 hash is stored.
app.use("/api/admin", adminApiKeysRouter);

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
