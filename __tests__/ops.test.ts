import request from "supertest";

/**
 * /api/ops tests — TECH_SPEC_V1.md §3.4/§3.5/§4.1 (v1.3) / task #488.
 *
 * The CloudWatch SDK module (`@aws-sdk/client-cloudwatch`) is FULLY jest.mocked —
 * AWS is unreachable in this container (hard rule / pre-checks §7) and never
 * called. The mock's `send` routes on the command class name to return a
 * realistic-but-FAKE dashboard body and fake metric-data results. Every fixture
 * identifier (dashboard name, instance ids, ARNs, account ids) is obviously fake.
 *
 * Covered: the curated happy path (dashboard JSON → curated shape), gauge/chart
 * inference, unit mapping, expression-row skipping, `?window_hours=` validation,
 * the ~5-minute cache + single-flight, every degrade case → `{ available: false }`
 * (no name, SDK error, malformed JSON, empty widgets), the ALLOWLIST sanitization
 * leak test (fake ARNs/instance-ids/account-ids appear NOWHERE in the response),
 * the `ops` section schema, and that publish accepts an `ops` section.
 */

// --- Mock the CloudWatch SDK module. `send` is routed by the test per case. ---
const mockSend = jest.fn();
class MockGetDashboardCommand {
  constructor(public input: unknown) {}
}
class MockGetMetricDataCommand {
  constructor(public input: unknown) {}
}
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockSend })),
  GetDashboardCommand: MockGetDashboardCommand,
  GetMetricDataCommand: MockGetMetricDataCommand,
}));

import app from "../src/app";
import { IAppSecrets } from "../src/interfaces";
import {
  getOps,
  parseWindowHours,
  deriveUnit,
  _resetOpsForTests,
  OPS_CACHE_TTL_MS,
  DEFAULT_WINDOW_HOURS,
  METRIC_PERIOD_SECONDS,
} from "../src/services/opsService";
import { resetCloudWatch } from "../src/aws/cloudwatchService";
import {
  opsData,
  SECTION_DATA_SCHEMAS,
  SECTION_TYPES,
  DRAFT_SECTION_DATA_SCHEMAS,
} from "../src/schemas";

// Obviously-fake infra identifiers that must NEVER surface in a response.
const DASHBOARD_NAME = "fake-portfolio-ops-dashboard-DO-NOT-LEAK";
const FAKE_INSTANCE_ID = "i-0abcdef1234567890";
const FAKE_ARN = "arn:aws:ecs:us-east-1:000000000000:service/fake-svc";
const FAKE_ACCOUNT_ID = "000000000000";
const FAKE_TARGET_GROUP = "app/fake-alb/0123456789abcdef";
const FAKE_DB_ID = "fake-db-instance-DO-NOT-LEAK";
const FAKE_VOL_ID = "vol-0fedcba9876543210";

/**
 * A realistic-but-FAKE CloudWatch dashboard body. Three metric widgets:
 *   1. CPU Utilization — single Percent series → gauge, display unit "%".
 *      Its metric row carries a fake instance-id dimension AND an explicit
 *      resource-identifier label (must be scrubbed to null).
 *   2. Network Throughput — TWO metric series (multi-metric) with a throughput
 *      unit → chart, display unit "MB/s"; one row has a clean explicit label
 *      (passes through) plus a trailing EXPRESSION row that must be SKIPPED.
 *   3. A non-metric ("text") widget that must be ignored entirely.
 */
function dashboardBody(): string {
  return JSON.stringify({
    widgets: [
      {
        type: "metric",
        properties: {
          title: "CPU Utilization",
          view: "timeSeries",
          region: "us-east-1",
          stat: "Average",
          unit: "Percent",
          metrics: [
            [
              "AWS/ECS",
              "CPUUtilization",
              "InstanceId",
              FAKE_INSTANCE_ID,
              { label: FAKE_ARN },
            ],
          ],
        },
      },
      {
        type: "metric",
        properties: {
          title: "Network Throughput",
          view: "timeSeries",
          stat: "Sum",
          yAxis: { left: { label: "Bytes/Second" } },
          metrics: [
            [
              "AWS/ECS",
              "NetworkTxBytes",
              "ServiceArn",
              FAKE_ARN,
              { label: "Transmit", stat: "Average" },
            ],
            ["AWS/ECS", "NetworkRxBytes", "ServiceArn", FAKE_ARN],
            [{ expression: "m0+m1", label: FAKE_ACCOUNT_ID, id: "e1" }],
          ],
        },
      },
      {
        type: "text",
        properties: { markdown: `see ${FAKE_TARGET_GROUP} / ${FAKE_ACCOUNT_ID}` },
      },
    ],
  });
}

