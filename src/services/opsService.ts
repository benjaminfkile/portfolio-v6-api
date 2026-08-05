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

/**
 * Map a raw CloudWatch unit / axis-label / standard-unit token to the short
 * display string, else null (allowlist). Handles both the CloudWatch spellings
 * (`Percent`, `Bytes/Second`, `Bytes`, `Count`) and the already-short display
 * forms (`%`, `MB/s`, `B`) so an axis label that is already a display unit passes
 * through. `Count` is deliberately dropped to null (a bare count has no unit).
 */
function mapUnitToken(raw: string): string | null {
  const s = raw.trim();
  if (s === "Percent" || s === "%") return "%";
  if (s === "Bytes/Second" || s === "Megabytes/Second" || s === "MB/s") {
    return "MB/s";
  }
  if (s === "Bytes" || s === "B") return "B";
  if (s === "Count") return null;
  return null;
}

/**
 * Derive a widget's display unit (§3.5, DEFECT 2) in priority order:
 *   (a) the widget's explicit `unit` / yAxis-left label (`unitRaw`), mapped;
 *   (b) a title heuristic — `Utilization` or a `(%)` suffix → `%`, and any other
 *       parenthesized trailing suffix (`(MB/s)`, `(req/s)`…) passes through;
 *   (c) the metric's standard unit from the GetMetricData result, mapped.
 * A small pure function (unit-tested directly). Returns null when nothing yields
 * a unit.
 */
export function deriveUnit(
  unitRaw: string | null,
  title: string,
  standardUnit: string | null
): string | null {
  if (unitRaw) {
    const mapped = mapUnitToken(unitRaw);
    if (mapped) return mapped;
  }
  const fromTitle = titleUnit(title);
  if (fromTitle) return fromTitle;
  if (standardUnit) {
    const mapped = mapUnitToken(standardUnit);
    if (mapped) return mapped;
  }
  return null;
}

/** The title heuristic of `deriveUnit` (b): `Utilization`/`(%)` → `%`, else a
 * trailing parenthesized suffix — but ONLY when it actually reads as a unit
 * (`(MB/s)`, `(req/s)`, `(ms)`). Titles routinely carry non-unit parentheticals
 * (`CPU Credits (ASG)`), so a plain word is rejected: a suffix qualifies iff it
 * is `%`, contains a `/` (a rate), or is a known short unit token. */
const UNIT_TOKEN = /^(ms|s|sec|min|B|KB|MB|GB|TB|KiB|MiB|GiB)$/i;

function titleUnit(title: string): string | null {
  if (/utilization/i.test(title)) return "%";
  const m = title.match(/\(([^()]+)\)\s*$/);
  if (!m) return null;
  const inner = m[1].trim();
  if (inner === "%") return "%";
  if (inner.includes("/") || UNIT_TOKEN.test(inner)) return inner;
  return null;
}

/** Read an optional standard unit off a metric-data result (GetMetricData does
 * not surface units, so this is a best-effort fallback for deriveUnit (c)). */
function readStandardUnit(r: MetricDataResult | undefined): string | null {
  if (!r) return null;
  const u =
    (r as unknown as { StandardUnit?: unknown; Unit?: unknown }).StandardUnit ??
    (r as unknown as { StandardUnit?: unknown; Unit?: unknown }).Unit;
  return typeof u === "string" ? u : null;
}

/** kind = 'gauge' iff single-series AND (display unit is % OR gauge-y title). A
 * widget whose EXPRESSION produces a percent (unit resolves to `%` from the
 * title/label) is therefore a gauge, not a raw-bytes chart (§3.5, DEFECT 1). */
function inferKind(
  seriesCount: number,
  unit: string | null,
  title: string
): "gauge" | "chart" {
  const single = seriesCount === 1;
  const percentish = unit === "%" || GAUGE_TITLE_RE.test(title);
  return single && percentish ? "gauge" : "chart";
}

// --- Dashboard parsing ------------------------------------------------------

