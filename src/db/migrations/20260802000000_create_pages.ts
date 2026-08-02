import { Knex } from "knex";

/**
 * Pages v1.1 — first-class pages (TECH_SPEC_V1.md §3.2 / §3.10).
 *
 * v1 modelled one implicit page: a flat, ordered list of `sections` rendered at
 * `/`. v1.1 makes pages first-class: every section belongs to exactly one page
 * (`sections.page_id`, cascade on page delete) and the public site renders
 * whatever pages the published document contains.
 *
 * Raw SQL (like the initial §3.2 migration) so the column types, defaults, and
 * indexes match the spec exactly rather than being approximated through the knex
 * schema builder. `gen_random_uuid()` comes from pgcrypto, enabled by the
 * initial migration.
 *
 * Backfill (§3.10 "Back-compat"): so the first publish after deploying v1.1
 * flips the document shape atomically, an existing working set (any `sections`
 * rows) is adopted into a single `home` page — slug `home`, title `Home`,
 * nav_label `Home`, nav_position 0 — preserving each section's current
 * `position`. Only then is `page_id` made NOT NULL and the FK added, so a
 * populated database migrates without a NOT-NULL violation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE pages (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug          text        NOT NULL UNIQUE,
      title         text        NOT NULL,
      nav_label     text,
      nav_position  integer     NOT NULL DEFAULT 0,
      is_hidden     boolean     NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await knex.raw(`CREATE INDEX idx_pages_nav ON pages (nav_position);`);

  // Add the link column nullable first so the backfill can populate it before
  // the NOT NULL constraint is enforced.
  await knex.raw(`ALTER TABLE sections ADD COLUMN page_id uuid;`);

  // Backfill: adopt any pre-existing sections into a single `home` page,
  // preserving their current `position` order (untouched by this UPDATE).
  await knex.raw(`
    DO $$
    DECLARE
      home_id uuid;
    BEGIN
      IF EXISTS (SELECT 1 FROM sections) THEN
        INSERT INTO pages (slug, title, nav_label, nav_position)
          VALUES ('home', 'Home', 'Home', 0)
          RETURNING id INTO home_id;
        UPDATE sections SET page_id = home_id;
      END IF;
    END $$;
  `);

  await knex.raw(`ALTER TABLE sections ALTER COLUMN page_id SET NOT NULL;`);
  await knex.raw(`
    ALTER TABLE sections
      ADD CONSTRAINT sections_page_id_fkey
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
  `);

  // Sections are now ordered within their page — the working-set index becomes
  // (page_id, position). Reuse the spec's index name.
  await knex.raw(`DROP INDEX idx_sections_position;`);
  await knex.raw(
    `CREATE INDEX idx_sections_position ON sections (page_id, position);`
  );
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the column cascades away both the FK constraint and the
  // (page_id, position) index; then restore the v1 single-column index and drop
  // the pages table.
  await knex.raw(`ALTER TABLE sections DROP COLUMN IF EXISTS page_id;`);
  await knex.raw(`CREATE INDEX idx_sections_position ON sections (position);`);
  await knex.raw(`DROP TABLE IF EXISTS pages;`);
}
