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
  readLocalSnapshot,
  type UpstreamHandle,
} from "../services/upstream";
import {
  stampNowPlayingLastRequest,
  readSnapshotRaw,
} from "../services/upstream/snapshotStore";

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

    // Stamp the request timestamp into the shared snapshot store so the
    // leader's viewer-aware Spotify lane (task #95) knows a polling-fallback
    // viewer is around even when the realtime presence count is 0. Fire and
    // forget — a Redis blip must never fail this endpoint.
    if (upstream?.enabled && upstream.redis && secrets) {
      void stampNowPlayingLastRequest(upstream.redis, secrets.node_env);
    }

    // TASK #96 INVARIANT — when Redis is configured, the HTTP request path
    // NEVER fetches Spotify itself. The leader is the only process that ever
    // calls Spotify; every other instance (and the leader too) serves the
    // shared snapshot, or the in-process copy the poll loop just wrote, or
    // the degraded idle payload if neither is available. The direct-Spotify
    // fallback is preserved ONLY for the Redis-unconfigured and Redis-error
    // cases (never-5xx guarantee).
    if (upstream?.enabled && upstream.redis && secrets) {
      const read = await readSnapshotRaw<NowPlaying>(
        upstream.redis,
        secrets.node_env,
        "now-playing"
      );
      if (read.status === "ok") {
        return res.status(200).json(read.snapshot.payload);
      }
      if (read.status === "missing") {
        // Redis is healthy but the key is absent (leader hasn't run its first
        // tick yet, or briefly between leaders). Try the in-process leader
        // copy first; otherwise serve degraded idle. NEVER touch Spotify.
        const local = readLocalSnapshot<NowPlaying>("now-playing");
        if (local) {
          return res.status(200).json(local);
        }
        return res.status(200).json(NOT_PLAYING);
      }
      // read.status === "error" → Redis is unreachable. Fall through to the
      // legacy per-instance direct fetch so the endpoint stays 200 even
      // under a Redis outage.
    }

    const payload = await getNowPlaying(await spotifyConfig(req));
    res.status(200).json(payload);
  } catch (err) {
    console.error("[nowPlayingRouter] unexpected error; serving idle:", err);
    res.status(200).json(NOT_PLAYING);
  }
});

export default nowPlayingRouter;
