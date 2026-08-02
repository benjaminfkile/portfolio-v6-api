import { Knex } from "knex";

/**
 * Shared test helper — TECH_SPEC_V1.md §3.10.
 *
 * v1.1 makes `sections.page_id` a required foreign key, so any test that inserts
 * a section DIRECTLY (bypassing the sections service, which resolves the page on
 * its own) must supply a `page_id`. This ensures the single implicit `home` page
 * exists and returns its id; it is idempotent, so repeated calls across a
 * suite's `beforeEach`/tests reuse the same page.
 */
export async function ensureHomePage(db: Knex): Promise<string> {
  const existing = await db("pages").where({ slug: "home" }).first();
  if (existing) return (existing as { id: string }).id;
  const [row] = await db("pages")
    .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
    .returning("id");
  return (row as { id: string }).id;
}
