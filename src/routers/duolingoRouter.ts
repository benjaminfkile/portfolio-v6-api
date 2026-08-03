import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getDuolingo,
  resolveLanguage,
  DuolingoResult,
  DUOLINGO_SERVICE_KEY,
} from "../services/duolingoService";
import {
  getStoredServiceToken,
  resolveEncryptionKey,
} from "../services/serviceTokenStore";

/**
 * Public Duolingo router — TECH_SPEC_V1.md §3.5/§4.1 (`/api/duolingo`, v1.2) /
 * task #484.
 *
 * `GET /api/duolingo` (public, no auth) proxies Duolingo's unofficial users
 * endpoint server-side, served from a ~1h in-memory cache. It **degrades rather
 * than errors** (§3.5): no configured username, ANY upstream failure, shape
 * drift, or an unknown `?language=` course all render as `{ available: false }`,
 * never a 5xx. The stored username never appears in the response — the router
 * only forwards the curated service payload.
 */
const duolingoRouter = express.Router();

const UNAVAILABLE: DuolingoResult = { available: false };

/**
 * The stored Duolingo username lives under the `duolingo` service key in the
 * shared, service-keyed credential store (§4.7). It is public data, but it is
 * still resolved server-side and never returned to the client. The store never
 * throws and caches in memory, so this adds no per-request DB round-trip on the
 * hot path.
 */
async function storedUsername(req: Request): Promise<string> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const stored = await getStoredServiceToken(
    DUOLINGO_SERVICE_KEY,
    resolveEncryptionKey(secrets)
  );
  return stored?.token ?? "";
}

duolingoRouter.get("/", async (req: Request, res: Response) => {
  // Never 5xx (§3.5). `getDuolingo` maps every failure to `{ available: false }`;
  // the catch is belt-and-braces for a truly unexpected throw. Public reads
  // return the resource raw (§4.1) — the envelope is the admin convention (§4.3).
  try {
    const username = await storedUsername(req);
    const language = resolveLanguage(req.query.language);
    const payload = await getDuolingo(username, language);
    res.status(200).json(payload);
  } catch (err) {
    console.error(
      "[duolingoRouter] unexpected error; serving unavailable:",
      err
    );
    res.status(200).json(UNAVAILABLE);
  }
});

export default duolingoRouter;