/** Fake GetMetricData results — three series (m0, m1, m2), ascending time. */
function metricDataResults() {
  return {
    MetricDataResults: [
      {
        Id: "m0",
        Timestamps: [
          new Date("2026-08-03T10:00:00Z"),
          new Date("2026-08-03T10:05:00Z"),
        ],
        Values: [41.5, 47.201730772880646], // raw double — curated shape rounds to 2dp
      },
      {
        Id: "m1",
        Timestamps: [
          new Date("2026-08-03T10:00:00Z"),
          new Date("2026-08-03T10:05:00Z"),
        ],
        Values: [1000, 2000],
      },
      {
        Id: "m2",
        Timestamps: [
          new Date("2026-08-03T10:00:00Z"),
          new Date("2026-08-03T10:05:00Z"),
        ],
        Values: [3000, 4000],
      },
    ],
  };
}

/** Route `send` on the command class: dashboard body, then metric-data. */
function wireHappyPath() {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof MockGetDashboardCommand) {
      return Promise.resolve({ DashboardBody: dashboardBody() });
    }
    if (command instanceof MockGetMetricDataCommand) {
      return Promise.resolve(metricDataResults());
    }
    return Promise.reject(new Error("unexpected command"));
  });
}

beforeEach(() => {
  mockSend.mockReset();
  _resetOpsForTests();
  resetCloudWatch();
});

describe("parseWindowHours (§3.5 validation)", () => {
  it("accepts integers within 1..24", () => {
    expect(parseWindowHours("1")).toBe(1);
    expect(parseWindowHours("24")).toBe(24);
    expect(parseWindowHours("6")).toBe(6);
  });

  it("degrades to the default (3) for missing/invalid/out-of-range values", () => {
    expect(parseWindowHours(undefined)).toBe(DEFAULT_WINDOW_HOURS);
    expect(parseWindowHours("")).toBe(DEFAULT_WINDOW_HOURS);
    expect(parseWindowHours("0")).toBe(DEFAULT_WINDOW_HOURS);
    expect(parseWindowHours("25")).toBe(DEFAULT_WINDOW_HOURS);
    expect(parseWindowHours("3.5")).toBe(DEFAULT_WINDOW_HOURS);
    expect(parseWindowHours("abc")).toBe(DEFAULT_WINDOW_HOURS);
    expect(parseWindowHours(["7", "8"])).toBe(7); // first repeated value
  });
});

