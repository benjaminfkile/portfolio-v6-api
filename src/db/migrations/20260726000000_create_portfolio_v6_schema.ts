import { Knex } from "knex";

/**
 * Initial portfolio-v6 content model — the six tables of TECH_SPEC_V1.md §3.2.
 *
 * The DDL below is a faithful transcription of the spec's SQL (raw, so the
 * column types, defaults, indexes and partial/gin indexes match §3.2 exactly
 * rather than being approximated through the knex schema builder). Creation
 * order differs from the spec's listing only to satisfy the foreign keys:
 * `media_assets` is created before `posts` (posts.cover_media_id references it)
 * and before `page_versions`/`section_items` order is irrelevant.
 *
 * `gen_random_uuid()` is provided by pgcrypto; the extension is enabled here so
 * a fresh database (local throwaway cluster or a new RDS database) has it,
 * matching the `CREATE EXTENSION IF NOT EXISTS` pattern used by file-manager-api.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // Editable working set -------------------------------------------------
  await knex.raw(`
    CREATE TABLE sections (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type        text        NOT NULL,
      position    integer     NOT NULL,
      is_hidden   boolean     NOT NULL DEFAULT false,
      data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await knex.raw(
    `CREATE INDEX idx_sections_position ON sections (position);`
  );

  await knex.raw(`
    CREATE TABLE section_items (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      section_id  uuid        NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      position    integer     NOT NULL,
      is_hidden   boolean     NOT NULL DEFAULT false,
      data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await knex.raw(
    `CREATE INDEX idx_section_items_section ON section_items (section_id, position);`
  );

  // Published snapshots --------------------------------------------------
  await knex.raw(`
    CREATE TABLE page_versions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version       integer     NOT NULL UNIQUE,
      document      jsonb       NOT NULL,
      published_at  timestamptz NOT NULL DEFAULT now(),
      published_by  text        NOT NULL
    );
  `);
  await knex.raw(
    `CREATE INDEX idx_page_versions_version ON page_versions (version DESC);`
  );

  // Media ----------------------------------------------------------------
  // Created before `posts` because posts.cover_media_id references it.
  await knex.raw(`
    CREATE TABLE media_assets (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      s3_key          text        NOT NULL UNIQUE,
      mime            text        NOT NULL,
      bytes           bigint      NOT NULL,
      width           integer,
      height          integer,
      duration_ms     integer,
      alt             text,
      confirmed_at    timestamptz,
      unreferenced_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await knex.raw(`
    CREATE INDEX idx_media_unreferenced ON media_assets (unreferenced_at)
      WHERE unreferenced_at IS NOT NULL;
  `);

  // Blog -----------------------------------------------------------------
  await knex.raw(`
    CREATE TABLE posts (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug            text        NOT NULL UNIQUE,
      title           text        NOT NULL,
      excerpt         text        NOT NULL DEFAULT '',
      cover_media_id  uuid        REFERENCES media_assets(id) ON DELETE SET NULL,
      tags            text[]      NOT NULL DEFAULT '{}',
      draft_body      jsonb       NOT NULL DEFAULT '[]'::jsonb,
      published_body  jsonb,
      published_at    timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await knex.raw(`
    CREATE INDEX idx_posts_published ON posts (published_at DESC)
      WHERE published_at IS NOT NULL;
  `);
  await knex.raw(
    `CREATE INDEX idx_posts_tags ON posts USING gin (tags);`
  );
}

export async function down(knex: Knex): Promise<void> {
  // Reverse dependency order: posts references media_assets;
  // section_items references sections.
  await knex.raw(`DROP TABLE IF EXISTS posts;`);
  await knex.raw(`DROP TABLE IF EXISTS media_assets;`);
  await knex.raw(`DROP TABLE IF EXISTS page_versions;`);
  await knex.raw(`DROP TABLE IF EXISTS section_items;`);
  await knex.raw(`DROP TABLE IF EXISTS sections;`);
}
