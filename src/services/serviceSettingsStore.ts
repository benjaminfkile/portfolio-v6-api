import { getDb } from "../db/db";

/**
 * `service_settings` accessor — task #113. A tiny shared key/value store for
 * per-service operator toggles that must survive restarts AND be visible to
 * every instance (same shared-record-is-authoritative philosophy as
 * `preview_tokens` / the Spotify suspension record).
 *
 * Today the ONLY setting persisted here is the Spotify enable/disable flag
 * written by the admin `/api/admin/spotify/enable`|`/disable` endpoints. The
 * store treats the value as an opaque JSON payload so a future integration
 * can persist a small object here without another migration.
 *
 * Missing row means "default" — for the Spotify enable flag, absent = ENABLED.
 * Writes are upsert / last-write-wins; reads never throw (a DB blip is logged
 * and returns `null` so the caller can decide how to degrade).
 */

const SERVICE_SETTINGS_TABLE = "service_settings";

/** Read a setting's value, or null when absent / on read error. */
export async function readServiceSetting<T = unknown>(
  service: string,
  key: string
): Promise<T | null> {
  try {
    const row = (await getDb()(SERVICE_SETTINGS_TABLE)
      .where({ service, key })
      .select("value")
      .first()) as { value: T } | undefined;
    return row ? row.value : null;
  } catch (err) {
    console.error(
      `[serviceSettingsStore] read failed for '${service}:${key}':`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Upsert a setting's value. Throws on DB/serialization failure. */
export async function writeServiceSetting<T = unknown>(
  service: string,
  key: string,
  value: T
): Promise<void> {
  const now = new Date();
  await getDb()(SERVICE_SETTINGS_TABLE)
    .insert({
      service,
      key,
      // knex-postgres serializes JS values into jsonb; wrap in JSON.stringify
      // so knex doesn't try to expand arrays into `= ANY(...)` bindings.
      value: JSON.stringify(value),
      updated_at: now,
    })
    .onConflict(["service", "key"])
    .merge(["value", "updated_at"]);
}

// ---- Spotify enable flag ----------------------------------------------------
//
// The one production setting today. Default (absent row) = ENABLED — current
// prod has no grant, so it already reads as `disconnected` from the status
// endpoint. Explicit `enabled: false` means the poller MUST make zero Spotify
// calls regardless of whether a stored grant exists — this is the admin's
// off switch that is independent of credentials state.

export const SPOTIFY_SETTINGS_SERVICE = "spotify";
export const SPOTIFY_ENABLED_KEY = "enabled";

/** Is Spotify explicitly disabled? False by default (absent row = enabled). */
export async function isSpotifyDisabled(): Promise<boolean> {
  const raw = await readServiceSetting<{ enabled?: boolean } | boolean>(
    SPOTIFY_SETTINGS_SERVICE,
    SPOTIFY_ENABLED_KEY
  );
  if (raw == null) return false;
  // Support both storage shapes (plain boolean and `{enabled: bool}`) so a
  // future migration to a richer object doesn't strand old rows.
  if (typeof raw === "boolean") return raw === false;
  if (typeof raw === "object" && "enabled" in raw) {
    return raw.enabled === false;
  }
  return false;
}

/** Persist the enable flag. `enabled: false` = disabled, true = enabled. */
export async function setSpotifyEnabled(enabled: boolean): Promise<void> {
  await writeServiceSetting(SPOTIFY_SETTINGS_SERVICE, SPOTIFY_ENABLED_KEY, {
    enabled,
  });
}
