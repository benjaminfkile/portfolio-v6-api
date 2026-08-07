import { Knex } from "knex";

/**
 * Skills Sphere v1.5 — proficiency is removed from the product
 * (TECH_SPEC_V1.md §3.4 skills item). The skills item shape is now
 * `{ title, description, icon_source }`; `proficiency` no longer exists in the
 * schema, forms, renderer, or fixtures.
 *
 * The item schemas are `.strict()`, so any `section_items.data` still carrying a
 * `proficiency` key would fail admin writes AND publish for that draft. This
 * migration strips the leftover key from every `section_items` row whose parent
 * section is a skills section, so existing drafts keep validating.
 *
 * Plain SQL (`data - 'proficiency'`) scoped by a subquery on `sections` so only
 * skills items are touched — a `proficiency` key on a non-skills section (there
 * is none in the product, but the scope keeps the write minimal and safe) is
 * left alone.
 *
 * Published-document snapshots are intentionally NOT rewritten: the next publish
 * regenerates them, and public reads of an older snapshot that still contains
 * `proficiency` are harmless (the public site ignores unknown keys).
 */
export async function up(knex: Knex): Promise<void> {
  // `jsonb_exists(data, 'proficiency')` rather than the `?` operator: knex.raw
  // treats a bare `?` as a positional bind placeholder, so the function form is
  // used to keep the existence check while staying a single parameterless
  // statement.
  await knex.raw(`
    UPDATE section_items
       SET data = data - 'proficiency'
     WHERE jsonb_exists(data, 'proficiency')
       AND section_id IN (
         SELECT id FROM sections WHERE type = 'skills'
       );
  `);
}

export async function down(knex: Knex): Promise<void> {
  // No-op: the stripped proficiency values are unrecoverable. Matching the
  // repo's convention of an explicit, commented no-op down for data-only
  // migrations that cannot be reversed.
}
