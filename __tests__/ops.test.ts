import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

/**
 * /api/ops tests — Ops Replay v1.7 (TECH_SPEC_V1.md §3.4/§3.5/§4.1) / task #537.
 *
 * The public ops page is a DAILY REPLAY: one immutable report per UTC day, built
 * ONCE from the curated CloudWatch dashboard, persisted to `ops_reports`, and
 * replayed client-side. These tests run the real service + router against a
 * throwaway Postgres 15 cluster (unix-socket-only, under /tmp, exactly as
 * agent-pre-checks.md documents) with the CloudWatch SDK FULLY jest.mocked — AWS
 * is unreachable in this container (hard rule / pre-checks §7) and never called.
 * The clock is INJECTED into the service (`now`) so no assertion depends on real
 * `Date.now()`; the `pg` client is given an explicit `user` (unlike psql it does
 * not infer the OS user).
 *
 * Covered: lazy build honours the 00:15 UTC margin, is single-flight (concurrent
 * requests collapse to one fetch + one row) and DB-idempotent (ON CONFLICT DO
 * NOTHING); the curated full-UTC-day widget shape is retained (gauge/chart, unit
 * mapping, math expressions, dot shorthand); the ALLOWLIST sanitization leak test
 * (fake ARNs/instance-ids/account-ids appear NOWHERE); report rows round-trip;
 * `?date=` behaviour + `available_dates`; midnight-aware `Cache-Control`; the
 * degrade cases (no name, SDK error, malformed JSON, empty widgets) leave the day
 * unbuilt (404, never a 5xx); and the v1.7 `ops` section schema (`window_hours`
 * removed).
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
import { initDb, closeDb, getDb } from "../src/db/db";
import {
  getOpsReport,
  deriveUnit,
  buildCacheControl,
  expectedLatestDate,
  yesterdayUtc,
  utcDateString,
  _resetOpsForTests,
  GRAIN_MINUTES,
  CACHE_BOUNDARY_BUFFER_SECONDS,
  CACHE_SHORT_MAX_AGE_SECONDS,
  METRIC_PERIOD_SECONDS,
  OpsWidget,
} from "../src/services/opsService";
import { resetCloudWatch } from "../src/aws/cloudwatchService";
import {
  opsData,
  SECTION_DATA_SCHEMAS,
  SECTION_TYPES,
  DRAFT_SECTION_DATA_SCHEMAS,
} from "../src/schemas";

// --- Throwaway Postgres cluster (agent-pre-checks.md) ------------------------
const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55460"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_ops_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task537");

function pgBin(name: string): string {
  return path.join(PG_BIN, name);
}

function startCluster(): void {
  if (fs.existsSync(DATA_DIR)) {
    try {
      execFileSync(pgBin("pg_ctl"), ["-D", DATA_DIR, "stop", "-m", "immediate"], {
        stdio: "ignore",
      });
    } catch {
      /* not running */
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  execFileSync(pgBin("initdb"), ["-D", DATA_DIR, "-U", PG_USER], {
    stdio: "ignore",
  });
  execFileSync(
    pgBin("pg_ctl"),
    [
      "-D",
      DATA_DIR,
      "-o",
      `-k ${PG_SOCKET_DIR} -p ${PG_PORT} -c listen_addresses=''`,
      "-w",
      "start",
    ],
    { stdio: "ignore" }
  );
  execFileSync(
    pgBin("createdb"),
    ["-h", PG_SOCKET_DIR, "-p", PG_PORT, "-U", PG_USER, TEST_DB],
    { stdio: "ignore" }
  );
}

