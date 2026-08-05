import { Knex } from "knex";

/**
 * Analytics v1.4 — first-party, privacy-respecting analytics ingest store
 * (TECH_SPEC_V1.md §4.8, §3.2 family).
 *
 * Raw SQL (like the other §3.2 migrations) so the column types, defaults, and
 * indexes match the spec's schema block verbatim rather than being approximated
 * through the knex schema builder.
 *
 * No PII is ever stored here: `session_key` is a daily-rotating salted hash of
 * (day_salt | client_ip | user_agent) truncated to 32 hex chars; the raw IP and
 * user-agent are hash input only, never columns. `referrer` holds a scheme+host
 * ORIGIN only (null when same-origin). Retention is enforced at ingest, not by
 * this migration.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE analytics_events (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at  timestamptz NOT NULL DEFAULT now(),
      session_key  text        NOT NULL,
      event        text        NOT NULL,
      path         text        NOT NULL,
      referrer     text,
      meta         jsonb       NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await knex.raw(
    `CREATE INDEX idx_analytics_time ON analytics_events (occurred_at DESC);`
  );
  await knex.raw(
    `CREATE INDEX idx_analytics_session ON analytics_events (session_key, occurred_at);`
  );
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the table removes both indexes with it.
  await knex.raw(`DROP TABLE IF EXISTS analytics_events;`);
}
