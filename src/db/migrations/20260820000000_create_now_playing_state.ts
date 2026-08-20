import { Knex } from "knex";

/**
 * `now_playing_state` — durable last-known now-playing payload.
 *
 * The dealer-listener is the single source of now-playing (the Spotify Web API
 * polling path was removed). Redis holds the live snapshot for cross-instance
 * serving, but Redis is ephemeral: a cold start or a Redis flush would blank
 * the widget until the next listener event. This table persists the last
 * curated payload the listener emitted so `GET /api/now-playing` always has a
 * durable answer to serve on page load, event-driven clients included.
 *
 * A single row (id = true, a one-row guard) holds the whole curated NowPlaying
 * JSON as JSONB. Last-write-wins under the single-leader invariant.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE now_playing_state (
      id          boolean     PRIMARY KEY DEFAULT true,
      payload     jsonb       NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT now_playing_state_singleton CHECK (id)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS now_playing_state;`);
}
