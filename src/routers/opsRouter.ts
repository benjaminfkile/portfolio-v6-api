import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { getOps, parseWindowHours, OpsResult } from "../services/opsService";

/**
 * Public ops router — TECH_SPEC_V1.md §3.5/§4.1 (`/api/ops`, v1.3) / task #488.
 *
 * `GET /api/ops` (public, no auth) proxies a CloudWatch dashboard's metric
 * widgets server-side, served from a ~5-minute in-memory cache. It **degrades
 * rather than errors** (§3.5): no configured dashboard name, ANY CloudWatch
 * failure, malformed dashboard JSON, or a dashboard with no renderable metric
 * widgets all render as `{ available: false }`, never a 5xx. The dashboard name
 * is an infra identifier — it is resolved from the stored secret server-side and
 * never appears in the response or in a log.
 *
 * `?window_hours=` selects the trailing window (integer 1..24, default 3); an
 * invalid value degrades to the default rather than erroring.
 */
const opsRouter = express.Router();

const UNAVAILABLE: OpsResult = { available: false };

/**
 * The CloudWatch dashboard name lives in the app secrets (§9.3) — a deployed
 * infra identifier, resolved server-side and never returned to the client.
 * Missing/empty → `getOps` short-circuits to `{ available: false }` with no AWS
 * call.
 */
function dashboardName(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cloudwatch_dashboard_name ?? "";
}

opsRouter.get("/", async (req: Request, res: Response) => {
  // Never 5xx (§3.5). `getOps` maps every failure to `{ available: false }`; the
  // catch is belt-and-braces for a truly unexpected throw. Public reads return
  // the resource raw (§4.1) — the envelope is the admin convention (§4.3).
  try {
    const name = dashboardName(req);
    const windowHours = parseWindowHours(req.query.window_hours);
    const payload = await getOps(name, windowHours);
    res.status(200).json(payload);
  } catch (err) {
    // Log the error CLASS only — it must never carry the dashboard name (§3.5).
    console.error(
      "[opsRouter] unexpected error; serving unavailable:",
      err instanceof Error ? err.name : "unknown error"
    );
    res.status(200).json(UNAVAILABLE);
  }
});

export default opsRouter;
