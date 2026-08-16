import express, { Request, Response } from "express";
import { success } from "../utils/envelope";

const healthRouter = express.Router();

/**
 * GET /api/health
 * Liveness only — returns 200 with the standard envelope and makes NO DB call
 * (TECH_SPEC_V1.md §11.1 / task requirement). DB connectivity is intentionally
 * not probed here; whether the gateway's fleet health includes this service is
 * controlled by the `include_in_health` flag on its service-manifest row.
 */
healthRouter.get("/", (_req: Request, res: Response) => {
  res.status(200).json(success({ service: "portfolio-v6-api", status: "up" }));
});

export default healthRouter;
