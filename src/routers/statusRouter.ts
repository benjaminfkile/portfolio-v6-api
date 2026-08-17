import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { getStatus, StatusPayload } from "../services/statusService";
import {
  readSnapshot,
  readLocalSnapshot,
  type UpstreamHandle,
} from "../services/upstream";

/**
 * Public status router — TECH_SPEC_V1.md §3.5 (`status` live section) / task #442.
 *
 * `GET /api/status` (public, no auth) serves the curated gateway-health payload
 * from a ~30s in-memory cache. It **degrades rather than errors**: an unreachable
 * or 503-ing gateway yields a degraded-shape payload, never a 5xx. The gateway
 * target URL comes from config/env (`gateway_health_url`, sourced from env under
 * IS_LOCAL — §10).
 *
 * Task #84: when Redis is configured, the leader instance polls the gateway
 * and writes the curated payload to a shared snapshot; every other instance
 * serves that snapshot here. On any snapshot miss (Redis down, not yet
 * populated) we fall through to the per-instance path so public reads never
 * 5xx because of Redis.
 */
const statusRouter = express.Router();

/** Fallback used only if `getStatus` itself somehow rejects (it should not). */
const DEGRADED: StatusPayload = { degraded: true, services: [] };

function gatewayHealthUrl(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return (
    secrets?.gateway_health_url ??
    process.env.GATEWAY_HEALTH_URL ??
    "http://localhost:3000/api/health"
  );
}

statusRouter.get("/", async (req: Request, res: Response) => {
  try {
    const upstream = req.app.get("upstream") as UpstreamHandle | undefined;
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;

    if (upstream?.enabled && upstream.redis && secrets) {
      const snap = await readSnapshot<StatusPayload>(
        upstream.redis,
        secrets.node_env,
        "status"
      );
      if (snap) {
        return res.status(200).json(snap.payload);
      }
      const local = readLocalSnapshot<StatusPayload>("status");
      if (local) {
        return res.status(200).json(local);
      }
    }

    const payload = await getStatus(gatewayHealthUrl(req));
    res.status(200).json(payload);
  } catch (err) {
    console.error("[statusRouter] unexpected error; serving degraded:", err);
    res.status(200).json(DEGRADED);
  }
});

export default statusRouter;
