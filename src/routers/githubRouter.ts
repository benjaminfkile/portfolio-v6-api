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
 */
const githubRouter = express.Router();

const UNAVAILABLE: GithubResult = { available: false };

/**
 * The stored GitHub PAT lives under the `github` service key in the shared,
 * service-keyed credential store (§4.7). It is a real secret — resolved
 * server-side, passed only to the service (which forwards it solely in the
 * upstream GraphQL `Authorization` header), and never returned to the client.
 * The store never throws and caches in memory, so this adds no per-request DB
 * round-trip on the hot path.
 */
async function storedPat(req: Request): Promise<string> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const stored = await getStoredServiceToken(
    GITHUB_SERVICE_KEY,
    resolveEncryptionKey(secrets)
  );
  return stored?.token ?? "";
}

/**
 * Parse the optional `?year=` param. Returns the year as a number, `undefined`
 * when absent (→ the default window), or `null` when present but malformed (a
 * four-digit calendar year is required — non-numeric or the wrong shape is
 * rejected, not silently coerced).
 */
function parseYearParam(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string" || !/^\d{4}$/.test(s)) return null;
  return Number(s);
}

githubRouter.get("/", async (req: Request, res: Response) => {
  // Never 5xx (§3.5). Every upstream failure maps to `{ available: false }`; the
  // only non-200 is a 400 for an invalid `?year=`. The catch is belt-and-braces
  // for a truly unexpected throw. Public reads return the resource raw (§4.1).
  try {
    const pat = await storedPat(req);

    const year = parseYearParam(req.query.year);
    if (year === null) {
      return res.status(400).json({
        error: "Invalid year — expected a four-digit calendar year.",
      });
    }

    if (year !== undefined) {
      // Range-check against the account's real span (creation year → this year).
      // If the span can't be resolved (e.g. GraphQL down) we can't fetch the
      // calendar either, so fall through to the normal degrade rather than 400.
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
    // Log the error only — it never carries the PAT (which lives solely in the
    // upstream GraphQL request header, never in a message or a URL).
    console.error("[githubRouter] unexpected error; serving unavailable:", err);
    res.status(200).json(UNAVAILABLE);
  }
});

export default githubRouter;
