/**
 * Ops service — TECH_SPEC_V1.md §3.5 (`ops`, v1.7 Ops Replay) / task #537.
 *
 * The public ops page is a DAILY REPLAY: one immutable report per UTC day, built
 * ONCE from the curated CloudWatch dashboard, persisted to `ops_reports`, and
 * replayed client-side. Security rationale (do not weaken): there is no live
 * feedback loop for probers — the soonest observable consequence of anything is
 * tomorrow's report — and CloudWatch reads drop to ~1 fetch/day regardless of
 * traffic. This module keeps the whole v1.3 dashboard fetch / sanitize / widget-
 * shaping machinery, but retargets it at a fixed UTC day (midnight→midnight,
 * 5-minute grain, up to 288 points) instead of a trailing window.
 *
 * The BUILD is lazy and single-flight: on a request, if yesterday's (UTC) report
 * is missing AND now ≥ 00:15 UTC (CloudWatch datapoints arrive late — never clip
 * the day by building at exactly midnight), it is built. An in-process
 * single-flight map plus an idempotent `ON CONFLICT DO NOTHING` insert means
 * concurrent requests (even across instances) cannot double-build. Only a
 * SUCCESSFUL build persists — a degraded fetch leaves the day unbuilt so the next
 * request retries.
 *
 * SANITIZATION is ALLOWLIST-SHAPED (§3.5). A report widget is assembled ONLY from
 * a fixed set of fields — `{ title, computed kind/unit/latest/series }`. Raw
 * dashboard internals (dimension values like `i-…` instance ids, ARNs, account
 * ids, region, CloudWatch's auto-generated series labels) are NEVER copied
 * through. A series `label` survives only when it was an EXPLICIT user-set label
 * in the widget definition AND does not match a resource-identifier pattern;
 * otherwise it is `null`.
 *
 * DEGRADE rather than error (§3.5): a missing/empty dashboard name, an SDK/IAM
 * error, malformed dashboard JSON, or a dashboard with no renderable metric
 * widgets ALL make the build a no-op (nothing persisted) — the endpoint then 404s
 * until a report exists, never a 5xx. Only the error class name is ever logged;
 * the dashboard name never is.
 */

