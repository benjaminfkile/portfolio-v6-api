import { z } from "zod";
import { getDb } from "../db/db";
import { blogSlugSchema } from "../schemas/blogs";
import { FailureCode, ServiceResult } from "./sectionsService";

/**
 * Blogs service — Blogs v1.13.
 *
 * Owns the `blogs` table CRUD behind the admin blogs router. Mirrors
 * `pagesService`: a thin router, all logic here, and the `ServiceResult`
 * discriminated union mapped to HTTP by the router. Slug rules match a page's
 * format (`[a-z0-9-]+`) but WITHOUT the reserved-slug list — a blog slug is never
 * a route. Duplicate slugs are a 409 conflict (like a post's slug), and PATCH
 * carries the same optimistic-concurrency precondition as pages (§4.5).
 *
 * Deleting a blog is ALWAYS allowed and never deletes posts: the
 * `posts.blog_id ... ON DELETE SET NULL` FK un-assigns any assigned posts.
 */

// ---- Result envelope (shared vocabulary with sectionsService) ---------------

function fail<T>(code: FailureCode, message: string): ServiceResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

const BLOGS = "blogs";
const POSTS = "posts";

// ---- Row / view shapes ------------------------------------------------------

export interface BlogRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** Admin list item (Blogs v1.13 GET /api/admin/blogs) — carries `post_count`. */
export interface BlogListItem {
  id: string;
  slug: string;
  name: string;
  post_count: number;
  updated_at: Date;
}

// ---- Validation schemas -----------------------------------------------------

/** Create payload — both fields required. `.strict()` rejects unknown keys. */
const createBlogSchema = z
  .object({
    slug: blogSlugSchema,
    name: z.string().min(1),
  })
  .strict();

/** Update payload — draft-lenient: every provided field well-typed, none required. */
const updateBlogSchema = z
  .object({
    slug: blogSlugSchema.optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

// ---- Helpers ----------------------------------------------------------------

/**
 * Optimistic-concurrency comparison (§4.5) — identical semantics to
 * `pagesService`: compare at millisecond precision, a malformed `expected` is
 * treated as stale (409) rather than a silent overwrite.
 */
function timestampsMatch(rowUpdatedAt: Date, expected: string): boolean {
  const rowMs = new Date(rowUpdatedAt).getTime();
  const expectedMs = new Date(expected).getTime();
  return Number.isFinite(expectedMs) && rowMs === expectedMs;
}

// ---- Read: all blogs (GET /api/admin/blogs) ---------------------------------

/**
 * All blogs ordered by `name`, each with the count of posts assigned to it.
 * A LEFT JOIN keeps blogs with zero posts (`post_count = 0`).
 */
export async function listBlogs(): Promise<BlogListItem[]> {
  const db = getDb();
  const rows = await db<BlogRow>(BLOGS)
    .leftJoin(POSTS, `${POSTS}.blog_id`, `${BLOGS}.id`)
    .groupBy(`${BLOGS}.id`)
    .orderBy(`${BLOGS}.name`, "asc")
    .select(
      `${BLOGS}.id`,
      `${BLOGS}.slug`,
      `${BLOGS}.name`,
      `${BLOGS}.updated_at`
    )
    .count(`${POSTS}.id as post_count`);

  return (rows as unknown as Array<
    BlogRow & { post_count: string | number }
  >).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    post_count: Number(r.post_count),
    updated_at: r.updated_at,
  }));
}

/** The set of existing blog slugs — used by publish-time section validation. */
export async function getBlogSlugs(): Promise<Set<string>> {
  const rows = await getDb()<BlogRow>(BLOGS).select("slug");
  return new Set(rows.map((r) => r.slug));
}

// ---- Create blog (POST /api/admin/blogs) ------------------------------------

export interface CreateBlogInput {
  slug?: unknown;
  name?: unknown;
}

export async function createBlog(
  input: CreateBlogInput
): Promise<ServiceResult<BlogRow>> {
  const parsed = createBlogSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return fail("validation", `Invalid blog: ${parsed.error.message}`);
  }
  const { slug, name } = parsed.data;

  const db = getDb();
  // Duplicate slug → 409 conflict (the UNIQUE constraint also protects; a
  // pre-check gives a clean deterministic message — single-admin, no race).
  const clash = await db<BlogRow>(BLOGS).where({ slug }).first();
  if (clash) return fail("conflict", `slug "${slug}" already exists`);

  const [row] = await db<BlogRow>(BLOGS).insert({ slug, name }).returning("*");
  return ok(row);
}

// ---- Update blog (PATCH + §4.5 precondition) --------------------------------

export interface UpdateBlogInput {
  expected_updated_at: string;
  slug?: unknown;
  name?: unknown;
}

export async function updateBlog(
  id: string,
  input: UpdateBlogInput
): Promise<ServiceResult<BlogRow>> {
  const fields: Record<string, unknown> = {};
  for (const key of ["slug", "name"] as const) {
    if (input[key] !== undefined) fields[key] = input[key];
  }
  if (Object.keys(fields).length === 0) {
    return fail("bad_request", "Provide at least one of slug or name");
  }
  const parsed = updateBlogSchema.safeParse(fields);
  if (!parsed.success) {
    return fail("validation", `Invalid blog: ${parsed.error.message}`);
  }
  const patchFields = parsed.data;

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<BlogRow>(BLOGS).where({ id }).forUpdate().first();
    if (!row) return fail<BlogRow>("not_found", "Blog not found");

    if (!timestampsMatch(row.updated_at, input.expected_updated_at)) {
      // Stale precondition → 409, no write (§4.5).
      return fail<BlogRow>(
        "conflict",
        "Blog changed since it was loaded (expected_updated_at mismatch)"
      );
    }

    // A slug change must not collide with another blog's slug (409, like create).
    if (patchFields.slug !== undefined && patchFields.slug !== row.slug) {
      const clash = await trx<BlogRow>(BLOGS)
        .where({ slug: patchFields.slug })
        .andWhereNot({ id })
        .first();
      if (clash) {
        return fail<BlogRow>("conflict", `slug "${patchFields.slug}" already exists`);
      }
    }

    const [updated] = await trx<BlogRow>(BLOGS)
      .where({ id })
      .update({ ...patchFields, updated_at: trx.fn.now() } as never)
      .returning("*");
    return ok(updated);
  });
}

// ---- Delete blog (DELETE /api/admin/blogs/:id) ------------------------------

/**
 * Delete a blog. ALWAYS allowed and never deletes posts: the
 * `posts.blog_id ... ON DELETE SET NULL` FK un-assigns any assigned posts. A
 * 404 only when the id does not exist.
 */
export async function deleteBlog(id: string): Promise<ServiceResult<null>> {
  const db = getDb();
  const count = await db<BlogRow>(BLOGS).where({ id }).del();
  if (count === 0) return fail("not_found", "Blog not found");
  return ok(null);
}
