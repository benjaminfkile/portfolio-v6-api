import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routers/healthRouter";
import schemaRouter from "./routers/schemaRouter";
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