import type {
  MetricDataQuery,
  MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import type { Knex } from "knex";
import { getDashboard, getMetricData } from "../aws/cloudwatchService";

/** Fixed metric grain for every query — a 5-minute period (§3.5). */
export const METRIC_PERIOD_SECONDS = 300;

/** The report's fixed sample grain, in minutes (a 5-minute period → 288/day). */
export const GRAIN_MINUTES = METRIC_PERIOD_SECONDS / 60;

/**
 * Build margin (§3.5): yesterday's report is only built once now is at least this
 * many minutes past 00:00 UTC. CloudWatch datapoints for the tail of a day arrive
 * late, so building at exactly midnight would clip the last few 5-minute points.
 */
export const BUILD_MARGIN_MINUTES = 15;

/** One UTC day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cache-Control tuning (§3.5). When the served report IS the expected latest, the
 * response stays fresh until shortly after the next 00:15 UTC (when a new report
 * is due) — `CACHE_BOUNDARY_BUFFER_SECONDS` past the boundary so the lazy build
 * has landed. When the expected report is NOT built yet (or a specific older
 * `?date=` was requested), a short max-age lets the client retry soon.
 */
export const CACHE_BOUNDARY_BUFFER_SECONDS = 60;
export const CACHE_SHORT_MAX_AGE_SECONDS = 5 * 60;

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

/**
 * One immutable daily ops report (§3.5, v1.7) — the JSONB stored in
 * `ops_reports.payload`. Every series covers the FULL UTC day at a fixed 5-minute
 * grain; the widget shape is exactly the v1.3 curated shape. Never contains any
 * infra identifier. `available_dates` is NOT stored here — it is the set of all
 * stored report dates, computed and merged in at serve time.
 */
export interface OpsReport {
  report_date: string;
  generated_at: string;
  grain_minutes: number;
  widgets: OpsWidget[];
}

/** The `GET /api/ops` response — a stored report plus the day-navigation list. */
export interface OpsReportResponse extends OpsReport {
  available_dates: string[];
}

// Module-level single-flight: at most one in-process build per target UTC day, so
// a burst of concurrent cache-miss requests collapses to ONE CloudWatch fetch and
// one insert. Cross-instance double-builds are prevented by the idempotent
// `ON CONFLICT DO NOTHING` insert in `buildReportRow`.
const buildInFlight = new Map<string, Promise<void>>();

// --- Validation helpers -----------------------------------------------------

function isResourceIdentifier(s: string): boolean {
  return RESOURCE_ID_PATTERNS.some((re) => re.test(s));
}

/**
 * A series label survives only if it is not a resource identifier. For metric
 * rows without a user-set label the bare METRIC NAME (`CPUCreditBalance`) is
 * the fallback — namespace vocabulary, not an identifier, and without it a
 * multi-series widget is a pile of indistinguishable lines. Dimension values
 * never participate; the identifier scrub still runs over every candidate.
 */
function sanitizeLabel(
  explicitLabel: string | null,
  fallbackMetricName: string | null = null
): string | null {
  const candidate = explicitLabel ?? fallbackMetricName;
  if (candidate === null) return null;
  return isResourceIdentifier(candidate) ? null : candidate;
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
 * Resolve CloudWatch's dot shorthand against the previous METRIC row: `"."` at
 * a position inherits the previous row's element at that position, and `"..."`
 * splices in the remainder of the previous row's string elements from there.
 * Dashboards routinely lean on this — a widget's rows read
 * `["AWS/EC2", "CPUSurplusCreditsCharged", "AutoScalingGroupName", "asg-name"]`
 * then `[".", "CPUCreditUsage", ".", "."]` — and taken literally the dots query
 * namespace `"."` with dimension `"."="."`, which matches nothing (the bug that
 * rendered a 500+ credit balance as an empty series).
 */
function resolveDotShorthand(row: unknown, prev: unknown[] | null): unknown {
  if (!Array.isArray(row) || prev === null) return row;
  const out: unknown[] = [];
  for (const el of row) {
    if (el === "...") {
      for (let j = out.length; j < prev.length && typeof prev[j] === "string"; j++) {
        out.push(prev[j]);
      }
      continue;
    }
    if (el === "." && typeof prev[out.length] === "string") {
      out.push(prev[out.length]);
      continue;
    }
    out.push(el);
  }
  return out;
}

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

    // Pass 1 — parse every row (dot shorthand resolved against the previous
    // metric row) and collect the set of dashboard-declared ids.
    const rows: ParsedRow[] = [];
    const declaredIds = new Set<string>();
    let prevMetricRow: unknown[] | null = null;
    for (const row of metricsRaw) {
      const resolved = resolveDotShorthand(row, prevMetricRow);
      const parsedRow =
        parseMetricRow(resolved, widgetStat) ?? parseExpressionRow(resolved);
      if (!parsedRow) continue; // unknown row — skip defensively
      if (parsedRow.kind === "metric" && Array.isArray(resolved)) {
        prevMetricRow = resolved;
      }
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
        if (returnData) {
          series.push({
            id,
            label: sanitizeLabel(r.explicitLabel, r.metricName),
          });
        }
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

/**
 * Round a value for the curated shape. Metric values arrive as raw doubles
 * (`4.131730772880646`); two decimals is ample precision for a 5-minute-period
 * dashboard readout, keeps the payload compact, and means no consumer ever has
 * to defend against 15-digit floats.
 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
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
    points.push({ t, v: round2(v) });
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

// --- UTC-day helpers --------------------------------------------------------

/** The UTC calendar day of a `Date`, as `YYYY-MM-DD`. */
export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The UTC day BEFORE `now` (the report the lazy build targets). */
export function yesterdayUtc(now: Date): string {
  return utcDateString(new Date(now.getTime() - DAY_MS));
}

/** Minutes elapsed since 00:00 UTC of `now`'s day (0..1439). */
function minutesSinceUtcMidnight(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

/**
 * The newest UTC day whose report is DUE at `now` — i.e. the most recent day D
 * such that `now ≥ start-of(D+1) + BUILD_MARGIN`. When the margin has passed this
 * is yesterday; before today's 00:15 UTC it is the day before yesterday (yesterday
 * is not buildable yet). Used only to decide the Cache-Control freshness window.
 */
export function expectedLatestDate(now: Date): string {
  const marginMs = BUILD_MARGIN_MINUTES * 60 * 1000;
  return utcDateString(new Date(now.getTime() - marginMs - DAY_MS));
}

/** Milliseconds from `now` to the next 00:15 UTC boundary (strictly after now). */
function msUntilNextBuildBoundary(now: Date): number {
  const today0015 = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    BUILD_MARGIN_MINUTES,
    0
  );
  const target = now.getTime() < today0015 ? today0015 : today0015 + DAY_MS;
  return target - now.getTime();
}

/**
 * The `Cache-Control` value for a served report (§3.5). When the served report is
 * the expected latest, it stays fresh until shortly after the next 00:15 UTC
 * (when the next report is due). Otherwise — the expected report is not built yet,
 * or a specific older `?date=` was requested — a short max-age lets the client
 * retry soon (still capped so it never outlives the boundary).
 */
export function buildCacheControl(now: Date, reportDate: string): string {
  const untilBoundarySec = Math.max(
    0,
    Math.ceil(msUntilNextBuildBoundary(now) / 1000)
  );
  const maxAge =
    reportDate === expectedLatestDate(now)
      ? untilBoundarySec + CACHE_BOUNDARY_BUFFER_SECONDS
      : Math.min(CACHE_SHORT_MAX_AGE_SECONDS, untilBoundarySec);
  return `public, max-age=${maxAge}`;
}

// --- Build (retargeted at a fixed UTC day) ----------------------------------

/**
 * Fetch the dashboard and curate ONE full UTC day of metrics into the report
 * widgets. The GetMetricData window is exactly the day midnight→midnight (UTC) at
 * a 5-minute period, so every series spans the full day at 288-point grain. ANY
 * failure — SDK/IAM error, malformed dashboard JSON, empty/unrenderable widgets —
 * resolves to `null` (the build is a no-op, nothing persists); it never throws.
 * Logs the error CLASS only, NEVER the dashboard name.
 */
async function buildDayWidgets(
  dashboardName: string,
  reportDate: string
): Promise<OpsWidget[] | null> {
  try {
    const body = await getDashboard(dashboardName);
    if (!body) return null;

    let plan: PlannedWidget[];
    let queries: MetricDataQuery[];
    try {
      ({ plan, queries } = buildPlan(body));
    } catch {
      // Malformed dashboard JSON — degrade (never surface the parse error, which
      // could echo dashboard contents).
      return null;
    }
    if (plan.length === 0 || queries.length === 0) return null;

    const start = new Date(`${reportDate}T00:00:00.000Z`);
    const end = new Date(start.getTime() + DAY_MS);
    const results = await getMetricData(queries, start, end);

    const byId = new Map<string, MetricDataResult>();
    for (const r of results) {
      if (typeof r.Id === "string") byId.set(r.Id, r);
    }

    return plan.map((w) => curateWidget(w, byId));
  } catch (err) {
    // Log the error CLASS only — an AWS error message can embed the dashboard
    // name / ARNs, which must never reach a log line (§3.5).
    console.error(
      "[opsService] report build failed; leaving day unbuilt:",
      err instanceof Error ? err.name : "unknown error"
    );
    return null;
  }
}

/**
 * Build `reportDate`'s report and persist it. Only a SUCCESSFUL build is written;
 * a degraded fetch (`null` widgets) leaves the day unbuilt so a later request
 * retries. The insert is idempotent (`ON CONFLICT (report_date) DO NOTHING`) so
 * two instances racing to build the same day cannot double-write — the loser's
 * insert is a no-op and the winner's row stands.
 */
async function buildReportRow(
  db: Knex,
  dashboardName: string,
  reportDate: string,
  now: Date
): Promise<void> {
  const widgets = await buildDayWidgets(dashboardName, reportDate);
  if (!widgets) return; // degrade — only successful builds persist

  const payload: OpsReport = {
    report_date: reportDate,
    generated_at: now.toISOString(),
    grain_minutes: GRAIN_MINUTES,
    widgets,
  };

  await db("ops_reports")
    .insert({
      report_date: reportDate,
      generated_at: now,
      payload: JSON.stringify(payload),
    })
    .onConflict("report_date")
    .ignore();
}

/**
 * Lazy build (§3.5): if yesterday's (UTC) report is missing AND now ≥ 00:15 UTC,
 * build it — single-flight in-process so a burst of concurrent requests triggers
 * exactly one CloudWatch fetch + one insert. With no dashboard name there is
 * nothing to build (and no AWS call). Never throws — a build failure degrades to a
 * no-op and the request falls through to whatever is already stored.
 */
async function ensureReport(
  db: Knex,
  dashboardName: string,
  now: Date
): Promise<void> {
  if (!dashboardName) return;
  if (minutesSinceUtcMidnight(now) < BUILD_MARGIN_MINUTES) return;

  const target = yesterdayUtc(now);

  // Fast path: already stored → no build, no CloudWatch call.
  const existing = await db("ops_reports")
    .where({ report_date: target })
    .first();
  if (existing) return;

  let p = buildInFlight.get(target);
  if (!p) {
    p = buildReportRow(db, dashboardName, target, now).finally(() =>
      buildInFlight.delete(target)
    );
    buildInFlight.set(target, p);
  }
  await p;
}

// --- Read / serve -----------------------------------------------------------

/** Read one stored report's payload — a specific `date` or the latest. */
async function readReport(
  db: Knex,
  date: string | undefined
): Promise<OpsReport | null> {
  const query = db("ops_reports");
  const row = date
    ? await query.where({ report_date: date }).first()
    : await query.orderBy("report_date", "desc").first();
  return row ? (row.payload as OpsReport) : null;
}

/** Every stored report's `report_date`, newest first, as `YYYY-MM-DD` strings. */
async function availableDates(db: Knex): Promise<string[]> {
  const rows = await db("ops_reports")
    .select(db.raw("to_char(report_date, 'YYYY-MM-DD') AS report_date"))
    .orderBy("report_date", "desc");
  return rows.map((r: { report_date: string }) => r.report_date);
}

/**
 * The `GET /api/ops` payload (§3.5, v1.7): trigger the lazy build, then serve the
 * requested stored report (a specific `date`, else the latest) with the
 * day-navigation `available_dates` merged in. Resolves to `null` when no matching
 * report exists (the router 404s) — before the first day is built, or an
 * in-range-but-unbuilt `date`.
 */
export async function getOpsReport(
  db: Knex,
  dashboardName: string | null | undefined,
  opts: { date?: string; now: Date }
): Promise<OpsReportResponse | null> {
  await ensureReport(db, dashboardName ?? "", opts.now);

  const report = await readReport(db, opts.date);
  if (!report) return null;

  return { ...report, available_dates: await availableDates(db) };
}

/** Test-only: clear the in-flight build map. */
export function _resetOpsForTests(): void {
  buildInFlight.clear();
}
