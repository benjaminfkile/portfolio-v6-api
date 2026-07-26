import express, { Request, Response } from "express";
import { success } from "../utils/envelope";

const healthRouter = express.Router();

/**
 * GET /api/health
 * Liveness only — returns 200 with the standard envelope and makes NO DB call
 * (TECH_SPEC_V1.md §11.1 / task requirement). DB connectivity is intentionally
 * not probed here; the gateway health check for this service is disabled
 * (§9.2 `includeInHealthCheck: false`).
 */
healthRouter.get("/", (_req: Request, res: Response) => {
  res.status(200).json(success({ service: "portfolio-v6-api", status: "up" }));
});

export default healthRouter;
