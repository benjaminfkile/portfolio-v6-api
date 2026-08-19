import { Knex } from "knex";

/**
 * `service_settings` — task #113. A tiny shared key/value table for per-service
 * operator toggles that must survive restarts AND be visible to every instance
 * (same shared-record-is-authoritative philosophy as `preview_tokens` and the
 * Spotify suspension record — task #97).
 *
 * Today this holds exactly one shape: the Spotify enable/disable flag written
 * by the admin `/api/admin/spotify/enable`|`/disable` endpoints. Disabled=true
 * means the poller makes ZERO Spotify calls regardless of whether a stored
 * grant exists — the explicit off switch the admin panel exposes independent
 * of the credentials state. Default is ENABLED (absent row).
 *
 * Values are JSONB so a future integration can persist a small object here
 * without another migration, but the store treats it as opaque.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE service_settings (
      service     text        NOT NULL,
      key         text        NOT NULL,
      value       jsonb       NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (service, key)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS service_settings;`);
}