function stopCluster(): void {
  try {
    execFileSync(pgBin("pg_ctl"), ["-D", DATA_DIR, "stop", "-m", "immediate"], {
      stdio: "ignore",
    });
  } catch {
    /* already stopped */
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

// Obviously-fake infra identifiers that must NEVER surface in a report.
const DASHBOARD_NAME = "fake-portfolio-ops-dashboard-DO-NOT-LEAK";
const FAKE_INSTANCE_ID = "i-0abcdef1234567890";
const FAKE_ARN = "arn:aws:ecs:us-east-1:000000000000:service/fake-svc";
const FAKE_ACCOUNT_ID = "000000000000";
const FAKE_TARGET_GROUP = "app/fake-alb/0123456789abcdef";
const FAKE_DB_ID = "fake-db-instance-DO-NOT-LEAK";
const FAKE_VOL_ID = "vol-0fedcba9876543210";

// A fixed injected clock. `now` = 2026-08-04T02:00Z → the lazy build targets
// yesterday (2026-08-03), and 02:00 is past the 00:15 build margin.
const NOW = new Date("2026-08-04T02:00:00.000Z");
const YESTERDAY = "2026-08-03";

/**
 * A realistic-but-FAKE CloudWatch dashboard body (same as the v1.3 fixture).
 * Three metric widgets: a single-Percent gauge (with a scrubbed instance-id +
 * ARN label), a two-series throughput chart (+ a trailing EXPRESSION row that is
 * SKIPPED), and a non-metric text widget that is ignored.
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

/** Build (and serve) yesterday's report for the fixed injected clock. */
function buildAndServe(now: Date = NOW, date?: string) {
  return getOpsReport(getDb(), DASHBOARD_NAME, { now, date });
}

function dashCallCount(): number {
  return mockSend.mock.calls.filter(
    ([c]) => c instanceof MockGetDashboardCommand
  ).length;
}

async function reportRowCount(): Promise<number> {
  const { rows } = await getDb().raw(
    "SELECT count(*)::int AS n FROM ops_reports"
  );
  return rows[0].n;
}

beforeAll(async () => {
  startCluster();
  await initDb(
    {
      host: PG_SOCKET_DIR,
      port: parseInt(PG_PORT, 10),
      user: PG_USER,
      password: "",
      database: TEST_DB,
      ssl: false,
    },
    { runMigrations: true }
  );
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(async () => {
  mockSend.mockReset();
  _resetOpsForTests();
  resetCloudWatch();
  await getDb().raw("TRUNCATE ops_reports");
});

// ---------------------------------------------------------------------------

describe("lazy build — 00:15 UTC margin, single-flight, idempotent (§3.5)", () => {
  it("does NOT build before 00:15 UTC — no CloudWatch call, nothing stored", async () => {
    wireHappyPath();
    const res = await buildAndServe(new Date("2026-08-04T00:05:00.000Z"));
    expect(res).toBeNull(); // nothing built yet → 404-worthy
    expect(mockSend).not.toHaveBeenCalled();
    expect(await reportRowCount()).toBe(0);
  });

  it("builds yesterday's report once now ≥ 00:15 UTC", async () => {
    wireHappyPath();
    const res = await buildAndServe(new Date("2026-08-04T00:15:00.000Z"));
    expect(res).not.toBeNull();
    expect(res!.report_date).toBe(YESTERDAY);
    expect(res!.generated_at).toBe("2026-08-04T00:15:00.000Z");
    expect(res!.grain_minutes).toBe(GRAIN_MINUTES);
    expect(await reportRowCount()).toBe(1);
  });

  it("no dashboard name → no build, NO AWS call, null", async () => {
    const res = await getOpsReport(getDb(), "", { now: NOW });
    expect(res).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
    expect(await reportRowCount()).toBe(0);
  });

  it("never double-builds — concurrent requests collapse to one fetch + one row", async () => {
    wireHappyPath();
    await Promise.all([buildAndServe(), buildAndServe(), buildAndServe()]);
    expect(dashCallCount()).toBe(1);
    expect(await reportRowCount()).toBe(1);
  });

  it("re-reads a stored report without re-fetching CloudWatch", async () => {
    wireHappyPath();
    await buildAndServe(); // builds
    const again = await buildAndServe(); // reads the existing row
    expect(again!.report_date).toBe(YESTERDAY);
    expect(dashCallCount()).toBe(1); // only the first request built
  });

  it("insert is DB-idempotent on report_date (ON CONFLICT DO NOTHING)", async () => {
    const db = getDb();
    const insert = (generatedAt: string) =>
      db("ops_reports")
        .insert({
          report_date: YESTERDAY,
          generated_at: new Date(generatedAt),
          payload: JSON.stringify({
            report_date: YESTERDAY,
            generated_at: generatedAt,
            grain_minutes: GRAIN_MINUTES,
            widgets: [],
          }),
        })
        .onConflict("report_date")
        .ignore();

    await insert("2026-08-04T02:00:00.000Z");
    await insert("2026-08-04T03:00:00.000Z"); // a second instance racing — no-op

    const rows = await db("ops_reports").select("payload");
    expect(rows).toHaveLength(1);
    // The FIRST write stands; the conflicting second insert changed nothing.
    expect(rows[0].payload.generated_at).toBe("2026-08-04T02:00:00.000Z");
  });
});

describe("curated full-UTC-day report shape (§3.5 machinery retained)", () => {
  it("curates the dashboard into the v1.7 report shape", async () => {
    wireHappyPath();
    const res = await buildAndServe();
    expect(res).toEqual({
      report_date: YESTERDAY,
      generated_at: NOW.toISOString(),
      grain_minutes: 5,
      available_dates: [YESTERDAY],
      widgets: [
        {
          title: "CPU Utilization",
          kind: "gauge", // single Percent series
          unit: "%",
          latest: 47.2,
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
              label: "NetworkRxBytes", // bare metric name fallback (not an id)
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

  it("queries the FULL UTC day (midnight→midnight) at a 5-minute grain", async () => {
    wireHappyPath();
    await buildAndServe();

    const metricCalls = mockSend.mock.calls.filter(
      ([c]) => c instanceof MockGetMetricDataCommand
    );
    expect(metricCalls).toHaveLength(1);
    const input = (metricCalls[0][0] as MockGetMetricDataCommand)
      .input as Record<string, any>;
    expect(input.StartTime.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(input.EndTime.toISOString()).toBe("2026-08-04T00:00:00.000Z");
    expect(input.EndTime.getTime() - input.StartTime.getTime()).toBe(
      24 * 60 * 60 * 1000
    );
    for (const q of input.MetricDataQueries as any[]) {
      if (q.MetricStat) expect(q.MetricStat.Period).toBe(METRIC_PERIOD_SECONDS);
    }
  });

  it("resolves dot shorthand — dotted rows inherit namespace/dims", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({
          DashboardBody: JSON.stringify({
            widgets: [
              {
                type: "metric",
                properties: {
                  title: "CPU Credits",
                  metrics: [
                    ["AWS/EC2", "CPUSurplusCreditsCharged", "AutoScalingGroupName", "fake-asg"],
                    [".", "CPUCreditUsage", ".", "."],
                    [".", "CPUCreditBalance", "..."],
                  ],
                },
              },
            ],
          }),
        });
      }
      const input = (command as MockGetMetricDataCommand).input as Record<string, any>;
      return Promise.resolve({
        MetricDataResults: (input.MetricDataQueries as any[]).map((q) => ({
          Id: q.Id,
          Timestamps: [new Date("2026-08-03T10:00:00Z")],
          Values: [q.MetricStat.Metric.MetricName === "CPUCreditBalance" ? 576 : 0],
        })),
      });
    });

    const res = await buildAndServe();
    const input = (
      mockSend.mock.calls.filter(
        ([c]) => c instanceof MockGetMetricDataCommand
      )[0][0] as MockGetMetricDataCommand
    ).input as Record<string, any>;
    for (const q of input.MetricDataQueries as any[]) {
      expect(q.MetricStat.Metric.Namespace).toBe("AWS/EC2");
      expect(q.MetricStat.Metric.Dimensions).toEqual([
        { Name: "AutoScalingGroupName", Value: "fake-asg" },
      ]);
    }
    const widget = res!.widgets[0];
    expect(widget.series).toHaveLength(3);
    const balance = widget.series.find((s) => s.label === "CPUCreditBalance");
    expect(balance?.points[0]?.v).toBe(576);
  });

  it("infers a gauge from a gauge-y title even without a Percent unit", async () => {
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

    const res = await buildAndServe();
    expect(res!.widgets[0].kind).toBe("gauge");
    expect(res!.widgets[0].unit).toBe("%");
    expect(res!.widgets[0].latest).toBe(88);
  });
});

describe("sanitization — ALLOWLIST leak test (§3.5)", () => {
  it("emits NONE of the fake ARNs / instance-ids / account-ids anywhere", async () => {
    wireHappyPath();
    const res = await buildAndServe();
    const serialized = JSON.stringify(res);
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

    const res = await buildAndServe();
    for (const s of res!.widgets[0].series) {
      expect(s.label).toBeNull();
    }
  });
});

// A FAKE dashboard exercising math expressions (v1.3 DEFECT 1).
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
            ["AWS/RDS", "FreeableMemory", "DBInstanceIdentifier", FAKE_DB_ID, { id: "m1", visible: false }],
            ["AWS/RDS", "TotalMemory", "DBInstanceIdentifier", FAKE_DB_ID, { id: "m2", visible: false }],
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
      const input = (command as MockGetMetricDataCommand).input as Record<string, any>;
      return Promise.resolve(metricDataFromQueries(input));
    }
    return Promise.reject(new Error("unexpected command"));
  });
}

describe("math expressions (§3.5, DEFECT 1 machinery retained)", () => {
  it("renders the percent EXPRESSION as a gauge and leaks no expression strings", async () => {
    wireExpressionPath();
    const res = await buildAndServe();

    const memory = res!.widgets[0];
    expect(memory.title).toBe("RDS - Memory Used (%)");
    expect(memory.kind).toBe("gauge");
    expect(memory.unit).toBe("%");
    expect(memory.series).toHaveLength(1);
    expect(memory.series[0].label).toBe("Memory %");
    expect(memory.latest).toBe(61.5);

    const throughput = res!.widgets[1];
    expect(throughput.unit).toBe("MB/s");
    expect(throughput.series[0].label).toBe("Throughput");

    const serialized = JSON.stringify(res);
    for (const secret of [
      EXPR_MEMORY_STRING,
      EXPR_THROUGHPUT_STRING,
      FAKE_DB_ID,
      FAKE_VOL_ID,
      "w0_m1",
      "w1_r1",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("batches hidden metrics + expressions into ONE GetMetricData call", async () => {
    wireExpressionPath();
    await buildAndServe();

    const metricCalls = mockSend.mock.calls.filter(
      ([c]) => c instanceof MockGetMetricDataCommand
    );
    expect(metricCalls).toHaveLength(1);
    const input = (metricCalls[0][0] as MockGetMetricDataCommand).input as Record<string, any>;
    const queries = input.MetricDataQueries as any[];
    expect(queries).toHaveLength(6);
    expect(queries.filter((q) => q.MetricStat)).toHaveLength(4);
    expect(queries.filter((q) => q.Expression)).toHaveLength(2);
    const memoryExpr = queries.find((q) => q.Id === "w0_e1");
    expect(memoryExpr.Expression).toBe("((w0_m2-w0_m1)/w0_m2)*100");
  });
});

describe("deriveUnit (§3.5, DEFECT 2 — pure unit derivation)", () => {
  it("(a) maps an explicit unit / yAxis label", () => {
    expect(deriveUnit("Percent", "", null)).toBe("%");
    expect(deriveUnit("Bytes/Second", "", null)).toBe("MB/s");
    expect(deriveUnit("MB/s", "", null)).toBe("MB/s");
  });

  it("(b) falls back to a title heuristic", () => {
    expect(deriveUnit(null, "CPU Utilization", null)).toBe("%");
    expect(deriveUnit(null, "Disk Throughput (MB/s)", null)).toBe("MB/s");
    expect(deriveUnit(null, "Latency (ms)", null)).toBe("ms");
    expect(deriveUnit(null, "EC2 - CPU Credits (ASG)", null)).toBeNull();
  });

  it("(c) falls back to the metric's standard unit and honours priority", () => {
    expect(deriveUnit(null, "Plain", "Percent")).toBe("%");
    expect(deriveUnit(null, "Plain", "Count")).toBeNull();
    expect(deriveUnit("Percent", "X (MB/s)", "Bytes")).toBe("%");
  });
});

describe("degrade cases (§3.5) — leave the day unbuilt, never a 5xx", () => {
  it("SDK / IAM error (GetDashboard rejects) → nothing persists, retries next time", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("User is not authorized"), {
        name: "AccessDeniedException",
      })
    );
    expect(await buildAndServe()).toBeNull();
    expect(await reportRowCount()).toBe(0);

    wireHappyPath();
    const ok = await buildAndServe();
    expect(ok!.report_date).toBe(YESTERDAY);
  });

  it("empty DashboardBody → unbuilt", async () => {
    mockSend.mockResolvedValue({ DashboardBody: undefined });
    expect(await buildAndServe()).toBeNull();
    expect(await reportRowCount()).toBe(0);
  });

  it("malformed dashboard JSON → unbuilt", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({ DashboardBody: "{not valid json" });
      }
      return Promise.resolve(metricDataResults());
    });
    expect(await buildAndServe()).toBeNull();
    expect(await reportRowCount()).toBe(0);
  });

  it("dashboard with no renderable metric widgets → unbuilt", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({
          DashboardBody: JSON.stringify({
            widgets: [
              { type: "text", properties: { markdown: "hi" } },
              { type: "metric", properties: { metrics: [[{ expression: "m0", id: "e0" }]] } },
            ],
          }),
        });
      }
      return Promise.resolve(metricDataResults());
    });
    expect(await buildAndServe()).toBeNull();
    expect(await reportRowCount()).toBe(0);
  });

  it("GetMetricData rejects (after a good dashboard) → unbuilt", async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof MockGetDashboardCommand) {
        return Promise.resolve({ DashboardBody: dashboardBody() });
      }
      return Promise.reject(new Error("Throttling"));
    });
    expect(await buildAndServe()).toBeNull();
    expect(await reportRowCount()).toBe(0);
  });
});