describe("getOps (§3.5 curated shape)", () => {
  it("curates the dashboard into the §3.5 shape", async () => {
    wireHappyPath();
    const result = await getOps(DASHBOARD_NAME, 3);
    expect(result).toEqual({
      available: true,
      window_hours: 3,
      widgets: [
        {
          title: "CPU Utilization",
          kind: "gauge", // single Percent series
          unit: "%",
          latest: 47.2, // last point of the first series, rounded to 2dp
          series: [
            {
              label: null, // explicit label was an ARN → scrubbed
              points: [
                { t: "2026-08-03T10:00:00.000Z", v: 41.5 },
                { t: "2026-08-03T10:05:00.000Z", v: 47.2 },
              ],
            },
          ],
        },
        {
          title: "Network Throughput",
          kind: "chart", // multi-series
          unit: "MB/s",
          latest: 2000,
          series: [
            {
              label: "Transmit", // clean explicit label passes through
              points: [
                { t: "2026-08-03T10:00:00.000Z", v: 1000 },
                { t: "2026-08-03T10:05:00.000Z", v: 2000 },
              ],
            },
            {
              // No explicit label → the bare metric name (namespace vocabulary,
              // not an identifier) is the fallback so multi-series widgets stay
              // distinguishable. Dimension values still never appear.
              label: "NetworkRxBytes",
              points: [
                { t: "2026-08-03T10:00:00.000Z", v: 3000 },
                { t: "2026-08-03T10:05:00.000Z", v: 4000 },
              ],
            },
          ],
        },
      ],
    });
  });

  it("skips the expression row — the multi-metric widget has exactly 2 series", async () => {
    wireHappyPath();
    const result = await getOps(DASHBOARD_NAME, 3);
    if (!result.available) throw new Error("expected available");
    expect(result.widgets[1].series).toHaveLength(2);
  });

  it("builds ONE GetMetricData call at period 300 covering every series", async () => {
    wireHappyPath();
    await getOps(DASHBOARD_NAME, 3);

    const metricCalls = mockSend.mock.calls.filter(
      ([c]) => c instanceof MockGetMetricDataCommand
    );
    expect(metricCalls).toHaveLength(1);
    const input = (metricCalls[0][0] as MockGetMetricDataCommand)
      .input as Record<string, any>;
    expect(input.MetricDataQueries).toHaveLength(3);
    for (const q of input.MetricDataQueries) {
      expect(q.MetricStat.Period).toBe(METRIC_PERIOD_SECONDS);
    }
    // window_hours=3 → the query window spans 3 hours.
    const span = input.EndTime.getTime() - input.StartTime.getTime();
    expect(span).toBe(3 * 60 * 60 * 1000);
  });

  it("infers gauge from a gauge-y title even without a Percent unit", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({
          DashboardBody: JSON.stringify({
            widgets: [
              {
                type: "metric",
                properties: {
                  title: "Disk used (%)",
                  metrics: [["AWS/EC2", "DiskUsed"]],
                },
              },
            ],
          }),
        });
      }
      return Promise.resolve({
        MetricDataResults: [
          { Id: "m0", Timestamps: [new Date("2026-08-03T10:00:00Z")], Values: [88] },
        ],
      });
    });

    const result = await getOps(DASHBOARD_NAME, 3);
    if (!result.available) throw new Error("expected available");
    expect(result.widgets[0].kind).toBe("gauge");
    // DEFECT 2: the title heuristic maps a "(%)" suffix to "%" even with no
    // unit prop and no yAxis label.
    expect(result.widgets[0].unit).toBe("%");
    expect(result.widgets[0].latest).toBe(88);
  });
});

describe("getOps sanitization — ALLOWLIST leak test (§3.5)", () => {
  it("emits NONE of the fake ARNs / instance-ids / account-ids anywhere", async () => {
    wireHappyPath();
    const result = await getOps(DASHBOARD_NAME, 3);
    const serialized = JSON.stringify(result);
    for (const secret of [
      DASHBOARD_NAME,
      FAKE_INSTANCE_ID,
      FAKE_ARN,
      FAKE_ACCOUNT_ID,
      FAKE_TARGET_GROUP,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("scrubs a resource-identifier label even when user-set", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({
          DashboardBody: JSON.stringify({
            widgets: [
              {
                type: "metric",
                properties: {
                  title: "Requests",
                  metrics: [
                    ["AWS/App", "Count", "Tg", "x", { label: FAKE_TARGET_GROUP }],
                    ["AWS/App", "Count", "Tg", "y", { label: FAKE_INSTANCE_ID }],
                    ["AWS/App", "Count", "Tg", "z", { label: FAKE_ARN }],
                    ["AWS/App", "Count", "Tg", "w", { label: `x-${FAKE_ACCOUNT_ID}` }],
                  ],
                },
              },
            ],
          }),
        });
      }
      return Promise.resolve({
        MetricDataResults: [
          { Id: "m0", Timestamps: [], Values: [] },
          { Id: "m1", Timestamps: [], Values: [] },
          { Id: "m2", Timestamps: [], Values: [] },
          { Id: "m3", Timestamps: [], Values: [] },
        ],
      });
    });

    const result = await getOps(DASHBOARD_NAME, 3);
    if (!result.available) throw new Error("expected available");
    for (const s of result.widgets[0].series) {
      expect(s.label).toBeNull();
    }
  });
});

/**
 * A FAKE dashboard exercising DEFECT 1 (math expressions). Two expression
 * widgets, each: two HIDDEN source metrics (visible:false, carrying fake infra
 * dimensions) + one expression row that GetMetricData executes server-side.
 *   A) "RDS - Memory Used (%)" — expression yields a percent → gauge, unit "%".
 *   B) "Disk Throughput (MB/s)" — expression yields a rate → unit "MB/s".
 */
