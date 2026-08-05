import express, { NextFunction, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin";
import { success } from "../utils/envelope";
import { getAnalyticsSummary, parseDays } from "../services/analyticsService";

/**
 * Admin analytics router — TECH_SPEC_V1.md §4.8 (v1.4, read half).
 *
 * `GET /api/admin/analytics` (requireAdmin, §4.2) returns the curated,
 * privacy-respecting aggregate summary in the §4.3 envelope. `?days=7|30|90`
 * selects the lookback window; anything else degrades to 30 (§4.8). All
 * aggregation is done in Postgres by the service — the router is a thin shell
 * that parses the window, delegates, and wraps the result.
 *
 * This is an ADMIN-only surface (§4.8): none of these aggregates ever appear on
 * the public site, and the underlying rows carry no PII to begin with.
 */
const adminAnalyticsRouter = express.Router();

adminAnalyticsRouter.get(
  "/analytics",
  requireAdmin(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = parseDays(req.query.days);
      const summary = await getAnalyticsSummary(days);
      res.status(200).json(success(summary));
    } catch (err) {
      next(err as Error);
    }
  }
);

export default adminAnalyticsRouter;