describe("report row round-trip + ?date + available_dates (§3.5)", () => {
  it("persists a row that round-trips (payload jsonb + generated_at column)", async () => {
    wireHappyPath();
    const served = await buildAndServe();

    const { rows } = await getDb().raw(
      "SELECT to_char(report_date, 'YYYY-MM-DD') AS d, generated_at, payload FROM ops_reports"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].d).toBe(YESTERDAY);
    expect(rows[0].generated_at).toBeInstanceOf(Date);
    expect(rows[0].payload).toEqual({
      report_date: YESTERDAY,
      generated_at: NOW.toISOString(),
      grain_minutes: GRAIN_MINUTES,
      widgets: served!.widgets,
    });
  });

  describe("with two consecutive days built", () => {
    beforeEach(async () => {
      wireHappyPath();
      await buildAndServe(new Date("2026-08-03T02:00:00.000Z")); // builds 2026-08-02
      await buildAndServe(new Date("2026-08-04T02:00:00.000Z")); // builds 2026-08-03
    });

    it("no date → the latest report, available_dates newest-first", async () => {
      const res = await buildAndServe(NOW);
      expect(res!.report_date).toBe("2026-08-03");
      expect(res!.available_dates).toEqual(["2026-08-03", "2026-08-02"]);
    });

    it("?date= → that specific stored report", async () => {
      const res = await buildAndServe(NOW, "2026-08-02");
      expect(res!.report_date).toBe("2026-08-02");
      expect(res!.available_dates).toEqual(["2026-08-03", "2026-08-02"]);
    });

    it("valid but unknown date → null (404)", async () => {
      const res = await buildAndServe(NOW, "2026-07-01");
      expect(res).toBeNull();
    });
  });
});

