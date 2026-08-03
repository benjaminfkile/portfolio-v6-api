/**
 * CloudWatch access for the `ops` live section — TECH_SPEC_V1.md §3.5 (v1.3) /
 * task #488.
 *
 * A thin wrapper over `@aws-sdk/client-cloudwatch`, isolating ALL CloudWatch SDK
 * access here the way `s3Service.ts` isolates S3. Two operations are exposed:
 *   - `getDashboard(name)`  → the dashboard's raw `DashboardBody` JSON string.
 *   - `getMetricData(...)`  → the `MetricDataResults` for a batch of queries.
 *
 * LAZY BY CONSTRUCTION: the SDK module is `import()`-ed on first use and the
 * client is constructed lazily, so IS_LOCAL / no-dashboard paths never load the
 * CloudWatch SDK at all (mirrors the lazy-import discipline in
 * `config/loadConfig.ts`). Nothing here runs against real AWS in tests — the SDK
 * module is fully `jest.mock`-ed (hard rule / pre-checks §7); the code is written
 * to be correct against live CloudWatch regardless.
 *
 * NO infra identifier (dashboard name, resource names, ARNs, account ids) is ever
 * logged here — this module only forwards the name it is given and returns raw
 * SDK results; curation and sanitization happen one layer up in `opsService`.
 */

// Types are import-only (erased at compile time) so no SDK value is loaded at
// module load — the runtime `import()` inside `getClient()` is the only load.
import type {
  CloudWatchClient,
  MetricDataQuery,
  MetricDataResult,
} from "@aws-sdk/client-cloudwatch";

/** Default per-call timeout — a hung CloudWatch must not hang `/api/ops`. */
export const CLOUDWATCH_TIMEOUT_MS = 4_000;

// Lazily-constructed singleton client. Held as a promise so concurrent first
// callers share one construction (and one SDK module load).
let clientPromise: Promise<CloudWatchClient> | null = null;

async function getClient(): Promise<CloudWatchClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { CloudWatchClient } = await import("@aws-sdk/client-cloudwatch");
      return new CloudWatchClient({ region: process.env.AWS_REGION });
    })();
  }
  return clientPromise;
}

/** Build an abort signal that fires after `ms`, plus its cleanup. */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Fetch a dashboard and return its raw `DashboardBody` (a JSON string), or `null`
 * when CloudWatch returns no body. Rejects on SDK/IAM/timeout errors — the caller
 * (`opsService`) catches and degrades to `{ available: false }`.
 */
export async function getDashboard(name: string): Promise<string | null> {
  const { GetDashboardCommand } = await import("@aws-sdk/client-cloudwatch");
  const client = await getClient();
  const { signal, clear } = timeoutSignal(CLOUDWATCH_TIMEOUT_MS);
  try {
    const res = await client.send(new GetDashboardCommand({ DashboardName: name }), {
      abortSignal: signal,
    });
    return res.DashboardBody ?? null;
  } finally {
    clear();
  }
}

/**
 * Run ONE `GetMetricData` call covering every query and return its
 * `MetricDataResults` (empty array when absent). Rejects on SDK/IAM/timeout
 * errors — the caller catches and degrades.
 */
export async function getMetricData(
  queries: MetricDataQuery[],
  start: Date,
  end: Date
): Promise<MetricDataResult[]> {
  const { GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
  const client = await getClient();
  const { signal, clear } = timeoutSignal(CLOUDWATCH_TIMEOUT_MS);
  try {
    const res = await client.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: start,
        EndTime: end,
        // Ascending so results run oldest → newest and the LAST point of a
        // series is its most recent value (curated `latest`, §3.5).
        ScanBy: "TimestampAscending",
      }),
      { abortSignal: signal }
    );
    return res.MetricDataResults ?? [];
  } finally {
    clear();
  }
}

/** Test/teardown helper: forget the lazily-constructed client. */
export function resetCloudWatch(): void {
  clientPromise = null;
}