interface ParsedMetric {
  kind: "metric";
  namespace: string;
  metricName: string;
  dimensions: { Name: string; Value: string }[];
  stat: string;
  /** The widget-def `label` option, if it was an explicit string (else null). */
  explicitLabel: string | null;
  /** The dashboard-declared `id` (e.g. `m1`), preserved so expressions resolve. */
  declaredId: string | null;
  /** The dashboard `visible` flag (undefined when unset). */
  visible: boolean | undefined;
}

interface ParsedExpression {
  kind: "expression";
  /** The raw metric-math expression string — server-side ONLY, never emitted. */
  expression: string;
  explicitLabel: string | null;
  declaredId: string | null;
  visible: boolean | undefined;
}

type ParsedRow = ParsedMetric | ParsedExpression;

/**
 * Parse one CloudWatch dashboard metrics row into a metric query. A metric row
 * looks like `[Namespace, MetricName, DimName, DimValue, …, { label?, stat?,
 * id?, visible?, … }?]`. Expression rows (`[{ expression, label }]`) and any
 * other unknown shape start with a non-string first element (or lack a metric
 * name); this returns null for them (handled by `parseExpressionRow`).
 */
function parseMetricRow(row: unknown, widgetStat: string): ParsedMetric | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  // A metric row begins with [Namespace, MetricName] — both strings. Expression
  // and other rows start with an object, so this rejects them.
  if (typeof row[0] !== "string" || typeof row[1] !== "string") return null;

  const namespace = row[0];
  const metricName = row[1];
  const rest = row.slice(2);

  // A trailing options object (not an array) carries label/stat/id/visible/etc.
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
  const declaredId = typeof options.id === "string" ? options.id : null;
  const visible =
    typeof options.visible === "boolean" ? options.visible : undefined;

  return {
    kind: "metric",
    namespace,
    metricName,
    dimensions,
    stat,
    explicitLabel,
    declaredId,
    visible,
  };
}

/**
 * Parse one dashboard EXPRESSION row — `[{ expression, id?, label?, visible? }]`
 * — into a metric-math query source. Returns null for anything that is not an
 * expression row. The expression STRING is kept for server-side GetMetricData
 * only; it never reaches the curated response.
 */
