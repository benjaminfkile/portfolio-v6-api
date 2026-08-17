import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getNowPlaying,
  NowPlaying,
  SpotifyConfig,
} from "../services/spotifyService";
import { getStoredSpotifyToken } from "../services/spotifyTokenStore";
import { resolveEncryptionKey } from "../services/serviceTokenStore";
import {
  readSnapshot,
  readLocalSnapshot,
  type UpstreamHandle,
} from "../services/upstream";

/**
 * Public now-playing router — TECH_SPEC_V1.md §4.6 (`/api/now-playing`) / #442.
 *
 * `GET /api/now-playing` (public, no auth) proxies Spotify's currently-playing
 * endpoint server-side, served from a ~30s in-memory cache. It **degrades rather
 * than errors** (§3.5): nothing playing, or ANY upstream failure, both render as
 * `{ playing: false }`, never a 5xx. No Spotify token is ever in the response —
 * the router only forwards the curated service payload (§4.6).
 *
 * Task #84 layered a shared-snapshot path on top: when Redis is configured, the
 * leader instance polls Spotify and writes the curated payload to a Redis
 * snapshot; every other instance serves that snapshot here so each Spotify
 * upstream is polled once per environment, not once per instance. A Redis
 * outage or a missing snapshot falls back to the per-instance in-memory path so
 * public reads never 5xx because of the shared store.
 */
const nowPlayingRouter = express.Router();

const NOT_PLAYING: NowPlaying = { playing: false };

async function spotifyConfig(req: Request): Promise<SpotifyConfig> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const clientSecret = secrets?.spotify_client_secret ?? "";
  const stored = await getStoredSpotifyToken(resolveEncryptionKey(secrets));
  return {
    clientId: secrets?.spotify_client_id ?? "",
    clientSecret,
    refreshToken: stored?.refreshToken ?? secrets?.spotify_refresh_token ?? "",
  };
}

nowPlayingRouter.get("/", async (req: Request, res: Response) => {
  try {
    const upstream = req.app.get("upstream") as UpstreamHandle | undefined;
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;

    // Prefer the shared snapshot when Redis is configured. Falls through to the
    // per-instance path on absent/parse-fail, and on the leader we can still
    // use the in-process copy the poll loop just wrote.
    if (upstream?.enabled && upstream.redis && secrets) {
      const snap = await readSnapshot<NowPlaying>(
        upstream.redis,
        secrets.node_env,
        "now-playing"
      );
      if (snap) {
        return res.status(200).json(snap.payload);
      }
      const local = readLocalSnapshot<NowPlaying>("now-playing");
      if (local) {
        return res.status(200).json(local);
      }
      // No snapshot yet (leader hasn't populated) — fall through to per-instance.
    }

    const payload = await getNowPlaying(await spotifyConfig(req));
    res.status(200).json(payload);
  } catch (err) {
    console.error("[nowPlayingRouter] unexpected error; serving idle:", err);
    res.status(200).json(NOT_PLAYING);
  }
});

export default nowPlayingRouter;
