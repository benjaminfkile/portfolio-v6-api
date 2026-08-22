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
import type { IAppSecrets } from "../src/interfaces";

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

const BASE_SECRETS: Partial<IAppSecrets> = {
  token_encryption_key: "test-analytics-key",
};

/**
 * Overwrite the app secrets with the given overrides on top of a stable base
 * (the test-only token key). Called in beforeEach so each test starts with a
 * fresh, minimal secrets shape; tests that need trusted-hop / Origin-allowlist
 * behaviour set them explicitly.
 */
function setSecrets(overrides: Partial<IAppSecrets> = {}): void {
  app.set("secrets", { ...BASE_SECRETS, ...overrides });
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
  setSecrets();
}, 60000);

afterAll(async () => {
  await closeDb();
  stopCluster();
}, 30000);

beforeEach(async () => {
  _resetAnalyticsStateForTests();
  setSecrets();
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

  // Cross-origin `navigator.sendBeacon` cannot preflight, so the client sends
  // its JSON body under a CORS-safelisted content type (text/plain, or a
  // type-less Blob). The router must ingest those exactly like application/json.
  it("ingests a text/plain body carrying valid JSON exactly like application/json", async () => {
    const res = await request(app)
      .post("/api/beacon")
      .set("Content-Type", "text/plain;charset=UTF-8")
      .set("X-Forwarded-For", FIXTURE_IP)
      .set("User-Agent", FIXTURE_UA)
      .set("Origin", SITE_ORIGIN)
      .send(JSON.stringify({ event: "pageview", path: "/" }));
    expect(res.status).toBe(204);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].event).toBe("pageview");
    expect(all[0].path).toBe("/");
  });

  it("ingests a body with no Content-Type header (type-less Blob case)", async () => {
    const res = await request(app)
      .post("/api/beacon")
      .set("Content-Type", "")
      .set("X-Forwarded-For", FIXTURE_IP)
      .set("User-Agent", FIXTURE_UA)
      .set("Origin", SITE_ORIGIN)
      .send(JSON.stringify({ event: "pageview", path: "/" }));
    expect(res.status).toBe(204);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].event).toBe("pageview");
    expect(all[0].path).toBe("/");
  });

  it("answers 204 on a malformed JSON body sent as text/plain and stores nothing", async () => {
    const res = await request(app)
      .post("/api/beacon")
      .set("Content-Type", "text/plain;charset=UTF-8")
      .set("X-Forwarded-For", FIXTURE_IP)
      .set("User-Agent", FIXTURE_UA)
      .send('{"event": "pageview", ');
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("answers 204 on an empty text/plain body and stores nothing", async () => {
    const res = await request(app)
      .post("/api/beacon")
      .set("Content-Type", "text/plain;charset=UTF-8")
      .set("X-Forwarded-For", FIXTURE_IP)
      .set("User-Agent", FIXTURE_UA)
      .send("");
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  // ---- Trusted-hop client IP (§4.8, task #135) -------------------------------
  //
  // Prod chain is ALB -> gateway (YARP, default XFF transform APPENDS) -> this
  // API, both hops append. Any client can therefore prepend a fake first entry
  // to X-Forwarded-For; a naive "first entry wins" read would let them mint
  // unlimited fake session_keys and slide under the per-IP rate limit. The
  // trusted-hop reader picks the entry at (length - hops) — the one appended
  // by the outermost TRUSTED proxy — so client-supplied leading entries never
  // influence the result. Falls back to the socket address whenever XFF is
  // absent or too short, NEVER to a header entry.
  describe("trusted-hop client IP + rate limit (task #135)", () => {
    it("with hops=2 picks the real-client entry, ignoring a spoofed leading XFF entry", async () => {
      setSecrets({ beacon_trusted_proxy_hops: 2 });
      // Simulated real chain: attacker prepended their own fake, then ALB
      // appended the real client, then the gateway appended the ALB address.
      // With hops=2 the real client is at index (length - 2) = "198.51.100.9".
      const REAL_CLIENT = "198.51.100.9";
      await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", `9.9.9.9, ${REAL_CLIENT}, 10.0.0.1`)
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", SITE_ORIGIN)
        .send({ event: "pageview", path: "/" });

      const all = await rows();
      expect(all).toHaveLength(1);
      const expected = computeSessionKey(
        computeDaySalt("test-analytics-key", new Date().toISOString().slice(0, 10)),
        REAL_CLIENT,
        FIXTURE_UA
      );
      expect(all[0].session_key).toBe(expected);
      // The spoofed leading entry must NOT be the hash input:
      const spoofed = computeSessionKey(
        computeDaySalt("test-analytics-key", new Date().toISOString().slice(0, 10)),
        "9.9.9.9",
        FIXTURE_UA
      );
      expect(all[0].session_key).not.toBe(spoofed);
    });

    it("with hops=2 and an XFF shorter than 2 entries, falls back to the socket address (never a header entry)", async () => {
      setSecrets({ beacon_trusted_proxy_hops: 2 });
      // Two beacons with different single-entry XFFs must hash to the SAME
      // session_key — the fallback is the shared socket address, not either
      // header value.
      await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", "9.9.9.9")
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", SITE_ORIGIN)
        .send({ event: "pageview", path: "/" });
      await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", "7.7.7.7")
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", SITE_ORIGIN)
        .send({ event: "pageview", path: "/about" });

      const all = await rows();
      expect(all).toHaveLength(2);
      expect(all[0].session_key).toBe(all[1].session_key);
      // Neither of the client-supplied strings can be the hash input.
      const day = new Date().toISOString().slice(0, 10);
      const salt = computeDaySalt("test-analytics-key", day);
      expect(all[0].session_key).not.toBe(
        computeSessionKey(salt, "9.9.9.9", FIXTURE_UA)
      );
      expect(all[0].session_key).not.toBe(
        computeSessionKey(salt, "7.7.7.7", FIXTURE_UA)
      );
    });

    it("with hops=0 (default) XFF is ignored entirely — session_key derives from the socket", async () => {
      setSecrets({ beacon_trusted_proxy_hops: 0 });
      await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", "9.9.9.9, 10.0.0.1")
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", SITE_ORIGIN)
        .send({ event: "pageview", path: "/" });
      await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", "1.2.3.4, 5.6.7.8, 9.10.11.12")
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", SITE_ORIGIN)
        .send({ event: "pageview", path: "/about" });

      const all = await rows();
      expect(all).toHaveLength(2);
      // Same socket for both → identical session_key regardless of XFF.
      expect(all[0].session_key).toBe(all[1].session_key);
    });

    it("rate-limit cannot be bypassed by varying a leading XFF entry", async () => {
      // With hops=1 the trusted client IP is always the LAST entry. An attacker
      // rotating fake leading entries can no longer mint fresh rate-limit
      // buckets — every request lands in the same bucket keyed on the real
      // trailing entry.
      setSecrets({ beacon_trusted_proxy_hops: 1 });
      const REAL_CLIENT = "203.0.113.99";
      const BURST = 70;
      for (let i = 0; i < BURST; i++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app)
          .post("/api/beacon")
          .set("X-Forwarded-For", `spoof-${i}, ${REAL_CLIENT}`)
          .set("User-Agent", FIXTURE_UA)
          .set("Origin", SITE_ORIGIN)
          .send({ event: "pageview", path: "/" });
        expect(res.status).toBe(204);
      }
      const count = (await rows()).length;
      expect(count).toBeGreaterThanOrEqual(60);
      expect(count).toBeLessThan(BURST);
    });
  });

  // ---- Origin allowlist (§4.8, task #135) ------------------------------------
  //
  // BEACON_ALLOWED_ORIGINS is a comma-separated exact-match allowlist. When
  // non-empty, a beacon whose Origin header is missing, unparseable, or not an
  // exact match is silently DROPPED (still 204, no row, no log). When
  // unset/empty (dev), every origin is accepted as today. The check lives in
  // the service so the router stays a thin shell.
  describe("Origin allowlist (task #135)", () => {
    it("accepts a beacon whose Origin exactly matches the allowlist", async () => {
      setSecrets({
        beacon_allowed_origins: `${SITE_ORIGIN},https://www.benkile.com`,
      });
      const res = await beacon({ event: "pageview", path: "/" });
      expect(res.status).toBe(204);
      expect(await rows()).toHaveLength(1);
    });

    it("silently drops a beacon whose Origin is not in the allowlist (still 204)", async () => {
      setSecrets({ beacon_allowed_origins: SITE_ORIGIN });
      const res = await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", FIXTURE_IP)
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", "https://evil.example.com")
        .send({ event: "pageview", path: "/" });
      expect(res.status).toBe(204);
      expect(await rows()).toHaveLength(0);
    });

    it("silently drops a beacon whose Origin header is missing (still 204)", async () => {
      setSecrets({ beacon_allowed_origins: SITE_ORIGIN });
      const res = await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", FIXTURE_IP)
        .set("User-Agent", FIXTURE_UA)
        .send({ event: "pageview", path: "/" });
      expect(res.status).toBe(204);
      expect(await rows()).toHaveLength(0);
    });

    it("silently drops a beacon whose Origin header is present but unparseable (still 204)", async () => {
      setSecrets({ beacon_allowed_origins: SITE_ORIGIN });
      const res = await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", FIXTURE_IP)
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", "not-a-url")
        .send({ event: "pageview", path: "/" });
      expect(res.status).toBe(204);
      expect(await rows()).toHaveLength(0);
    });

    it("accepts any origin (including a missing header) when the allowlist is unset — dev behaviour unchanged", async () => {
      setSecrets({ beacon_allowed_origins: undefined });
      const res1 = await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", FIXTURE_IP)
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", "https://anything.example.com")
        .send({ event: "pageview", path: "/" });
      expect(res1.status).toBe(204);

      const res2 = await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", FIXTURE_IP)
        .set("User-Agent", FIXTURE_UA)
        .send({ event: "pageview", path: "/about" });
      expect(res2.status).toBe(204);

      expect(await rows()).toHaveLength(2);
    });

    it("treats a whitespace-only allowlist string as unset (accept everything)", async () => {
      setSecrets({ beacon_allowed_origins: "   " });
      const res = await request(app)
        .post("/api/beacon")
        .set("X-Forwarded-For", FIXTURE_IP)
        .set("User-Agent", FIXTURE_UA)
        .set("Origin", "https://anywhere.example.com")
        .send({ event: "pageview", path: "/" });
      expect(res.status).toBe(204);
      expect(await rows()).toHaveLength(1);
    });
  });

  it("answers 204 even when the database is down (must run last — closes the pool)", async () => {
    await closeDb();
    const res = await beacon({ event: "pageview", path: "/" });
    expect(res.status).toBe(204);
  });
});
