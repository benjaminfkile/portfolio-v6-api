import { Knex } from "knex";

/**
 * Timeline items no longer carry an image. The timeline item shape is now
 * `{ date_range, title, description }`; `media_id` was removed from
 * `timelineItemSchema` (TECH_SPEC_V1.md §3.4 timeline item).
 *
 * The item schemas are `.strict()`, so any `section_items.data` still carrying a
 * `media_id` key would fail admin PATCHes AND publish for that draft. This
 * migration strips the leftover key from every `section_items` row whose parent
 * section is a timeline section, so existing drafts keep validating.
 *
 * Plain SQL (`data - 'media_id'`) scoped by a subquery on `sections` so only
 * timeline items are touched — portfolio items (whose `media_id` is REQUIRED,
 * not removed) must not be rewritten.
 *
 * Published-document snapshots are intentionally NOT rewritten: the next publish
 * regenerates them, and older snapshots retain their timeline images for the
 * orphan sweep's version-history reference scan (§6.9), which is what keeps the
 * S3 objects around for as long as the version history does.
 */
export async function up(knex: Knex): Promise<void> {
  // `jsonb_exists(data, 'media_id')` rather than the `?` operator: knex.raw
  // treats a bare `?` as a positional bind placeholder, so the function form is
  // used to keep the existence check while staying a single parameterless
  // statement.
  await knex.raw(`
    UPDATE section_items
       SET data = data - 'media_id'
     WHERE jsonb_exists(data, 'media_id')
       AND section_id IN (
         SELECT id FROM sections WHERE type = 'timeline'
       );
  `);
}

export async function down(knex: Knex): Promise<void> {
  // No-op: the stripped media_id values are unrecoverable. Matching the repo's
  // convention of an explicit, commented no-op down for data-only migrations
  // that cannot be reversed.
}
