/**
 * Ops service — TECH_SPEC_V1.md §3.5 (`ops` live section, v1.3) / task #488.
 *
 * The `ops` live section renders a curated view of a CloudWatch dashboard's
 * metric widgets. The API proxies CloudWatch server-side for the same reasons
 * the other live sections proxy their upstream (§3.5): the dashboard name is a
 * deployed infra identifier that stays server-side, the returned shape is a
 * deliberate curated choice, and a ~5-minute in-memory cache means visitor
 * traffic never multiplies (expensive, throttled) CloudWatch calls.
 *
 * SANITIZATION is ALLOWLIST-SHAPED (§3.5). The response is assembled ONLY from a
 * fixed set of fields — `{ title, computed kind/unit/latest/series }`. Raw
 * dashboard internals (dimension values like `i-…` instance ids, ARNs, account
 * ids, region, CloudWatch's auto-generated series labels) are NEVER copied
 * through. A series `label` survives only when it was an EXPLICIT user-set label
 * in the widget definition AND does not match a resource-identifier pattern;
 * otherwise it is `null`.
 *
 * DEGRADE rather than error (§3.5): a missing/empty dashboard name, an SDK/IAM
 * error, malformed dashboard JSON, or a dashboard with no renderable metric
 * widgets ALL resolve to `{ available: false }` — a 200, never a 5xx. Only the
 * error class name / result shape is ever logged; the dashboard name never is.
 */

import type {
  MetricDataQuery,
  MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import { getDashboard, getMetricData } from "../aws/cloudwatchService";

/** In-memory curated-result cache TTL (§3.5 "~5-minute"). */
export const OPS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Fixed metric grain for every query — a 5-minute period (§3.5). */
export const METRIC_PERIOD_SECONDS = 300;

/** `?window_hours=` bounds and default (§3.5). */
export const DEFAULT_WINDOW_HOURS = 3;
export const MIN_WINDOW_HOURS = 1;
export const MAX_WINDOW_HOURS = 24;

/**
 * Resource-identifier patterns (§3.5). A series label matching ANY of these is
 * dropped to `null` — an instance id, an ARN, an ALB target group path, or any
 * 12-digit run (AWS account ids) must never reach a public response.
 */
const RESOURCE_ID_PATTERNS: RegExp[] = [
  /^i-[0-9a-f]+/,
  /^arn:/,
  /^app\//,
  /[0-9]{12}/,
];

/** Titles that mark a single-series widget as a gauge rather than a chart. */
const GAUGE_TITLE_RE = /utilization|%|used \(%\)/i;

/** A single curated datapoint — an ISO timestamp and a numeric value. */
export interface OpsPoint {
  t: string;
  v: number;
}

/** A curated series: an optional sanitized label and its ordered points. */
export interface OpsSeries {
  label: string | null;
  points: OpsPoint[];
}

/** A curated widget (§3.5 shape). */
export interface OpsWidget {
  title: string;
  kind: "gauge" | "chart";
  unit: string | null;
  latest: number | null;
  series: OpsSeries[];
}

/** Curated /api/ops payload (§3.5). Never contains any infra identifier. */
export type OpsResult =
  | { available: false }
  | { available: true; window_hours: number; widgets: OpsWidget[] };

const UNAVAILABLE: OpsResult = { available: false };

// Module-level state: the ~5-minute curated-result cache (keyed by dashboard +
// window so a different window is a distinct entry) and a per-key single-flight
// map so a burst of concurrent cache-miss reads collapses to one CloudWatch call.
let cache: { key: string; result: OpsResult; expiresAt: number } | null = null;
const inFlight = new Map<string, Promise<OpsResult>>();

// --- Validation helpers -----------------------------------------------------

/**
 * Validate `?window_hours=` — an integer in 1..24; anything else (missing,
 * non-integer, out of range) DEGRADES to the default of 3 (§3.5), never an error.
 */
export function parseWindowHours(raw: unknown): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string" && typeof s !== "number") return DEFAULT_WINDOW_HOURS;
  const n = typeof s === "number" ? s : Number(s);
  if (
    !Number.isInteger(n) ||
    n < MIN_WINDOW_HOURS ||
    n > MAX_WINDOW_HOURS
  ) {
    return DEFAULT_WINDOW_HOURS;
  }
  return n;
}

function isResourceIdentifier(s: string): boolean {
  return RESOURCE_ID_PATTERNS.some((re) => re.test(s));
}

/** A label survives only if user-set AND not a resource identifier — else null. */
function sanitizeLabel(explicitLabel: string | null): string | null {
  if (explicitLabel === null) return null;
  return isResourceIdentifier(explicitLabel) ? null : explicitLabel;
}

