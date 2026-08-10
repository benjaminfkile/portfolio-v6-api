import { Knex } from "knex";

/**
 * Blogs v1.13 — named blogs (Blogs v1.13 contract).
 *
 * A post can belong to a named blog ("Code", "Food", "Motorcycle"). This mirrors
 * the pages migration in spirit: raw, additive SQL so the column types, defaults,
 * and indexes match the contract exactly rather than being approximated through
 * the knex schema builder. `gen_random_uuid()` comes from pgcrypto, enabled by
 * the initial migration.
 *
 * The `blogs` table holds one row per named blog (a URL-safe `slug` + a display
 * `name`). `posts.blog_id` is a NULLABLE FK: a post may belong to no blog, and
 * `ON DELETE SET NULL` means deleting a blog un-assigns its posts rather than
 * deleting them. The change is fully back-compatible — every existing post keeps
 * `blog_id = NULL` and no route/read behaviour changes until a blog is assigned.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE blogs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug        text        NOT NULL UNIQUE,
      name        text        NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Nullable FK: a post may belong to no blog; deleting a blog un-assigns its
  // posts (never deletes them) via ON DELETE SET NULL.
  await knex.raw(`
    ALTER TABLE posts
      ADD COLUMN blog_id uuid REFERENCES blogs(id) ON DELETE SET NULL;
  `);
  await knex.raw(`CREATE INDEX idx_posts_blog ON posts (blog_id);`);
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the column removes the FK and the index; then drop the table.
  await knex.raw(`ALTER TABLE posts DROP COLUMN IF EXISTS blog_id;`);
  await knex.raw(`DROP TABLE IF EXISTS blogs;`);
}
