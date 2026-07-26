import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routers/healthRouter";
import schemaRouter from "./routers/schemaRouter";
import adminAuthRouter from "./routers/adminAuthRouter";
import adminSectionsRouter from "./routers/adminSectionsRouter";
import adminPublishRouter from "./routers/adminPublishRouter";
import adminMediaRouter from "./routers/adminMediaRouter";
import contentRouter from "./routers/contentRouter";
import { isLocal } from "./config/loadConfig";
import { failure } from "./utils/envelope";

const app: Express = express();

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
// Preview-token mint route (§7), the sections/items CRUD (§4.2), and the publish
// pipeline (§4.2: publish/versions/restore/preview). All mount under /api/admin;
// each router guards its own routes with requireAdmin() (or, for the preview
// route, requireAdminOrPreviewToken()), and requests one router does not match
// fall through to the next. Later tasks (440–441) add their routers likewise.
app.use("/api/admin", adminAuthRouter);
app.use("/api/admin", adminSectionsRouter);
app.use("/api/admin", adminPublishRouter);
// Media pipeline (§4.2, §6.7–§6.9): presigned uploads, confirm, library, delete,
// GC sweep. All S3 access is isolated in src/aws/s3Service.ts.
app.use("/api/admin", adminMediaRouter);

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
