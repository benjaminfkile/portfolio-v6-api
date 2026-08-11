import { Knex } from "knex";

/**
 * Machine Auth v1.15 — record WHO published a post so a machine publish can be
 * attributed. `publishPost` stamps `published_by` on every publish: a human
 * admin's Cognito `sub`, or `machine:<client_id>` when the external posting bot
 * publishes via its client-credentials access token (see `requireAdminOrMachine`).
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
