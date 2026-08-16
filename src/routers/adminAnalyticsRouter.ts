import express, { NextFunction, Request, Response } from "express";
import { requireAdminOrMachine } from "../middleware/requireAdminOrMachine";
import { success } from "../utils/envelope";
import { getAnalyticsSummary, parseDays } from "../services/analyticsService";

/**
 * Admin analytics router — TECH_SPEC_V1.md §4.8 (v1.4, read half).
 *
 * `GET /api/admin/analytics` (requireAdminOrMachine, §4.2) returns the curated,
 * privacy-respecting aggregate summary in the §4.3 envelope. `?days=7|30|90`
 * selects the lookback window; anything else degrades to 30 (§4.8). All
 * aggregation is done in Postgres by the service — the router is a thin shell
 * that parses the window, delegates, and wraps the result.
 *
 * Behind `requireAdminOrMachine()` (API Keys v1.16 — an AI editing agent needs
 * the analytics read to debug the site). The underlying rows carry no PII to
 * begin with.
 */
const adminAnalyticsRouter = express.Router();

adminAnalyticsRouter.get(
  "/analytics",
  requireAdminOrMachine(),
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