/** Map a CloudWatch unit to the short display string, else null (allowlist). */
function mapUnitDisplay(raw: string | null): string | null {
  if (raw === "Percent") return "%";
  if (raw === "Bytes/Second" || raw === "Megabytes/Second") return "MB/s";
  return null;
}

/** kind = 'gauge' iff single-series AND (raw unit Percent OR gauge-y title). */
function inferKind(
  seriesCount: number,
  unitRaw: string | null,
  title: string
): "gauge" | "chart" {
  const single = seriesCount === 1;
  const percentish = unitRaw === "Percent" || GAUGE_TITLE_RE.test(title);
  return single && percentish ? "gauge" : "chart";
}

// --- Dashboard parsing ------------------------------------------------------

interface ParsedMetric {
  namespace: string;
  metricName: string;
  dimensions: { Name: string; Value: string }[];
  stat: string;
  /** The widget-def `label` option, if it was an explicit string (else null). */
  explicitLabel: string | null;
}

/**
 * Parse one CloudWatch dashboard metrics row. A metric row looks like
 * `[Namespace, MetricName, DimName, DimValue, …, { label?, stat?, … }?]`.
 * Expression rows (`[{ expression, label }]`) and any other unknown shape start
 * with a non-string first element (or lack a metric name) and are SKIPPED
 * defensively by returning null.
 */
function parseMetricRow(row: unknown, widgetStat: string): ParsedMetric | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  // A metric row begins with [Namespace, MetricName] — both strings. Expression
  // and other rows start with an object, so this rejects them.
  if (typeof row[0] !== "string" || typeof row[1] !== "string") return null;

  const namespace = row[0];
  const metricName = row[1];
  const rest = row.slice(2);

  // A trailing options object (not an array) carries label/stat/etc.
  let options: Record<string, unknown> = {};
  const last = rest[rest.length - 1];
  if (last !== null && typeof last === "object" && !Array.isArray(last)) {
    options = rest.pop() as Record<string, unknown>;
  }

  // Whatever remains are [DimName, DimValue] pairs (both strings).
  const dimensions: { Name: string; Value: string }[] = [];
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (typeof name === "string" && typeof value === "string") {
      dimensions.push({ Name: name, Value: value });
    }
  }

  const stat = typeof options.stat === "string" ? options.stat : widgetStat;
  const explicitLabel =
    typeof options.label === "string" ? (options.label as string) : null;

  return { namespace, metricName, dimensions, stat, explicitLabel };
}

/** The raw unit for a widget: an explicit `unit` prop, else its left-axis label. */
function widgetUnitRaw(props: Record<string, unknown>): string | null {
  if (typeof props.unit === "string") return props.unit;
  const yAxis = props.yAxis as Record<string, unknown> | undefined;
  const left = yAxis?.left as Record<string, unknown> | undefined;
  if (typeof left?.label === "string") return left.label as string;
  return null;
}

interface PlannedSeries {
  id: string;
  label: string | null;
}

interface PlannedWidget {
  title: string;
  unitRaw: string | null;
  series: PlannedSeries[];
}

/**
 * Parse the dashboard body into a plan (widgets + their series, keyed by query
 * id) and the flat `GetMetricData` query list covering every series. Only
 * `type: "metric"` widgets with a metrics array are considered; a widget whose
 * rows are all expression/unknown (zero renderable series) is dropped. Throws on
 * unparseable JSON — the caller degrades.
 */
function buildPlan(body: string): {
  plan: PlannedWidget[];
  queries: MetricDataQuery[];
} {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const widgetsRaw = parsed.widgets;
  const plan: PlannedWidget[] = [];
  const queries: MetricDataQuery[] = [];
  let counter = 0;

  if (!Array.isArray(widgetsRaw)) return { plan, queries };

  for (const w of widgetsRaw) {
    if (w === null || typeof w !== "object") continue;
    const widget = w as Record<string, unknown>;
    if (widget.type !== "metric") continue;

    const props = (widget.properties ?? {}) as Record<string, unknown>;
    const metricsRaw = props.metrics;
    if (!Array.isArray(metricsRaw)) continue;

    const title = typeof props.title === "string" ? props.title : "";
    const widgetStat = typeof props.stat === "string" ? props.stat : "Average";
    const unitRaw = widgetUnitRaw(props);

    const series: PlannedSeries[] = [];
    for (const row of metricsRaw) {
      const metric = parseMetricRow(row, widgetStat);
      if (!metric) continue; // expression / unknown row — skip defensively

      const id = `m${counter++}`;
      queries.push({
        Id: id,
        MetricStat: {
          Metric: {
            Namespace: metric.namespace,
            MetricName: metric.metricName,
            Dimensions: metric.dimensions,
          },
          Period: METRIC_PERIOD_SECONDS,
          Stat: metric.stat,
        },
        ReturnData: true,
      });
      series.push({ id, label: sanitizeLabel(metric.explicitLabel) });
    }

    if (series.length === 0) continue; // nothing renderable in this widget
    plan.push({ title, unitRaw, series });
  }

  return { plan, queries };
}

