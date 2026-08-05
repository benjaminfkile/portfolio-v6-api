import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

/**
 * Analytics v1.4 ingest integration tests — TECH_SPEC_V1.md §4.8 (task DoD).
 *
 * Runs the REAL app + beacon router + analytics service against a throwaway
 * Postgres 15 cluster (unix-socket-only, under /tmp, exactly as
 * agent-pre-checks.md documents). No AWS is touched. The `pg` client is given an
 * explicit `user` because — unlike psql — it does not infer the OS user.
 *
 * The load-bearing privacy property is asserted directly: the raw fixture IP and
 * user-agent strings must appear NOWHERE in a stored row (they are hash input
 * only, never columns, never logged).
 */

import app from "../src/app";
import { initDb, closeDb, getDb } from "../src/db/db";
import {
  computeDaySalt,
  computeSessionKey,
  _resetAnalyticsStateForTests,
} from "../src/services/analyticsService";

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55451"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_analytics_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task512");

// A non-bot fixture identity. The exact strings below must never surface in a
// stored row — that is the privacy assertion.
const FIXTURE_IP = "203.0.113.7";
const FIXTURE_UA = "FixtureAgent/9.9 (privacy-marker-xyz)";
const SITE_ORIGIN = "https://benkile.com";

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

function beacon(body: unknown) {
  return request(app)
    .post("/api/beacon")
    .set("X-Forwarded-For", FIXTURE_IP)
    .set("User-Agent", FIXTURE_UA)
    .set("Origin", SITE_ORIGIN)
    .send(body as object);
}

async function rows() {
  return getDb()("analytics_events").select("*").orderBy("id", "asc");
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
  // Deterministic salt derivation: give the app real key material so
  // session_key is stable within the run (not the random per-boot dev salt).
  app.set("secrets", { token_encryption_key: "test-analytics-key" });
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(async () => {
  _resetAnalyticsStateForTests();
  await getDb()("analytics_events").del();
});

describe("POST /api/beacon ingest (§4.8)", () => {
  it("persists a valid pageview with a 32-char hashed session_key and stores no raw PII", async () => {
    const res = await beacon({ event: "pageview", path: "/" });
    expect(res.status).toBe(204);

    const all = await rows();
    expect(all).toHaveLength(1);
    const row = all[0];
    expect(row.event).toBe("pageview");
    expect(row.path).toBe("/");
    expect(row.referrer).toBeNull();
    expect(row.meta).toEqual({});

    // session_key is a 32-char lowercase hex hash.
    expect(row.session_key).toMatch(/^[0-9a-f]{32}$/);

    // The load-bearing privacy assertion: the raw IP and UA appear NOWHERE.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(FIXTURE_IP);
    expect(serialized).not.toContain("privacy-marker-xyz");
  });

  it("hashes the same ip/UA/day to the same session_key", async () => {
    await beacon({ event: "pageview", path: "/" });
    await beacon({ event: "pageview", path: "/about" });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0].session_key).toBe(all[1].session_key);
  });

  it("derives a different key from a different day salt (daily rotation)", () => {
    const key = "test-analytics-key";
    const a = computeSessionKey(
      computeDaySalt(key, "2026-08-05"),
      FIXTURE_IP,
      FIXTURE_UA
    );
    const b = computeSessionKey(
      computeDaySalt(key, "2026-08-06"),
      FIXTURE_IP,
      FIXTURE_UA
    );
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("drops an event outside the allowlist (204, no row)", async () => {
    const res = await beacon({ event: "keystroke", path: "/" });
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("drops a beacon whose path does not start with '/'", async () => {
    const res = await beacon({ event: "pageview", path: "no-slash" });
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("strips unknown meta keys and keeps only the per-event allowlist", async () => {
    const res = await beacon({
      event: "link_out",
      path: "/",
      meta: { href: "https://github.com/benkile", evil: "drop-me", n: 5 },
    });
    expect(res.status).toBe(204);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].meta).toEqual({ href: "https://github.com/benkile" });
  });

  it("reduces a cross-origin referrer to its origin", async () => {
    await beacon({
      event: "pageview",
      path: "/",
      referrer: "https://www.google.com/search?q=ben+kile",
    });
    const all = await rows();
    expect(all[0].referrer).toBe("https://www.google.com");
  });

  it("nulls a same-origin referrer", async () => {
    await beacon({
      event: "pageview",
      path: "/projects",
      referrer: `${SITE_ORIGIN}/`,
    });
    const all = await rows();
    expect(all[0].referrer).toBeNull();
  });

  it("drops a known bot by user-agent (204, no row)", async () => {
    const res = await request(app)
      .post("/api/beacon")
      .set("X-Forwarded-For", FIXTURE_IP)
      .set("User-Agent", "Mozilla/5.0 (compatible; Googlebot/2.1)")
      .send({ event: "pageview", path: "/" });
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("rate-limits a flood from one IP after the burst", async () => {
    const BURST = 70;
    for (let i = 0; i < BURST; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", "198.51.100.42")
        .set("User-Agent", FIXTURE_UA)
        .send({ event: "pageview", path: "/" });
    }
    const count = (await rows()).length;
    // The bucket capacity is ~60; the burst must have dropped events beyond it.
    expect(count).toBeGreaterThanOrEqual(60);
    expect(count).toBeLessThan(BURST);
  });

  it("answers 204 on a malformed JSON body and stores nothing", async () => {
    const res = await request(app)
      .post("/api/beacon")
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", FIXTURE_IP)
      .set("User-Agent", FIXTURE_UA)
      .send('{"event": "pageview", ');
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("answers 204 even when the database is down (must run last — closes the pool)", async () => {
    await closeDb();
    const res = await beacon({ event: "pageview", path: "/" });
    expect(res.status).toBe(204);
  });
});
