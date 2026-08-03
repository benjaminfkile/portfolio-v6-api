import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getGithub,
  GithubResult,
  GITHUB_SERVICE_KEY,
} from "../services/githubService";
import {
  getStoredServiceToken,
  resolveEncryptionKey,
} from "../services/serviceTokenStore";

/**
 * Public GitHub router — TECH_SPEC_V1.md §3.5/§4.1 (`/api/github`, v1.2) /
 * task #485.
 *
 * `GET /api/github` (public, no auth) proxies GitHub's GraphQL contribution
 * calendar server-side, served from a ~1h in-memory cache. It **degrades rather
 * than errors** (§3.5): no configured PAT, ANY upstream failure, a GraphQL
 * `errors` array, or shape drift all render as `{ available: false }`, never a
 * 5xx. The stored PAT never appears in the response — the router only forwards
 * the curated service payload.
 */
const githubRouter = express.Router();

const UNAVAILABLE: GithubResult = { available: false };

/**
 * The stored GitHub PAT lives under the `github` service key in the shared,
 * service-keyed credential store (§4.7). It is a real secret — resolved
 * server-side, passed only to `getGithub` (which forwards it solely in the
 * upstream `Authorization` header), and never returned to the client. The store
 * never throws and caches in memory, so this adds no per-request DB round-trip
 * on the hot path.
 */
async function storedPat(req: Request): Promise<string> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const stored = await getStoredServiceToken(
    GITHUB_SERVICE_KEY,
    resolveEncryptionKey(secrets)
  );
  return stored?.token ?? "";
}

githubRouter.get("/", async (req: Request, res: Response) => {
  // Never 5xx (§3.5). `getGithub` maps every failure to `{ available: false }`;
  // the catch is belt-and-braces for a truly unexpected throw. Public reads
  // return the resource raw (§4.1) — the envelope is the admin convention (§4.3).
  try {
    const pat = await storedPat(req);
    const payload = await getGithub(pat);
    res.status(200).json(payload);
  } catch (err) {
    // Log the error only — it never carries the PAT (which lives solely in the
    // upstream request header, never in a message or the URL).
    console.error("[githubRouter] unexpected error; serving unavailable:", err);
    res.status(200).json(UNAVAILABLE);
  }
});

export default githubRouter;
