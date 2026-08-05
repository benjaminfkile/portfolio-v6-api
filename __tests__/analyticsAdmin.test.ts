import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Express } from "express";
import request from "supertest";

/**
 * Admin analytics aggregates integration tests — TECH_SPEC_V1.md §4.8 (v1.4,
 * read half), §4.2/§4.3, §4.5 (task DoD).
 *
 * Runs the real router + service against a throwaway Postgres 15 cluster
 * (unix-socket-only, under /tmp, exactly as agent-pre-checks.md documents). No
 * AWS is touched: the Cognito verifier is mocked so `requireAdmin` passes, and
 * the DB is the local ephemeral cluster. The `pg` client is given an explicit
 * `user` because — unlike psql — it does not infer the OS user.
 *
 * The fixture set spans several UTC days and sessions and deliberately mixes:
 *   - engaged sessions (fired a non-pageview event) vs pageview-only sessions,
 *     so `engaged` can be shown to count SESSIONS, not events;
 *   - rows just inside the 7-day window, older rows only inside 30, and a row
 *     only inside 90, so the `days` window can be shown to exclude older rows;
 *   - link_out hrefs (repeated + unique) and referrer origins (repeated + null).
 * There are no bot rows: known bots are dropped at INGEST (§4.8), so by the time
 * anything reaches this table it is already bot-free — the read side does no bot
 * filtering and the fixtures reflect that reality.
 */

// Mock the Cognito verifier so requireAdmin() authorizes offline (§5.3).
jest.mock("../src/aws/cognitoAuth", () => ({
  verifyAdminIdToken: jest.fn(),
}));

import { verifyAdminIdToken } from "../src/aws/cognitoAuth";
import { initDb, closeDb, getDb } from "../src/db/db";
import adminAnalyticsRouter from "../src/routers/adminAnalyticsRouter";
import { failure } from "../src/utils/envelope";

const mockVerify = verifyAdminIdToken as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55452"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_analytics_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task513");

const ADMIN_PAYLOAD = { sub: "admin-sub-513", "cognito:groups": ["admins"] };
const AUTH = ["Authorization", "Bearer good.token"] as const;

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

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.set("secrets", {
    cognito_user_pool_id: "us-east-1_testpool",
    cognito_client_id: "test-client-id",
  });
  app.use("/api/admin", adminAnalyticsRouter);
  // Same JSON error handler contract as app.ts (§4.4).
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) return next(err);
      res.status(500).json(failure(err.message));
    }
  );
  return app;
}

// ---- fixtures ---------------------------------------------------------------

interface Fixture {
  session: string;
  event: string;
  path: string;
  referrer: string | null;
  meta: Record<string, string>;
  daysAgo: number;
}

// daysAgo → UTC-day string, matching the DB's `date_trunc('day', … AT TIME ZONE
// 'UTC')`. Both use "24h * daysAgo ago", so they agree on the calendar day
// except within a few ms of UTC midnight (not a concern for a test run).
function utcDayFor(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

// A hand-built set. Comments track which window each row lands in.
const FIXTURES: Fixture[] = [
  // --- inside the 7-day window ---------------------------------------------
  // s1: engaged (link_out), two pageviews on day-1, one with a referrer.
  { session: "s1", event: "pageview", path: "/", referrer: "https://google.com", meta: {}, daysAgo: 1 },
  { session: "s1", event: "pageview", path: "/about", referrer: null, meta: {}, daysAgo: 1 },
  { session: "s1", event: "link_out", path: "/about", referrer: null, meta: { href: "github.com/ben" }, daysAgo: 1 },
  // s2: pageview-only (NOT engaged), with a referrer.
  { session: "s2", event: "pageview", path: "/", referrer: "https://google.com", meta: {}, daysAgo: 2 },
  // s3: engaged (scroll_depth), one pageview.
  { session: "s3", event: "pageview", path: "/", referrer: null, meta: {}, daysAgo: 3 },
  { session: "s3", event: "scroll_depth", path: "/", referrer: null, meta: {}, daysAgo: 3 },
  // s4: engaged (two link_outs, one repeated href), pageview on day-0.
  { session: "s4", event: "pageview", path: "/projects", referrer: "https://news.ycombinator.com", meta: {}, daysAgo: 0 },
  { session: "s4", event: "link_out", path: "/projects", referrer: null, meta: { href: "github.com/ben" }, daysAgo: 0 },
  { session: "s4", event: "link_out", path: "/projects", referrer: null, meta: { href: "twitter.com/ben" }, daysAgo: 0 },
  // --- inside 30 but OUTSIDE 7 ---------------------------------------------
  // s5: engaged (video_play), day-15 — must appear for days=30, not days=7.
  { session: "s5", event: "pageview", path: "/", referrer: "https://google.com", meta: {}, daysAgo: 15 },
  { session: "s5", event: "video_play", path: "/", referrer: null, meta: { title: "demo" }, daysAgo: 15 },
  // --- inside 90 but OUTSIDE 30 --------------------------------------------
  // s6: day-40 — must appear only for days=90.
  { session: "s6", event: "pageview", path: "/old", referrer: null, meta: {}, daysAgo: 40 },
];

async function seed(): Promise<void> {
  const db = getDb();
  await db("analytics_events").insert(
    FIXTURES.map((f) => ({
      session_key: f.session,
      event: f.event,
      path: f.path,
      referrer: f.referrer,
      meta: JSON.stringify(f.meta),
      occurred_at: db.raw("now() - make_interval(days => ?)", [f.daysAgo]),
    }))
  );
}

let app: Express;

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
  await seed();
  app = buildApp();
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(() => {
  mockVerify.mockReset();
  mockVerify.mockResolvedValue(ADMIN_PAYLOAD);
});

function get(query = "") {
  return request(app)
    .get(`/api/admin/analytics${query}`)
    .set(...AUTH);
}

// ---- auth (§4.2 / §5.3) -----------------------------------------------------

describe("auth guard (§4.2)", () => {
  it("401s an unauthenticated request (no bearer)", async () => {
    const res = await request(app).get("/api/admin/analytics");
    expect(res.status).toBe(401);
  });

  it("403s a valid token that is not in the admins group", async () => {
    mockVerify.mockResolvedValue({ sub: "x", "cognito:groups": ["users"] });
    const res = await get();
    expect(res.status).toBe(403);
  });
});

// ---- days window (§4.8) -----------------------------------------------------

describe("days window (§4.8)", () => {
  it("defaults to 30 when omitted", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.data.days).toBe(30);
  });

  it.each([
    ["7", 7],
    ["30", 30],
    ["90", 90],
  ])("honors ?days=%s", async (param, expected) => {
    const res = await get(`?days=${param}`);
    expect(res.body.data.days).toBe(expected);
  });

  it.each(["15", "0", "-7", "abc", ""])(
    "degrades ?days=%s to 30",
    async (param) => {
      const res = await get(`?days=${param}`);
      expect(res.body.data.days).toBe(30);
    }
  );
});

