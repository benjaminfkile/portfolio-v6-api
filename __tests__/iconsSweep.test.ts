import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Icon-sweep-exclusion test — §Icons v1.6 (task #532), acceptance 1660.
 *
 * PROVES the `icons/` prefix is excluded from the §6.9 media orphan sweep. The
 * sweep (`mediaService.runGc`) enumerates `media_assets` ROWS — never the raw
 * bucket — so an object imported under `icons/` (which is NOT a media_assets row)
 * is never a sweep candidate and can never be tagged/deleted. Skills reference
 * icons by URL, not `media_id`, so they must survive every sweep untouched.
 *
 * Real router/service + a throwaway Postgres 15 cluster (unix-socket only, under
 * /tmp, per agent-pre-checks.md). NO AWS and NO network: `s3Service` is fully
 * mocked and `global.fetch` is stubbed for the import.
 */

jest.mock("../src/aws/s3Service", () => ({
  headObject: jest.fn(),
  putObject: jest.fn().mockResolvedValue(undefined),
  putObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObjectTags: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

import * as s3 from "../src/aws/s3Service";
import { initDb, closeDb, getDb } from "../src/db/db";
import { runGc } from "../src/services/mediaService";
import {
  importIcon,
  iconS3Key,
  _resetIconsCacheForTests,
} from "../src/services/iconsService";
import { ensureHomePage } from "./helpers/pages";

const mockHead = s3.headObject as jest.Mock;
const mockPut = s3.putObject as jest.Mock;
const mockPutTags = s3.putObjectTags as jest.Mock;
const mockDeleteTags = s3.deleteObjectTags as jest.Mock;
const mockDeleteObject = s3.deleteObject as jest.Mock;

const PG_BIN = "/usr/lib/postgresql/15/bin";
const PG_PORT = "55450"; // distinct from other tasks' throwaway clusters
const PG_SOCKET_DIR = "/tmp";
const PG_USER = "node";
const TEST_DB = "portfolio_v6_iconsweep_test";
const DATA_DIR = path.join(os.tmpdir(), "pgtest_task532");
const CDN = "media-test.benkile.com";
const DAY_MS = 24 * 60 * 60 * 1000;

const RAW_MANIFEST = [
  {
    name: "react",
    altnames: [],
    tags: ["web"],
    versions: { svg: ["original"], font: ["original"] },
    color: "#61DAFB",
  },
];
const SVG_BODY = "<svg><path d='M0 0'/></svg>";

function fakeResponse(url: string): Response {
  const isManifest = url.endsWith("/devicon.json");
  return {
    ok: true,
    status: 200,
    json: async () => (isManifest ? RAW_MANIFEST : {}),
    text: async () => (isManifest ? JSON.stringify(RAW_MANIFEST) : SVG_BODY),
  } as unknown as Response;
}

const mockFetch = jest.fn(async (input: unknown) => fakeResponse(String(input)));

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

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

async function insertOrphanAsset(s3Key: string): Promise<string> {
  const [row] = await getDb()("media_assets")
    .insert({
      s3_key: s3Key,
      mime: "image/webp",
      bytes: 1000,
      confirmed_at: getDb().fn.now(),
      created_at: daysAgo(40), // past the 30-day grace
    })
    .returning(["id"]);
  return row.id;
}

beforeAll(async () => {
  (global as unknown as { fetch: unknown }).fetch = mockFetch;
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
  _resetIconsCacheForTests();
  mockHead.mockReset();
  mockHead.mockResolvedValue(null); // import: object absent → upload
  mockPut.mockClear();
  mockPutTags.mockClear();
  mockDeleteTags.mockClear();
  mockDeleteObject.mockClear();
  mockFetch.mockClear();

  await getDb()("section_items").del();
  await getDb()("sections").del();
  await getDb()("media_assets").del();
});

describe("icons/ prefix is excluded from the §6.9 orphan sweep (task #532)", () => {
  it("never touches an imported icon object during a sweep", async () => {
    // 1. Import an icon → stored under the icons/ prefix (mocked S3 records it).
    const imported = await importIcon({ name: "react", variant: "original" }, CDN);
    expect(imported.ok).toBe(true);
    const iconKey = iconS3Key("react", "original");
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0][0].key).toBe(iconKey);
    expect(iconKey.startsWith("icons/")).toBe(true);

    // 2. A skills section+item that references the icon BY URL (icon_source),
    //    exactly as the product does — never by media_id.
    const pageId = await ensureHomePage(getDb());
    const [section] = await getDb()("sections")
      .insert({
        type: "skills",
        position: 0,
        data: { heading: "Skills" },
        page_id: pageId,
      })
      .returning(["id"]);
    await getDb()("section_items").insert({
      section_id: section.id,
      position: 0,
      data: {
        title: "React",
        icon_source: `https://${CDN}/${iconKey}`,
      },
    });

    // 3. A genuinely orphaned media asset (old, confirmed, unreferenced).
    const orphanId = await insertOrphanAsset("media/orphan/f.webp");

    // 4. Sweep.
    const summary = await runGc();

    // The real media orphan was swept…
    expect(summary.orphaned).toEqual([orphanId]);
    expect(mockPutTags).toHaveBeenCalledTimes(1);
    expect(mockPutTags).toHaveBeenCalledWith("media/orphan/f.webp", {
      state: "orphaned",
    });

    // …and NO destructive S3 op ever referenced an icons/ key. The sweep
    // enumerates media_assets rows, so the icon object is never a candidate.
    const destructiveCalls = [
      ...mockPutTags.mock.calls,
      ...mockDeleteTags.mock.calls,
      ...mockDeleteObject.mock.calls,
    ];
    for (const call of destructiveCalls) {
      expect(String(call[0]).startsWith("icons/")).toBe(false);
    }
  });

  it("does not orphan the icon even when it is the ONLY object present", async () => {
    // Import the icon; add NO media_assets rows at all.
    await importIcon({ name: "react", variant: "original" }, CDN);

    const summary = await runGc();

    // Nothing to orphan/rescue/delete — the icon is invisible to the sweep.
    expect(summary).toEqual({ orphaned: [], rescued: [], deleted: [] });
    expect(mockPutTags).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteTags).not.toHaveBeenCalled();
  });
});