describe("UTC-day + Cache-Control helpers (clock injected, §3.5)", () => {
  it("yesterdayUtc / expectedLatestDate honour the 00:15 margin", () => {
    expect(yesterdayUtc(new Date("2026-08-04T02:00:00Z"))).toBe("2026-08-03");
    expect(utcDateString(new Date("2026-08-04T23:59:00Z"))).toBe("2026-08-04");
    expect(expectedLatestDate(new Date("2026-08-04T02:00:00Z"))).toBe("2026-08-03");
    // before today's 00:15 UTC the expected latest is still the day-before-yesterday
    expect(expectedLatestDate(new Date("2026-08-04T00:05:00Z"))).toBe("2026-08-02");
    expect(expectedLatestDate(new Date("2026-08-04T00:20:00Z"))).toBe("2026-08-03");
  });

  it("fresh report → max-age expires shortly after the next 00:15 UTC", () => {
    const cc = buildCacheControl(new Date("2026-08-04T02:00:00Z"), "2026-08-03");
    const m = /^public, max-age=(\d+)$/.exec(cc);
    expect(m).not.toBeNull();
    // next boundary 2026-08-05T00:15Z → 22h15m away, plus the buffer.
    expect(Number(m![1])).toBe(22 * 3600 + 15 * 60 + CACHE_BOUNDARY_BUFFER_SECONDS);
  });

  it("expected report not built yet (or older ?date) → short max-age", () => {
    const cc = buildCacheControl(new Date("2026-08-04T02:00:00Z"), "2026-08-02");
    expect(cc).toBe(`public, max-age=${CACHE_SHORT_MAX_AGE_SECONDS}`);
  });
});