function parseExpressionRow(row: unknown): ParsedExpression | null {
  if (!Array.isArray(row) || row.length < 1) return null;
  const first = row[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const obj = first as Record<string, unknown>;
  if (typeof obj.expression !== "string") return null;

  const explicitLabel = typeof obj.label === "string" ? obj.label : null;
  const declaredId = typeof obj.id === "string" ? obj.id : null;
  const visible = typeof obj.visible === "boolean" ? obj.visible : undefined;

  return {
    kind: "expression",
    expression: obj.expression,
    explicitLabel,
    declaredId,
    visible,
  };
}

/** Identifier-shaped tokens in a metric-math expression (ids AND function names;
 * callers intersect with declared ids so function names are harmless). */
function extractIds(expression: string): string[] {
  return expression.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite an expression so each dashboard-declared local id (`m1`, `e1`…) is
 * replaced by its collision-free global query id. Single-pass with an alternation
 * of the declared ids (longest first) and word boundaries, so an id is never
 * matched inside a longer token or a just-substituted global id.
 */
function rewriteExpression(
  expression: string,
  idMap: Map<string, string>
): string {
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);
  if (ids.length === 0) return expression;
  const re = new RegExp(`\\b(${ids.map(escapeRegExp).join("|")})\\b`, "g");
  return expression.replace(re, (tok) => idMap.get(tok) ?? tok);
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
 * Parse the dashboard body into a plan (widgets + their rendered series, keyed by
 * query id) and the flat `GetMetricData` query list. Only `type: "metric"`
 * widgets with a metrics array are considered; a widget with zero renderable
 * series is dropped. Throws on unparseable JSON — the caller degrades.
 *
 * MATH EXPRESSIONS (§3.5, DEFECT 1): GetMetricData executes expressions
 * server-side, so the query list carries BOTH the metric rows (as MetricStat
 * queries — `ReturnData:false` when the dashboard hides them or they only feed an
 * expression) AND the expression rows (as `{ Id, Expression, Label,
 * ReturnData:true }`). Dashboard-declared ids (`m1`/`e1`…) are preserved but
 * prefixed per widget (`w0_m1`…) so ids stay collision-free across a single
 * batched call, and expression strings are rewritten to the prefixed ids so they
 * still resolve. An expression that references no declared sibling id is dropped
 * defensively (it cannot resolve). The rendered series are exactly the
 * `ReturnData:true` queries, in dashboard order.
 */
function buildPlan(body: string): {
  plan: PlannedWidget[];
  queries: MetricDataQuery[];
} {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const widgetsRaw = parsed.widgets;
  const plan: PlannedWidget[] = [];
  const queries: MetricDataQuery[] = [];
  let autoCounter = 0; // globally-unique ids (m0, m1…) for id-less metric rows
  let widgetIndex = 0; // per-widget prefix for declared ids (w0_…, w1_…)

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
    const wi = widgetIndex++;

    // Pass 1 — parse every row and collect the set of dashboard-declared ids.
    const rows: ParsedRow[] = [];
    const declaredIds = new Set<string>();
    for (const row of metricsRaw) {
      const parsedRow = parseMetricRow(row, widgetStat) ?? parseExpressionRow(row);
      if (!parsedRow) continue; // unknown row — skip defensively
      rows.push(parsedRow);
      if (parsedRow.declaredId) declaredIds.add(parsedRow.declaredId);
    }

    // Which declared ids are referenced by an expression (so they only feed it)?
    const referenced = new Set<string>();
    for (const r of rows) {
      if (r.kind !== "expression") continue;
      for (const tok of extractIds(r.expression)) {
        if (declaredIds.has(tok)) referenced.add(tok);
      }
    }

    // Map declared local id → collision-free global query id for THIS widget.
    const idMap = new Map<string, string>();
    for (const id of declaredIds) idMap.set(id, `w${wi}_${id}`);

    // Pass 2 — build queries and the rendered series (ReturnData=true, in order).
    const series: PlannedSeries[] = [];
    const widgetQueries: MetricDataQuery[] = [];
    for (const r of rows) {
      if (r.kind === "metric") {
        const id = r.declaredId ? idMap.get(r.declaredId)! : `m${autoCounter++}`;
        let returnData: boolean;
        if (r.visible === false) returnData = false;
        else if (r.visible === true) returnData = true;
        // Unset visibility: render unless the row only feeds an expression.
        else returnData = r.declaredId ? !referenced.has(r.declaredId) : true;

        widgetQueries.push({
          Id: id,
          MetricStat: {
            Metric: {
              Namespace: r.namespace,
              MetricName: r.metricName,
              Dimensions: r.dimensions,
            },
            Period: METRIC_PERIOD_SECONDS,
            Stat: r.stat,
          },
          ReturnData: returnData,
        });
        if (returnData) series.push({ id, label: sanitizeLabel(r.explicitLabel) });
      } else {
        // An expression that references no declared sibling id cannot resolve
        // (e.g. it names auto-assigned ids we never emit) — drop it.
        const refs = extractIds(r.expression).filter((t) => declaredIds.has(t));
        if (refs.length === 0) continue;

        const id = r.declaredId
          ? idMap.get(r.declaredId)!
          : `w${wi}_x${autoCounter++}`;
        const returnData = r.visible !== false;
        const query: MetricDataQuery = {
          Id: id,
          Expression: rewriteExpression(r.expression, idMap),
          ReturnData: returnData,
        };
        // Forward the user-set label to CloudWatch (server-side only). The
        // curated series label is separately sanitized below.
        if (r.explicitLabel !== null) query.Label = r.explicitLabel;
        widgetQueries.push(query);
        if (returnData) series.push({ id, label: sanitizeLabel(r.explicitLabel) });
      }
    }

    if (series.length === 0) continue; // nothing renderable in this widget
    for (const q of widgetQueries) queries.push(q);
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

  const standardUnit = readStandardUnit(
    w.series.length > 0 ? byId.get(w.series[0].id) : undefined
  );
  const unit = deriveUnit(w.unitRaw, w.title, standardUnit);
  const kind = inferKind(series.length, unit, w.title);

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