const EXPR_MEMORY_STRING = "((m2-m1)/m2)*100";
const EXPR_THROUGHPUT_STRING = "(r1+r2)/1048576/300";

function expressionDashboardBody(): string {
  return JSON.stringify({
    widgets: [
      {
        type: "metric",
        properties: {
          title: "RDS - Memory Used (%)",
          view: "gauge",
          metrics: [
            [
              "AWS/RDS",
              "FreeableMemory",
              "DBInstanceIdentifier",
              FAKE_DB_ID,
              { id: "m1", visible: false },
            ],
            [
              "AWS/RDS",
              "TotalMemory",
              "DBInstanceIdentifier",
              FAKE_DB_ID,
              { id: "m2", visible: false },
            ],
            [{ expression: EXPR_MEMORY_STRING, label: "Memory %", id: "e1" }],
          ],
        },
      },
      {
        type: "metric",
        properties: {
          title: "Disk Throughput (MB/s)",
          metrics: [
            ["AWS/EBS", "ReadBytes", "VolumeId", FAKE_VOL_ID, { id: "r1", visible: false }],
            ["AWS/EBS", "WriteBytes", "VolumeId", FAKE_VOL_ID, { id: "r2", visible: false }],
            [{ expression: EXPR_THROUGHPUT_STRING, label: "Throughput", id: "x1" }],
          ],
        },
      },
    ],
  });
}

/**
 * Stand in for CloudWatch executing the expressions: return a result for each
 * ReturnData=true query (the expression rows) keyed by its generated Id, with
 * fabricated values (percent 0–100 for the memory expression, an MB/s rate for
 * throughput). Hidden (ReturnData=false) source metrics return nothing, exactly
 * as GetMetricData behaves.
 */
function metricDataFromQueries(input: Record<string, any>) {
  const ts = [
    new Date("2026-08-03T10:00:00Z"),
    new Date("2026-08-03T10:05:00Z"),
  ];
  const results = (input.MetricDataQueries as any[])
    .filter((q) => q.ReturnData === true)
    .map((q) => ({
      Id: q.Id,
      Timestamps: ts,
      // The memory expression id resolves to a percent; the other to a rate.
      Values: String(q.Id).includes("e1") ? [55.0, 61.5] : [12.5, 18.0],
    }));
  return { MetricDataResults: results };
}

function wireExpressionPath() {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof MockGetDashboardCommand) {
      return Promise.resolve({ DashboardBody: expressionDashboardBody() });
    }
    if (command instanceof MockGetMetricDataCommand) {
      const input = (command as MockGetMetricDataCommand).input as Record<
        string,
        any
      >;
      return Promise.resolve(metricDataFromQueries(input));
    }
    return Promise.reject(new Error("unexpected command"));
  });
}