describe("ops section schema (v1.7 §3.4/§3.5, §3.9)", () => {
  it("is a registered publishable section type", () => {
    expect(SECTION_TYPES).toContain("ops");
    expect(SECTION_DATA_SCHEMAS.ops).toBeDefined();
  });

  it("accepts optional heading/intro; nothing is required", () => {
    const res = opsData.safeParse({ heading: "System health", intro: "Replay." });
    expect(res.success).toBe(true);
    expect(opsData.safeParse({}).success).toBe(true);
  });

  it("rejects the removed window_hours key (strict)", () => {
    expect(opsData.safeParse({ window_hours: 3 }).success).toBe(false);
    expect(opsData.safeParse({ heading: "x", surprise: 1 }).success).toBe(false);
  });

  it("draft-lenient variant also rejects window_hours (§3.9)", () => {
    const draftOps = DRAFT_SECTION_DATA_SCHEMAS.ops;
    expect(draftOps.safeParse({}).success).toBe(true);
    expect(draftOps.safeParse({ heading: "WIP" }).success).toBe(true);
    expect(draftOps.safeParse({ window_hours: 6 }).success).toBe(false);
  });
});

describe("GET /api/ops (§4.1) — replay report, ?date, 400/404, Cache-Control", () => {
  function seedReport(date: string, widgets: OpsWidget[] = []) {
    const payload = {
      report_date: date,
      generated_at: "2026-08-04T02:00:00.000Z",
      grain_minutes: GRAIN_MINUTES,
      widgets,
    };
    return getDb()("ops_reports").insert({
      report_date: date,
      generated_at: new Date(payload.generated_at),
      payload: JSON.stringify(payload),
    });
  }

  afterEach(() => {
    app.set("secrets", undefined);
  });

  it("serves the latest stored report with a public Cache-Control header", async () => {
    // Real-yesterday so the router's own (real-clock) build path is a no-op:
    // the row already exists, so no dashboard name is needed and no AWS is hit.
    const realYesterday = utcDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await seedReport(realYesterday);
    app.set("secrets", {} as Partial<IAppSecrets>);

    const res = await request(app).get("/api/ops");
    expect(res.status).toBe(200);
    expect(res.body.report_date).toBe(realYesterday);
    expect(res.body.grain_minutes).toBe(GRAIN_MINUTES);
    expect(res.body.available_dates).toContain(realYesterday);
    expect(res.headers["cache-control"]).toMatch(/^public, max-age=\d+$/);
  });

  it("?date= serves that specific stored report", async () => {
    await seedReport("2026-06-01");
    app.set("secrets", {} as Partial<IAppSecrets>);
    const res = await request(app).get("/api/ops?date=2026-06-01");
    expect(res.status).toBe(200);
    expect(res.body.report_date).toBe("2026-06-01");
  });

  it("invalid ?date= → 400 with a clear errorMsg", async () => {
    app.set("secrets", {} as Partial<IAppSecrets>);
    for (const bad of ["not-a-date", "2026-13-99", "2026-02-30", "20260601"]) {
      const res = await request(app).get(`/api/ops?date=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(true);
      expect(typeof res.body.errorMsg).toBe("string");
    }
  });

  it("valid but unknown date → 404", async () => {
    app.set("secrets", {} as Partial<IAppSecrets>);
    const res = await request(app).get("/api/ops?date=1999-01-01");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(true);
  });

  it("no report available at all → 404 (calm placeholder), no AWS call", async () => {
    app.set("secrets", {} as Partial<IAppSecrets>);
    const res = await request(app).get("/api/ops");
    expect(res.status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
