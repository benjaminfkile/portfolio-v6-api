import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getGithub,
  resolveGithubYears,
  GithubResult,
  GITHUB_SERVICE_KEY,
} from "../services/githubService";
import {
  getStoredServiceToken,
  resolveEncryptionKey,
} from "../services/serviceTokenStore";
import {
  readSnapshot,
  readLocalSnapshot,
  type UpstreamHandle,
} from "../services/upstream";

/**
 * Public GitHub router — TECH_SPEC_V1.md §3.5/§4.1 (`/api/github`, v1.10 GitHub
 * Explorer) / task #580.
 *
 * `GET /api/github[?year=YYYY]` (public, no auth) serves the contribution
 * calendar sourced from GitHub's PUBLIC per-user contributions endpoint (so the
 * total matches github.com), served from a ~1h per-window in-memory cache.
 *   - no `year` → the DEFAULT view: the trailing 12 months ending today.
 *   - `year=YYYY` → that calendar year (clamped to today for the current year).
 *
 * It **degrades rather than errors** (§3.5): no configured PAT, ANY upstream
 * failure, a GraphQL `errors` array, or HTML shape drift all render as
 * `{ available: false }`, never a 5xx. The ONLY non-200 is a **400 for an
 * invalid `?year=`** (non-numeric, or outside the account's creation-year →
 * current-year range) — a public read, so the body is a raw `{ error }` shape,
 * not the admin envelope (§4.3). The stored PAT never appears in the response —
 * it is used solely, server-side, to resolve the public login/creation year.
 *
 * Task #84: when Redis is configured and the request omits `?year=` (the
 * default view), we serve from the shared snapshot the leader writes. Specific
 * year requests still hit the per-instance path unchanged — the ~1h in-memory
 * cache absorbs the traffic, and pre-populating every year is out of scope.
 */
const githubRouter = express.Router();

const UNAVAILABLE: GithubResult = { available: false };

async function storedPat(req: Request): Promise<string> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const stored = await getStoredServiceToken(
    GITHUB_SERVICE_KEY,
    resolveEncryptionKey(secrets)
  );
  return stored?.token ?? "";
}

function parseYearParam(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string" || !/^\d{4}$/.test(s)) return null;
  return Number(s);
}

githubRouter.get("/", async (req: Request, res: Response) => {
  try {
    const year = parseYearParam(req.query.year);
    if (year === null) {
      return res.status(400).json({
        error: "Invalid year — expected a four-digit calendar year.",
      });
    }

    // Shared-snapshot fast path — only the default view is pre-populated.
    if (year === undefined) {
      const upstream = req.app.get("upstream") as UpstreamHandle | undefined;
      const secrets = req.app.get("secrets") as IAppSecrets | undefined;
      if (upstream?.enabled && upstream.redis && secrets) {
        const snap = await readSnapshot<GithubResult>(
          upstream.redis,
          secrets.node_env,
          "github"
        );
        if (snap) {
          return res.status(200).json(snap.payload);
        }
        const local = readLocalSnapshot<GithubResult>("github");
        if (local) {
          return res.status(200).json(local);
        }
      }
    }

    const pat = await storedPat(req);

    if (year !== undefined) {
      const years = await resolveGithubYears(pat);
      if (years && !years.includes(year)) {
        const min = years[years.length - 1];
        const max = years[0];
        return res.status(400).json({
          error: `Invalid year — must be between ${min} and ${max}.`,
        });
      }
    }

    const payload = await getGithub(pat, year);
    res.status(200).json(payload);
  } catch (err) {
    console.error("[githubRouter] unexpected error; serving unavailable:", err);
    res.status(200).json(UNAVAILABLE);
  }
});

export default githubRouter;
