import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { NowPlaying } from "../services/spotifyService";
import { getLastNowPlaying } from "../services/nowPlayingStateStore";
import {
  readLocalSnapshot,
  type UpstreamHandle,
} from "../services/upstream";
import {
  stampNowPlayingLastRequest,
  readSnapshotRaw,
} from "../services/upstream/snapshotStore";

/**
 * Public now-playing router — `GET /api/now-playing` (public, no auth).
 *
 * The now-playing feed is listener-only and event-driven: the dealer listener
 * (task series #115-#123) is the SOLE source, running on the leader, which
 * writes the shared Redis snapshot and persists the last curated payload to the
 * database. This endpoint never calls Spotify itself. It serves, in order of
 * preference: the live Redis snapshot, the leader's in-process copy, then the
 * durable DB last-known; failing all of those it returns `{ playing: false }`.
 * It **degrades rather than errors** (§3.5): every path resolves to a 200 with
 * a curated payload, never a 5xx, and no token is ever in the response.
 */
const nowPlayingRouter = express.Router();

const NOT_PLAYING: NowPlaying = { playing: false };

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
        // copy, then the durable DB last-known, then idle.
        const local = readLocalSnapshot<NowPlaying>("now-playing");
        if (local) {
          return res.status(200).json(local);
        }
        const stored = await getLastNowPlaying();
        return res.status(200).json(stored ?? NOT_PLAYING);
      }
      // read.status === "error" → Redis is unreachable. Fall through to the
      // durable DB last-known so the endpoint stays 200 under a Redis outage.
    }

    // No live snapshot available (Redis unconfigured or unreachable). Serve the
    // durable last-known payload the listener persisted. The now-playing feed
    // is listener-only now, so we NEVER call Spotify from the request path.
    const stored = await getLastNowPlaying();
    res.status(200).json(stored ?? NOT_PLAYING);
  } catch (err) {
    console.error("[nowPlayingRouter] unexpected error; serving idle:", err);
    res.status(200).json(NOT_PLAYING);
  }
});

export default nowPlayingRouter;