// ---- the 7-day summary shape (§4.8) -----------------------------------------

describe("7-day summary (§4.8 shape)", () => {
  it("computes every field over only the last 7 days", async () => {
    const res = await get("?days=7");
    expect(res.status).toBe(200);
    const d = res.body.data;

    // totals: pageviews count rows 1,2,4,5,7; visitors = distinct s1..s4;
    // engaged = distinct SESSIONS with a non-pageview event = s1,s3,s4 (NOT s2,
    // which is pageview-only). This is the sessions-not-events assertion.
    expect(d.totals).toEqual({ pageviews: 5, visitors: 4, engaged: 3 });

    // daily: one row per UTC day, oldest→newest, pageviews + visitors.
    expect(d.daily).toEqual([
      { date: utcDayFor(3), pageviews: 1, visitors: 1 }, // s3
      { date: utcDayFor(2), pageviews: 1, visitors: 1 }, // s2
      { date: utcDayFor(1), pageviews: 2, visitors: 1 }, // s1 (two pageviews)
      { date: utcDayFor(0), pageviews: 1, visitors: 1 }, // s4
    ]);

    // top_pages: pageview counts by path, desc then path asc for ties.
    expect(d.top_pages).toEqual([
      { path: "/", views: 3 },
      { path: "/about", views: 1 },
      { path: "/projects", views: 1 },
    ]);

    // top_referrers: non-null referrers only, counted.
    expect(d.top_referrers).toEqual([
      { origin: "https://google.com", count: 2 },
      { origin: "https://news.ycombinator.com", count: 1 },
    ]);

    // events: count per NON-pageview event type.
    expect(d.events).toEqual([
      { event: "link_out", count: 3 },
      { event: "scroll_depth", count: 1 },
    ]);

    // top_outbound: link_out meta->>'href' counts.
    expect(d.top_outbound).toEqual([
      { href: "github.com/ben", count: 2 },
      { href: "twitter.com/ben", count: 1 },
    ]);
  });
});

// ---- the 30-day window pulls in the older engaged session -------------------

describe("30-day window includes the day-15 rows (§4.8)", () => {
  it("adds s5 (engaged via video_play) and its pageview/referrer", async () => {
    const res = await get("?days=30");
    const d = res.body.data;

    // s5 adds one pageview + one visitor + one engaged session vs the 7-day set.
    expect(d.totals).toEqual({ pageviews: 6, visitors: 5, engaged: 4 });

    // Its day-15 pageview lands on a new, oldest daily bucket.
    expect(d.daily[0]).toEqual({ date: utcDayFor(15), pageviews: 1, visitors: 1 });
    expect(d.daily).toHaveLength(5);

    // "/" gains s5's pageview; referrer google.com gains one.
    expect(d.top_pages[0]).toEqual({ path: "/", views: 4 });
    expect(d.top_referrers[0]).toEqual({
      origin: "https://google.com",
      count: 3,
    });

    // video_play now shows up in the event breakdown.
    expect(d.events).toEqual([
      { event: "link_out", count: 3 },
      { event: "scroll_depth", count: 1 },
      { event: "video_play", count: 1 },
    ]);

    // The day-40 row (s6, "/old") is still excluded at 30 days.
    expect(d.top_pages.map((p: { path: string }) => p.path)).not.toContain(
      "/old"
    );
    expect(d.totals.visitors).toBe(5); // s6 not counted
  });
});

// ---- the 90-day window pulls in the oldest row ------------------------------

describe("90-day window includes the day-40 row (§4.8)", () => {
  it("adds s6 / '/old', proving the window is the only thing excluding it", async () => {
    const res = await get("?days=90");
    const d = res.body.data;
    expect(d.totals.visitors).toBe(6); // s1..s6
    expect(d.totals.pageviews).toBe(7);
    expect(d.top_pages.map((p: { path: string }) => p.path)).toContain("/old");
    expect(d.daily).toHaveLength(6);
  });
});