describe("getOps math expressions (§3.5, DEFECT 1)", () => {
  it("renders the percent EXPRESSION as a gauge with a 0–100 latest", async () => {
    wireExpressionPath();
    const result = await getOps(DASHBOARD_NAME, 3);
    if (!result.available) throw new Error("expected available");

    const memory = result.widgets[0];
    expect(memory.title).toBe("RDS - Memory Used (%)");
    expect(memory.kind).toBe("gauge"); // single expression series, percent unit
    expect(memory.unit).toBe("%");
    expect(memory.series).toHaveLength(1); // ONLY the expression renders
    expect(memory.series[0].label).toBe("Memory %"); // clean user label
    expect(memory.latest).toBe(61.5);
    expect(memory.latest).toBeGreaterThanOrEqual(0);
    expect(memory.latest).toBeLessThanOrEqual(100);
    expect(memory.series[0].points).toEqual([
      { t: "2026-08-03T10:00:00.000Z", v: 55.0 },
      { t: "2026-08-03T10:05:00.000Z", v: 61.5 },
    ]);
  });

  it("derives unit 'MB/s' for a '(MB/s)' expression widget", async () => {
    wireExpressionPath();
    const result = await getOps(DASHBOARD_NAME, 3);
    if (!result.available) throw new Error("expected available");

    const throughput = result.widgets[1];
    expect(throughput.title).toBe("Disk Throughput (MB/s)");
    expect(throughput.unit).toBe("MB/s");
    expect(throughput.series).toHaveLength(1);
    expect(throughput.series[0].label).toBe("Throughput");
    expect(throughput.latest).toBe(18.0);
  });

  it("leaks NONE of the expression strings, hidden-metric query ids, or dimensions", async () => {
    wireExpressionPath();
    const result = await getOps(DASHBOARD_NAME, 3);
    const serialized = JSON.stringify(result);
    for (const secret of [
      EXPR_MEMORY_STRING,
      EXPR_THROUGHPUT_STRING,
      FAKE_DB_ID,
      FAKE_VOL_ID,
      // per-widget prefixed query ids for the hidden source metrics.
      "w0_m1",
      "w0_m2",
      "w1_r1",
      "w1_r2",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("batches BOTH hidden metrics and expressions into ONE GetMetricData call", async () => {
    wireExpressionPath();
    await getOps(DASHBOARD_NAME, 3);

    const metricCalls = mockSend.mock.calls.filter(
      ([c]) => c instanceof MockGetMetricDataCommand
    );
    expect(metricCalls).toHaveLength(1); // one batched call for both widgets

    const input = (metricCalls[0][0] as MockGetMetricDataCommand).input as Record<
      string,
      any
    >;
    const queries = input.MetricDataQueries as any[];
    // 2 hidden source metrics + 1 expression, per widget × 2 widgets = 6.
    expect(queries).toHaveLength(6);

    const metricStatQueries = queries.filter((q) => q.MetricStat);
    const expressionQueries = queries.filter((q) => q.Expression);
    expect(metricStatQueries).toHaveLength(4);
    expect(expressionQueries).toHaveLength(2);

    // Source metrics feed the expression only → ReturnData:false.
    for (const q of metricStatQueries) {
      expect(q.ReturnData).toBe(false);
      expect(q.MetricStat.Period).toBe(METRIC_PERIOD_SECONDS);
    }
    // Expressions are the rendered series → ReturnData:true, ids rewritten to the
    // collision-free per-widget global ids so they resolve.
    for (const q of expressionQueries) {
      expect(q.ReturnData).toBe(true);
      expect(typeof q.Expression).toBe("string");
    }
    const memoryExpr = expressionQueries.find((q) => q.Id === "w0_e1");
    expect(memoryExpr.Expression).toBe("((w0_m2-w0_m1)/w0_m2)*100");
    const throughputExpr = expressionQueries.find((q) => q.Id === "w1_x1");
    expect(throughputExpr.Expression).toBe("(w1_r1+w1_r2)/1048576/300");
  });

  it("scrubs an expression label that is a resource identifier", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({
          DashboardBody: JSON.stringify({
            widgets: [
              {
                type: "metric",
                properties: {
                  title: "Derived",
                  metrics: [
                    ["AWS/X", "A", { id: "m1", visible: false }],
                    ["AWS/X", "B", { id: "m2", visible: false }],
                    [{ expression: "m1+m2", label: FAKE_ARN, id: "e1" }],
                  ],
                },
              },
            ],
          }),
        });
      }
      const input = (command as MockGetMetricDataCommand).input as Record<
        string,
        any
      >;
      return Promise.resolve(metricDataFromQueries(input));
    });

    const result = await getOps(DASHBOARD_NAME, 3);
    if (!result.available) throw new Error("expected available");
    expect(result.widgets[0].series[0].label).toBeNull(); // ARN label scrubbed
    expect(JSON.stringify(result)).not.toContain(FAKE_ARN);
  });
});