/** Map a metric-data result to ordered `{ t, v }` points (skips bad entries). */
function resultToPoints(r: MetricDataResult | undefined): OpsPoint[] {
  if (!r) return [];
  const timestamps = Array.isArray(r.Timestamps) ? r.Timestamps : [];
  const values = Array.isArray(r.Values) ? r.Values : [];
  const n = Math.min(timestamps.length, values.length);
  const points: OpsPoint[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v !== "number") continue;
    const ts = timestamps[i];
    const t =
      ts instanceof Date
        ? ts.toISOString()
        : typeof ts === "string"
          ? ts
          : null;
    if (t === null) continue;
    points.push({ t, v });
  }
  return points;
}

/** Curate a planned widget + the metric-data results into the public shape. */
function curateWidget(
  w: PlannedWidget,
  byId: Map<string, MetricDataResult>
): OpsWidget {
  const series: OpsSeries[] = w.series.map((s) => ({
    label: s.label,
    points: resultToPoints(byId.get(s.id)),
  }));

  const unit = mapUnitDisplay(w.unitRaw);
  const kind = inferKind(series.length, w.unitRaw, w.title);

  const firstPoints = series[0]?.points ?? [];
  const latest =
    firstPoints.length > 0 ? firstPoints[firstPoints.length - 1].v : null;

  // The response carries ONLY these fields — the allowlist (§3.5).
  return { title: w.title, kind, unit, latest, series };
}

// --- Orchestration ----------------------------------------------------------

/**
 * Do the actual upstream work for a cache miss: fetch the dashboard, build ONE
 * GetMetricData call for every widget's metrics, and curate the results. ANY
 * failure — SDK/IAM error, malformed dashboard JSON, empty/unrenderable widgets
 * — resolves to `{ available: false }`; it never throws. Logs the error class /
 * shape only, NEVER the dashboard name.
 */
async function computeOps(
  dashboardName: string,
  windowHours: number
): Promise<OpsResult> {
  try {
    const body = await getDashboard(dashboardName);
    if (!body) return UNAVAILABLE;

    let plan: PlannedWidget[];
    let queries: MetricDataQuery[];
    try {
      ({ plan, queries } = buildPlan(body));
    } catch {
      // Malformed dashboard JSON — degrade (never surface the parse error, which
      // could echo dashboard contents).
      return UNAVAILABLE;
    }
    if (plan.length === 0 || queries.length === 0) return UNAVAILABLE;

    const end = new Date();
    const start = new Date(end.getTime() - windowHours * 60 * 60 * 1000);
    const results = await getMetricData(queries, start, end);

    const byId = new Map<string, MetricDataResult>();
    for (const r of results) {
      if (typeof r.Id === "string") byId.set(r.Id, r);
    }

    const widgets = plan.map((w) => curateWidget(w, byId));
    return { available: true, window_hours: windowHours, widgets };
  } catch (err) {
    // Log the error CLASS only — an AWS error message can embed the dashboard
    // name / ARNs, which must never reach a log line (§3.5).
    console.error(
      "[opsService] ops fetch failed; serving { available: false }:",
      err instanceof Error ? err.name : "unknown error"
    );
    return UNAVAILABLE;
  }
}

/**
 * Get the curated ops payload for `dashboardName` at `windowHours`, served from
 * the ~5-minute cache with per-key single-flight. Always resolves — never
 * rejects — so `GET /api/ops` never returns a 5xx (§3.5). With no dashboard name
 * there is nothing to fetch: returns `{ available: false }` and makes no AWS
 * call. Only a SUCCESSFUL result is cached, so a transient failure does not stay
 * dark for the whole window.
 */
export async function getOps(
  dashboardName: string | null | undefined,
  windowHours: number
): Promise<OpsResult> {
  if (!dashboardName) return UNAVAILABLE;

  const key = `${dashboardName}::${windowHours}`;
  const now = Date.now();
  if (cache && cache.key === key && cache.expiresAt > now) {
    return cache.result;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const result = await computeOps(dashboardName, windowHours);
    if (result.available) {
      cache = { key, result, expiresAt: Date.now() + OPS_CACHE_TTL_MS };
    }
    return result;
  })();

  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

/** Test-only: clear the module cache, any in-flight fetch, and the SDK client. */
export function _resetOpsForTests(): void {
  cache = null;
  inFlight.clear();
}
