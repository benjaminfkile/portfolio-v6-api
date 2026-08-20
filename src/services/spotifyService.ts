/**
 * Curated now-playing types.
 *
 * Now-playing is produced by the dealer-listener (the connect-listener maps
 * Spotify cluster state to these shapes); the old Spotify Web API polling
 * service was removed. Only the curated types live here now — they are the
 * contract the listener, the DB last-known store, and the public router share.
 * No Spotify token, in any form, ever appears in these shapes.
 */

/** Curated track shape — deliberately NOT Spotify's raw payload. */
export interface NowPlayingTrack {
  title: string;
  artists: string[];
  album: string;
  art_url: string | null;
  url: string | null;
  progress_ms: number | null;
  duration_ms: number | null;
}

/** The last-played track and when it finished (ISO 8601), curated shape. */
export interface LastPlayed {
  track: NowPlayingTrack;
  played_at: string;
}

/**
 * Curated /api/now-playing payload. Never contains any token. When idle,
 * `last_played` may carry the most recently played track.
 */
export type NowPlaying =
  | { playing: false; last_played?: LastPlayed }
  | { playing: true; track: NowPlayingTrack };
