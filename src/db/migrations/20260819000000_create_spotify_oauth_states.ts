import { Knex } from "knex";

/**
 * `spotify_oauth_states` — task #113. The admin Spotify reconnect flow used to
 * hold its OAuth state token in a per-container in-memory Map. Once the API
 * went multi-instance (2026-08-17) the Spotify callback started round-robining
 * to the wrong node — a `state` minted on instance A did not exist on B, so
 * every reconnect surfaced the "invalid or expired" failure UX and no grant
 * was ever stored. Same shape as `preview_tokens` (task #105): shared row is
 * authoritative, hashed at rest, opportunistic cleanup.
 *
 * `state_hash` (sha256 hex of the raw state) is the primary key so a DB dump
 * never leaks a usable OAuth state; the raw state only ever exists in memory
 * of the connect-start request and in the caller's browser.
 * `consumed_at` (nullable) marks single-use: the callback validates and marks
 * consumed atomically so a second callback with the same state fails, even
 * across instances.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE spotify_oauth_states (
      state_hash  text        PRIMARY KEY,
      return_to   text,
      expires_at  timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS spotify_oauth_states;`);
}
