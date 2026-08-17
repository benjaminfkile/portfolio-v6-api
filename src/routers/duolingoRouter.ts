import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getDuolingo,
  resolveLanguage,
  DuolingoResult,
  DUOLINGO_SERVICE_KEY,
  DEFAULT_LANGUAGE,
} from "../services/duolingoService";
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
 * Public Duolingo router — TECH_SPEC_V1.md §3.5/§4.1 (`/api/duolingo`, v1.2) /
 * task #484.
 *
 * `GET /api/duolingo` (public, no auth) proxies Duolingo's unofficial users
 * endpoint server-side, served from a ~1h in-memory cache. It **degrades rather
 * than errors** (§3.5): no configured username, ANY upstream failure, shape
 * drift, or an unknown `?language=` course all render as `{ available: false }`,
 * never a 5xx. The stored username never appears in the response — the router
 * only forwards the curated service payload.
 *
 * Task #84: when Redis is configured and the request asks for the DEFAULT
 * language (`es`), we serve from the shared snapshot the leader writes. Any
 * other `?language=` value falls through to the per-instance path unchanged —
 * pre-populating every language is out of scope; the ~1h in-memory cache
 * absorbs the traffic just fine.
 */
const duolingoRouter = express.Router();

const UNAVAILABLE: DuolingoResult = { available: false };

async function storedUsername(req: Request): Promise<string> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const stored = await getStoredServiceToken(
    DUOLINGO_SERVICE_KEY,
    resolveEncryptionKey(secrets)
  );
  return stored?.token ?? "";
}

duolingoRouter.get("/", async (req: Request, res: Response) => {
  try {
    const language = resolveLanguage(req.query.language);
    const upstream = req.app.get("upstream") as UpstreamHandle | undefined;
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;

    if (
      language === DEFAULT_LANGUAGE &&
      upstream?.enabled &&
      upstream.redis &&
      secrets
    ) {
      const snap = await readSnapshot<DuolingoResult>(
        upstream.redis,
        secrets.node_env,
        "duolingo"
      );
      if (snap) {
        return res.status(200).json(snap.payload);
      }
      const local = readLocalSnapshot<DuolingoResult>("duolingo");
      if (local) {
        return res.status(200).json(local);
      }
    }

    const username = await storedUsername(req);
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
