import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { getDb } from "../db/db";
import { getOpsReport, buildCacheControl } from "../services/opsService";
import { failure } from "../utils/envelope";

/**
 * Public ops router — TECH_SPEC_V1.md §3.5/§4.1 (`/api/ops`, v1.7 Ops Replay) /
 * task #537.
 *
 * `GET /api/ops` (public, no auth) serves the DAILY REPLAY report: one immutable
 * report per UTC day, built once server-side from the curated CloudWatch
 * dashboard, persisted to `ops_reports`, and replayed client-side. On request the
 * service lazily builds yesterday's report if it is missing and now ≥ 00:15 UTC
 * (single-flight + idempotent insert), then serves the latest stored report.
 *
 *   - no `?date=`   → the latest available report (usually yesterday, UTC).
 *   - `?date=YYYY-MM-DD` → that stored report, or 404 if none for that day.
 *   - an invalid `date` param → 400 with a clear errorMsg.
 *   - no report available at all → 404 (the client shows a calm placeholder).
 *
 * `Cache-Control: public` with a max-age that expires shortly after the next
 * 00:15 UTC (a short ~5-min max-age when the expected report is not built yet).
 * The dashboard name is an infra identifier resolved server-side (from the stored
 * secret) and NEVER appears in a response or a log; the curated payload is
 * allowlist-shaped so no ARN/instance-id/account-id leaks.
 */
const opsRouter = express.Router();

/**
 * The CloudWatch dashboard name lives in the app secrets (§9.3) — a deployed
 * infra identifier, resolved server-side and never returned to the client.
 * Missing/empty → the service builds nothing and makes no AWS call.
 */
function dashboardName(req: Request): string {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  return secrets?.cloudwatch_dashboard_name ?? "";
}

/**
 * Validate the optional `?date=` param. Returns the normalized `YYYY-MM-DD`
 * string, `undefined` when absent, or `null` when present but malformed (a real
 * calendar day is required — `2026-13-40` is rejected, not silently coerced).
 */
function parseDateParam(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    return null;
  }
  return s;
}

opsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const date = parseDateParam(req.query.date);
    if (date === null) {
      return res
        .status(400)
        .json(failure("Invalid `date` — expected a calendar day as YYYY-MM-DD."));
    }

    const now = new Date();
    const report = await getOpsReport(getDb(), dashboardName(req), { date, now });

    if (!report) {
      return res
        .status(404)
        .json(failure("No ops report is available for the requested date."));
    }

    // Public reads return the resource raw (§4.1); the envelope is admin-only.
    res.set("Cache-Control", buildCacheControl(now, report.report_date));
    res.status(200).json(report);
  } catch (err) {
    // Log the error CLASS only — it must never carry the dashboard name (§3.5).
    console.error(
      "[opsRouter] unexpected error serving ops report:",
      err instanceof Error ? err.name : "unknown error"
    );
    res.status(500).json(failure("Ops report is temporarily unavailable."));
  }
});

export default opsRouter;
