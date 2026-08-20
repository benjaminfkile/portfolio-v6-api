import { getDb } from "../db/db";
import type { NowPlaying } from "./spotifyService";

/**
 * Durable last-known now-playing store (`now_playing_state`, a one-row table).
 *
 * The dealer-listener is the only source of now-playing. Redis carries the live
 * snapshot, but it is ephemeral; this store persists the last curated payload
 * so `GET /api/now-playing` still returns the last-known track after a cold
 * start / Redis flush, and event-driven clients have something to render on
 * load. Writes are last-write-wins under the single-leader invariant; reads and
 * writes never throw (a DB blip degrades to null / a swallowed write), so they
 * can sit on the now-playing hot path without ever failing the endpoint.
 */

const SINGLETON_ID = true;

/** Persist the latest curated now-playing payload. Never throws. */
export async function saveLastNowPlaying(payload: NowPlaying): Promise<void> {
  try {
    await getDb()("now_playing_state")
      .insert({
        id: SINGLETON_ID,
        payload: JSON.stringify(payload),
        updated_at: new Date(),
      })
      .onConflict("id")
      .merge(["payload", "updated_at"]);
  } catch (err) {
    console.error(
      "[nowPlayingStateStore] failed to persist last now-playing (swallowed):",
      err instanceof Error ? err.message : err
    );
  }
}

/** The last-known curated payload, or null when none is stored / on error. */
export async function getLastNowPlaying(): Promise<NowPlaying | null> {
  try {
    const row = (await getDb()("now_playing_state")
      .where({ id: SINGLETON_ID })
      .first()) as { payload: unknown } | undefined;
    if (!row) return null;
    // JSONB comes back parsed from pg; tolerate a string just in case.
    const payload =
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    return (payload as NowPlaying) ?? null;
  } catch (err) {
    console.error(
      "[nowPlayingStateStore] failed to read last now-playing (swallowed):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
