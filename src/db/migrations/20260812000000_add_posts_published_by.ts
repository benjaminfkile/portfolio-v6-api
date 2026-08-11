import { Knex } from "knex";

/**
 * Record WHO published a post so a key-driven publish can be attributed.
 * `publishPost` stamps `published_by` on every publish: a human admin's Cognito
 * `sub`, or `key:<name>` when the external posting bot publishes via a
 * dashboard-minted API key (API Keys v1.16; see `requireAdminOrMachine`).
 *
 * Nullable with no default and no backfill: rows published before this migration
 * (and never re-published since) simply read `NULL` for attribution, and every
 * new publish sets it. Mirrors the site-publish `published_by` column on
 * `site_versions`/`page_versions` (§4.2), but on `posts` there is one live row
 * per post rather than a version history, so the column lives on `posts` itself.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE posts ADD COLUMN published_by text;`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE posts DROP COLUMN IF EXISTS published_by;`);
}
