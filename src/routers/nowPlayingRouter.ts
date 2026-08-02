import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import {
  getNowPlaying,
  NowPlaying,
  SpotifyConfig,
} from "../services/spotifyService";
import { getStoredSpotifyToken } from "../services/spotifyTokenStore";

/**
 * Public now-playing router — TECH_SPEC_V1.md §4.6 (`/api/now-playing`) / #442.
 *
 * `GET /api/now-playing` (public, no auth) proxies Spotify's currently-playing
 * endpoint server-side, served from a ~30s in-memory cache. It **degrades rather
 * than errors** (§3.5): nothing playing, or ANY upstream failure, both render as
 * `{ playing: false }`, never a 5xx. No Spotify token is ever in the response —
 * the router only forwards the curated service payload (§4.6).
 */
const nowPlayingRouter = express.Router();

const NOT_PLAYING: NowPlaying = { playing: false };

/**
 * Refresh-token resolution order: the admin-connected token stored via the
 * reconnect flow (spotifyTokenStore) wins; the static `spotify_refresh_token`
 * secret is the fallback for installs still on the one-time bootstrap. The
 * store never throws and is cached in memory, so this adds no per-request DB
 * round-trip on the hot path.
 */
async function spotifyConfig(req: Request): Promise<SpotifyConfig> {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  const clientSecret = secrets?.spotify_client_secret ?? "";
  const stored = await getStoredSpotifyToken(clientSecret);
  return {
    clientId: secrets?.spotify_client_id ?? "",
    clientSecret,
    refreshToken: stored?.refreshToken ?? secrets?.spotify_refresh_token ?? "",
  };
}

nowPlayingRouter.get("/", async (req: Request, res: Response) => {
  // Never 5xx (§3.5). `getNowPlaying` maps every failure to `{ playing: false }`;
  // the catch is belt-and-braces for a truly unexpected throw. Public reads
  // return the resource raw (§4.1) — the envelope is the admin convention (§4.3).
  try {
    const payload = await getNowPlaying(await spotifyConfig(req));
    res.status(200).json(payload);
  } catch (err) {
    console.error("[nowPlayingRouter] unexpected error; serving idle:", err);
    res.status(200).json(NOT_PLAYING);
  }
});

export default nowPlayingRouter;