describe("deriveUnit (§3.5, DEFECT 2 — pure unit derivation)", () => {
  it("(a) maps an explicit unit / yAxis label", () => {
    expect(deriveUnit("Percent", "", null)).toBe("%");
    expect(deriveUnit("Bytes/Second", "", null)).toBe("MB/s");
    expect(deriveUnit("Megabytes/Second", "", null)).toBe("MB/s");
    expect(deriveUnit("MB/s", "", null)).toBe("MB/s"); // already a display unit
  });

  it("(b) falls back to a title heuristic", () => {
    expect(deriveUnit(null, "CPU Utilization", null)).toBe("%");
    expect(deriveUnit(null, "RDS - Memory Used (%)", null)).toBe("%");
    expect(deriveUnit(null, "Disk Throughput (MB/s)", null)).toBe("MB/s");
    expect(deriveUnit(null, "Requests (req/s)", null)).toBe("req/s"); // verbatim
    expect(deriveUnit(null, "Latency (ms)", null)).toBe("ms");
    // A non-unit parenthetical is NOT a unit — "CPU Credits (ASG)" ≠ "0 ASG".
    expect(deriveUnit(null, "EC2 - CPU Credits (ASG)", null)).toBeNull();
    expect(deriveUnit(null, "Just a title", null)).toBeNull();
  });

  it("(c) falls back to the metric's standard unit", () => {
    expect(deriveUnit(null, "Plain", "Percent")).toBe("%");
    expect(deriveUnit(null, "Plain", "Bytes")).toBe("B");
    expect(deriveUnit(null, "Plain", "Count")).toBeNull(); // a bare count → null
    expect(deriveUnit(null, "Plain", null)).toBeNull();
  });

  it("honours priority: props > title > standard unit", () => {
    expect(deriveUnit("Percent", "X (MB/s)", "Bytes")).toBe("%");
    // an unmappable prop label falls through to the title heuristic.
    expect(deriveUnit("Requests", "X (MB/s)", "Bytes")).toBe("MB/s");
  });
});

describe("getOps cache + single-flight (§3.5)", () => {
  it("serves the ~5-minute cache — CloudWatch called once for repeat reads", async () => {
    wireHappyPath();
    await getOps(DASHBOARD_NAME, 3);
    await getOps(DASHBOARD_NAME, 3);
    const dashCalls = mockSend.mock.calls.filter(
      ([c]) => c instanceof MockGetDashboardCommand
    );
    expect(dashCalls).toHaveLength(1);
  });

  it("re-fetches after the ~5-minute TTL elapses", async () => {
    jest.useFakeTimers();
    try {
      wireHappyPath();
      await getOps(DASHBOARD_NAME, 3);
      jest.advanceTimersByTime(OPS_CACHE_TTL_MS + 1_000);
      await getOps(DASHBOARD_NAME, 3);
      const dashCalls = mockSend.mock.calls.filter(
        ([c]) => c instanceof MockGetDashboardCommand
      );
      expect(dashCalls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("collapses a burst of concurrent cache-miss reads to one fetch", async () => {
    // Deferred created up front so its resolver is valid before `send` is even
    // reached (getDashboard's dynamic import() delays the actual SDK call).
    let resolveDash: (v: unknown) => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveDash = () => resolve();
    });
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return gate.then(() => ({ DashboardBody: dashboardBody() }));
      }
      return Promise.resolve(metricDataResults());
    });

    const inFlight = Promise.all([
      getOps(DASHBOARD_NAME, 3),
      getOps(DASHBOARD_NAME, 3),
      getOps(DASHBOARD_NAME, 3),
    ]);
    resolveDash(undefined);
    await inFlight;

    const dashCalls = mockSend.mock.calls.filter(
      ([c]) => c instanceof MockGetDashboardCommand
    );
    expect(dashCalls).toHaveLength(1);
  });

  it("does not cache a failure — the next read retries", async () => {
    mockSend.mockRejectedValueOnce(new Error("AccessDenied"));
    expect(await getOps(DASHBOARD_NAME, 3)).toEqual({ available: false });

    wireHappyPath();
    const ok = await getOps(DASHBOARD_NAME, 3);
    expect(ok.available).toBe(true);
  });
});

