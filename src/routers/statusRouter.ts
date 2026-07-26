import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { success } from "../utils/envelope";
import { getStatus, StatusPayload } from "../services/statusService";

/**
 * Public status router — TECH_SPEC_V1.md §3.5 (`status` live section) / task #442.
 *
 * `GET /api/status` (public, no auth) serves the curated gateway-health payload
 * from a ~30s in-memory cache. It **degrades rather than errors**: an unreachable
 * or 503-ing gateway yields a degraded-shape payload, never a 5xx. The gateway
 * target URL comes from config/env (`gateway_health_url`, sourced from env under
 * IS_LOCAL — §10).
 */
const statusRouter = express.Router();

/** Fallback used only if `getStatus` itself somehow rejects (it should not). */
const DEGRADED: StatusPayload = { status: "degraded", services: [] };

function gatewayHealthUrl(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return (
    secrets?.gateway_health_url ??
    process.env.GATEWAY_HEALTH_URL ??
    "http://localhost:3000/api/health"
  );
}

statusRouter.get("/", async (req: Request, res: Response) => {
  // No `next(err)` path: this endpoint must never 5xx (§3.5). `getStatus` already
  // maps every upstream failure to a degraded payload; the catch is belt-and-braces.
  try {
    const payload = await getStatus(gatewayHealthUrl(req));
    res.status(200).json(success(payload));
  } catch (err) {
    console.error("[statusRouter] unexpected error; serving degraded:", err);
    res.status(200).json(success(DEGRADED));
  }
});

export default statusRouter;