describe("getOps degrade cases (§3.5) — always { available: false }", () => {
  it("no dashboard name → unavailable, makes NO SDK call", async () => {
    expect(await getOps("", 3)).toEqual({ available: false });
    expect(await getOps(null, 3)).toEqual({ available: false });
    expect(await getOps(undefined, 3)).toEqual({ available: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("SDK / IAM error (GetDashboard rejects) → unavailable", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error("User is not authorized"), {
        name: "AccessDeniedException",
      })
    );
    expect(await getOps(DASHBOARD_NAME, 3)).toEqual({ available: false });
  });

  it("empty DashboardBody → unavailable", async () => {
    mockSend.mockResolvedValue({ DashboardBody: undefined });
    expect(await getOps(DASHBOARD_NAME, 3)).toEqual({ available: false });
  });

  it("malformed dashboard JSON → unavailable", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({ DashboardBody: "{not valid json" });
      }
      return Promise.resolve(metricDataResults());
    });
    expect(await getOps(DASHBOARD_NAME, 3)).toEqual({ available: false });
  });

  it("dashboard with no renderable metric widgets → unavailable", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({
          DashboardBody: JSON.stringify({
            widgets: [
              { type: "text", properties: { markdown: "hi" } },
              // A metric widget whose only row is an expression → 0 series.
              {
                type: "metric",
                properties: { metrics: [[{ expression: "m0", id: "e0" }]] },
              },
            ],
          }),
        });
      }
      return Promise.resolve(metricDataResults());
    });
    expect(await getOps(DASHBOARD_NAME, 3)).toEqual({ available: false });
  });

  it("GetMetricData rejects (after a good dashboard) → unavailable", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({ DashboardBody: dashboardBody() });
      }
      return Promise.reject(new Error("Throttling"));
    });
    expect(await getOps(DASHBOARD_NAME, 3)).toEqual({ available: false });
  });
});

describe("ops section schema (§3.4/§3.5, §3.9)", () => {
  it("is a registered publishable section type", () => {
    expect(SECTION_TYPES).toContain("ops");
    expect(SECTION_DATA_SCHEMAS.ops).toBeDefined();
  });

  it("defaults window_hours to 3 and accepts an optional heading", () => {
    const res = opsData.safeParse({ heading: "System health" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.window_hours).toBe(3);
      expect(res.data.heading).toBe("System health");
    }
  });

  it("accepts window_hours within 1..24 and rejects out-of-range / non-integers", () => {
    expect(opsData.safeParse({ window_hours: 1 }).success).toBe(true);
    expect(opsData.safeParse({ window_hours: 24 }).success).toBe(true);
    expect(opsData.safeParse({ window_hours: 0 }).success).toBe(false);
    expect(opsData.safeParse({ window_hours: 25 }).success).toBe(false);
    expect(opsData.safeParse({ window_hours: 3.5 }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      opsData.safeParse({ window_hours: 3, surprise: 1 }).success
    ).toBe(false);
  });

  it("draft-lenient variant: window_hours may be absent but a bad one still fails (§3.9)", () => {
    const draftOps = DRAFT_SECTION_DATA_SCHEMAS.ops;
    expect(draftOps.safeParse({}).success).toBe(true);
    expect(draftOps.safeParse({ heading: "WIP" }).success).toBe(true);
    expect(draftOps.safeParse({ window_hours: 99 }).success).toBe(false);
    expect(draftOps.safeParse({ surprise: true }).success).toBe(false);
  });
});

describe("GET /api/ops (§4.1) — public, never leaks the name, never 5xx", () => {
  function withSecrets(secrets: Partial<IAppSecrets>) {
    app.set("secrets", secrets);
  }

  afterEach(() => {
    app.set("secrets", undefined);
  });

  it("returns the curated shape and NO infra identifier when configured", async () => {
    withSecrets({ cloudwatch_dashboard_name: DASHBOARD_NAME });
    wireHappyPath();

    const res = await request(app).get("/api/ops");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    const serialized = JSON.stringify(res.body);
    for (const secret of [
      DASHBOARD_NAME,
      FAKE_INSTANCE_ID,
      FAKE_ARN,
      FAKE_ACCOUNT_ID,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("honours ?window_hours= and reflects it in the payload", async () => {
    withSecrets({ cloudwatch_dashboard_name: DASHBOARD_NAME });
    wireHappyPath();

    const res = await request(app).get("/api/ops?window_hours=12");

    expect(res.status).toBe(200);
    expect(res.body.window_hours).toBe(12);
  });

  it("returns 200 { available: false } (not a 5xx) with no dashboard name", async () => {
    withSecrets({});
    const res = await request(app).get("/api/ops");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns 200 { available: false } when CloudWatch is unreachable", async () => {
    withSecrets({ cloudwatch_dashboard_name: DASHBOARD_NAME });
    mockSend.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(app).get("/api/ops");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });
});
