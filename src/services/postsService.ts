import { Knex } from "knex";
import { getDb } from "../db/db";
import { blockArraySchema, draftBlockArraySchema, slugSchema, BlockArray } from "../schemas";
import { BlogRef } from "../schemas/blogs";
import { stripEmptyStrings } from "../utils/draftData";
import { collectMediaIds } from "../utils/mediaRefs";
import { resolveMediaMap, toCdnUrl, MediaRef } from "../utils/cdn";

/**
 * Blog posts service — TECH_SPEC_V1.md §3.6, §3.7, §4.1, §4.2, §4.5.
 *
 * A post is a single `posts` row carrying its own `draft_body` and
 * `published_body` (§3.6) — deliberately NOT the snapshot model the page uses,
 * because one row is already atomic and a one-query read. This service owns the
 * admin CRUD, the publish/unpublish lifecycle, the slug-immutability rule
 * (§3.6), the public read endpoints (summaries + one published post, §4.1), and
 * the draft preview serialization (§4.2 †). Every wholesale write carries the
 * optimistic-concurrency precondition (§4.5).
 *
 * Bodies are validated against the canonical Zod block union (§3.7 / §3.9) on
 * every admin write AND re-validated at publish time — invalid content can reach
 * a draft, never production. HTTP mapping is left to the router: functions return
 * a discriminated `PostResult` and the router translates the failure `code`.
 */

// ---- Result envelope (mirrors sectionsService / publishService) -------------

export type PostFailureCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "bad_request";

export type PostResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PostFailureCode; message: string };

function fail<T>(code: PostFailureCode, message: string): PostResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): PostResult<T> {
  return { ok: true, data };
}

const POSTS = "posts";
const MEDIA_ASSETS = "media_assets";
const BLOGS = "blogs";

/** Default / maximum page size for the public summaries endpoint (§4.1). */
export const DEFAULT_POSTS_LIMIT = 20;
export const MAX_POSTS_LIMIT = 100;

// ---- Row / view shapes ------------------------------------------------------

export interface PostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  cover_media_id: string | null;
  blog_id: string | null;
  tags: string[];
  draft_body: BlockArray;
  published_body: BlockArray | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Public post summary — §4.1. Never carries a body. */
export interface PostSummary {
  slug: string;
  title: string;
  excerpt: string;
  cover: MediaRef | null;
  tags: string[];
  published_at: string;
  /** Owning blog (Blogs v1.13), or null when the post belongs to no blog. */
  blog: BlogRef | null;
}

/** One public published post — §4.1. `published_body` only. */
export interface PublicPost {
  slug: string;
  title: string;
  excerpt: string;
  cover: MediaRef | null;
  tags: string[];
  published_at: string;
  /** Owning blog (Blogs v1.13), or null when the post belongs to no blog. */
  blog: BlogRef | null;
  body: BlockArray;
  media: Record<string, MediaRef>;
}

// ---- Optimistic concurrency (§4.5) ------------------------------------------

/**
 * Compare the row's `updated_at` against the client's `expected_updated_at`
 * (§4.5), at the millisecond precision the pg client exposes — exactly the
 * precision a round-tripped ISO string carries. A malformed expected value never
 * equals a real timestamp, so it is treated as stale (409) rather than a silent
 * overwrite.
 */
function timestampsMatch(rowUpdatedAt: Date, expected: string): boolean {
  const rowMs = new Date(rowUpdatedAt).getTime();
  const expectedMs = new Date(expected).getTime();
  return Number.isFinite(expectedMs) && rowMs === expectedMs;
}

// ---- Field validation -------------------------------------------------------

function validateSlug(value: unknown): PostResult<string> {
  const parsed = slugSchema.safeParse(value);
  if (!parsed.success) {
    return fail("validation", `Invalid slug: ${parsed.error.issues[0]?.message}`);
  }
  return ok(parsed.data);
}

function validateBody(value: unknown): PostResult<BlockArray> {
  const parsed = blockArraySchema.safeParse(value);
  if (!parsed.success) {
    return fail(
      "validation",
      `Invalid draft_body block(s): ${parsed.error.message}`
    );
  }
  return ok(parsed.data);
}

/**
 * Draft-lenient body validation for admin WRITES (§3.9: invalid content can
 * reach a draft, never production): every block needs a known `type` and
 * well-typed provided fields, but nothing else is required — a half-filled
 * block saves fine. `publishPost` validates the canonical union and is the
 * completeness gate.
 */
function validateDraftBody(value: unknown): PostResult<BlockArray> {
  const cleaned = Array.isArray(value) ? value.map(stripEmptyStrings) : value;
  const parsed = draftBlockArraySchema.safeParse(cleaned);
  if (!parsed.success) {
    return fail(
      "validation",
      `Invalid draft_body block(s): ${parsed.error.message}`
    );
  }
  return ok(parsed.data as BlockArray);
}

function validateTitle(value: unknown): PostResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("validation", "title is required");
  }
  return ok(value);
}

function validateExcerpt(value: unknown): PostResult<string> {
  if (typeof value !== "string") {
    return fail("validation", "excerpt must be a string");
  }
  return ok(value);
}

function validateTags(value: unknown): PostResult<string[]> {
  if (
    !Array.isArray(value) ||
    value.some((t) => typeof t !== "string" || t.length === 0)
  ) {
    return fail("validation", "tags must be an array of non-empty strings");
  }
  return ok(value as string[]);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCover(value: unknown): PostResult<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return fail("validation", "cover_media_id must be a uuid or null");
  }
  return ok(value);
}

/**
 * Blogs v1.13: `blog_id` is optional and nullable — `null`/absent means the post
 * belongs to no blog. A provided value must be a uuid; the assignment is a
 * validation failure (→ 400) if it references no existing blog.
 */
function validateBlogId(value: unknown): PostResult<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return fail("validation", "blog_id must be a uuid or null");
  }
  return ok(value);
}

async function assertBlogExists(
  db: Knex,
  blogId: string | null
): Promise<PostResult<null>> {
  if (blogId === null) return ok(null);
  const row = await db(BLOGS).where({ id: blogId }).select("id").first();
  if (!row) return fail("validation", "blog_id references no blog");
  return ok(null);
}

// ---- Media resolution (§6.8) ------------------------------------------------

/** Resolve a single cover media id to an absolute CDN URL, or null. */
async function resolveCover(
  db: Knex,
  coverId: string | null,
  cdnDomain: string
): Promise<MediaRef | null> {
  if (!coverId) return null;
  const row = await db<{ id: string; s3_key: string; alt: string | null }>(
    MEDIA_ASSETS
  )
    .where({ id: coverId })
    .select("s3_key", "alt")
    .first();
  return row
    ? { url: toCdnUrl(cdnDomain, row.s3_key), alt: row.alt ?? null }
    : null;
}

/**
 * Build the `media_id → absolute CDN URL` map for every media reference inside a
 * post body (§6.8). Unknown ids are simply absent — a dangling reference
 * resolves to nothing rather than a broken URL.
 */
async function buildBodyMediaMap(
  db: Knex,
  body: BlockArray,
  cdnDomain: string
): Promise<Record<string, MediaRef>> {
  const ids = new Set<string>();
  collectMediaIds(body, ids);
  if (ids.size === 0) return {};
  const rows = await db<{ id: string; s3_key: string; alt: string | null }>(
    MEDIA_ASSETS
  )
    .whereIn("id", Array.from(ids))
    .select("id", "s3_key", "alt");
  const keyMap: Record<string, string> = {};
  const alts: Record<string, string | null> = {};
  for (const row of rows) {
    keyMap[row.id] = row.s3_key;
    alts[row.id] = row.alt ?? null;
  }
  return resolveMediaMap(cdnDomain, keyMap, alts);
}

// ---- Blog resolution (Blogs v1.13) ------------------------------------------

/** Resolve a single `blog_id` to its `{ slug, name }` reference, or null. */
async function resolveBlog(
  db: Knex,
  blogId: string | null
): Promise<BlogRef | null> {
  if (!blogId) return null;
  const row = await db<{ id: string; slug: string; name: string }>(BLOGS)
    .where({ id: blogId })
    .select("slug", "name")
    .first();
  return row ? { slug: row.slug, name: row.name } : null;
}

/** Batch-resolve a set of `blog_id`s into a `blog_id → {slug,name}` map. */
async function buildBlogMap(
  db: Knex,
  blogIds: (string | null)[]
): Promise<Record<string, BlogRef>> {
  const ids = Array.from(
    new Set(blogIds.filter((v): v is string => !!v))
  );
  if (ids.length === 0) return {};
  const rows = await db<{ id: string; slug: string; name: string }>(BLOGS)
    .whereIn("id", ids)
    .select("id", "slug", "name");
  const map: Record<string, BlogRef> = {};
  for (const r of rows) map[r.id] = { slug: r.slug, name: r.name };
  return map;
}

// ---- Post-ref resolution support (§Post Refs v1.14) -------------------------

/**
 * Every existing `posts.id` — the allowed-ref set for a portfolio item's
 * `post_refs` at publish (§Post Refs v1.14). Membership is EXISTENCE only:
 * unpublished posts are valid refs (they simply resolve to nothing at read), so
 * `published_at` is not consulted here. A ref outside this set is dangling and
 * blocks publish (422).
 */
export async function getAllPostIds(): Promise<Set<string>> {
  const rows = await getDb()<PostRow>(POSTS).select("id");
  return new Set(rows.map((r) => r.id));
}

/** A `post_refs` entry resolved to a currently-published post (§Post Refs v1.14). */
export interface ResolvedPostRef {
  id: string;
  slug: string;
  title: string;
  blog: BlogRef | null;
}

/**
 * Resolve a set of `posts.id`s to their read-time reference shape (§Post Refs
 * v1.14), keyed by id — ONLY currently-published posts (`published_at` not
 * null). Unpublished/deleted ids are simply absent from the map, so the caller's
 * order-preserving lookup silently omits them. One query for the posts, one for
 * their owning blogs.
 */
export async function resolvePublishedPostRefs(
  ids: string[]
): Promise<Map<string, ResolvedPostRef>> {
  const map = new Map<string, ResolvedPostRef>();
  const unique = Array.from(new Set(ids.filter((v) => UUID_RE.test(v))));
  if (unique.length === 0) return map;

  const db = getDb();
  const rows = await db<PostRow>(POSTS)
    .whereIn("id", unique)
    .whereNotNull("published_at")
    .select("id", "slug", "title", "blog_id");
  const blogMap = await buildBlogMap(db, rows.map((r) => r.blog_id));
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      slug: r.slug,
      title: r.title,
      blog: r.blog_id ? blogMap[r.blog_id] ?? null : null,
    });
  }
  return map;
}

// ---- Admin: list (§4.2 GET /api/admin/posts) --------------------------------

export interface AdminPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  cover_media_id: string | null;
  blog_id: string | null;
  /** Owning blog resolved to {slug, name} (Blogs v1.13), or null. */
  blog: BlogRef | null;
  tags: string[];
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * GET /api/admin/posts — every post, drafts included, newest-first. Bodies are
 * omitted from the list (they are fetched one at a time via GET /posts/:id);
 * `published_at = null` marks a never-published draft. Each row carries its
 * `blog_id` and the resolved `blog: {slug, name} | null` (Blogs v1.13).
 */
export async function listAdminPosts(): Promise<AdminPostSummary[]> {
  const db = getDb();
  const rows = await db<PostRow>(POSTS)
    .select(
      "id",
      "slug",
      "title",
      "excerpt",
      "cover_media_id",
      "blog_id",
      "tags",
      "published_at",
      "created_at",
      "updated_at"
    )
    .orderBy("created_at", "desc");
  const blogMap = await buildBlogMap(db, rows.map((r) => r.blog_id));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    cover_media_id: r.cover_media_id,
    blog_id: r.blog_id,
    blog: r.blog_id ? blogMap[r.blog_id] ?? null : null,
    tags: r.tags,
    published_at: r.published_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

// ---- Admin: get one (§4.2 GET /api/admin/posts/:id) -------------------------

/** The admin single-post view — the row plus its resolved `blog` (Blogs v1.13). */
export interface AdminPost extends PostRow {
  blog: BlogRef | null;
}

/** GET /api/admin/posts/:id — one post with `draft_body`, `blog_id`, `blog`. */
export async function getAdminPost(id: string): Promise<PostResult<AdminPost>> {
  if (!UUID_RE.test(id)) return fail("not_found", "post not found");
  const db = getDb();
  const row = await db<PostRow>(POSTS).where({ id }).first();
  if (!row) return fail("not_found", "post not found");
  const blog = await resolveBlog(db, row.blog_id);
  return ok({ ...row, blog });
}

// ---- Admin: create (§4.2 POST /api/admin/posts) -----------------------------

export interface CreatePostInput {
  slug?: unknown;
  title?: unknown;
  excerpt?: unknown;
  cover_media_id?: unknown;
  blog_id?: unknown;
  tags?: unknown;
  draft_body?: unknown;
}

/**
 * POST /api/admin/posts (§4.2). `slug` and `title` are required; `slug` is
 * validated as a URL-safe segment (§3.6). `draft_body`, if supplied, is validated
 * against the block union (§3.7); it defaults to an empty body. A slug already in
 * use is a 409 conflict.
 */
export async function createPost(
  input: CreatePostInput
): Promise<PostResult<PostRow>> {
  const slug = validateSlug(input.slug);
  if (!slug.ok) return slug;
  const title = validateTitle(input.title);
  if (!title.ok) return title;

  const excerpt =
    input.excerpt === undefined ? ok("") : validateExcerpt(input.excerpt);
  if (!excerpt.ok) return excerpt;
  const tags = input.tags === undefined ? ok([]) : validateTags(input.tags);
  if (!tags.ok) return tags;
  const cover = validateCover(input.cover_media_id);
  if (!cover.ok) return cover;
  const blogId = validateBlogId(input.blog_id);
  if (!blogId.ok) return blogId;
  const body =
    input.draft_body === undefined ? ok([]) : validateDraftBody(input.draft_body);
  if (!body.ok) return body;

  const db = getDb();
  // A supplied blog_id must reference an existing blog (Blogs v1.13) → 400.
  const blogExists = await assertBlogExists(db, blogId.data);
  if (!blogExists.ok) return blogExists;

  const existing = await db<PostRow>(POSTS)
    .where({ slug: slug.data })
    .select("id")
    .first();
  if (existing) return fail("conflict", `slug "${slug.data}" is already in use`);

  const [row] = await db<PostRow>(POSTS)
    .insert({
      slug: slug.data,
      title: title.data,
      excerpt: excerpt.data,
      cover_media_id: cover.data,
      blog_id: blogId.data,
      tags: tags.data as never,
      draft_body: JSON.stringify(body.data) as never,
    })
    .returning("*");
  return ok(row);
}

// ---- Admin: update (§4.2 PATCH + §4.5 precondition + §3.6 slug lock) ---------

export interface UpdatePostInput {
  expected_updated_at: string;
  slug?: unknown;
  title?: unknown;
  excerpt?: unknown;
  cover_media_id?: unknown;
  blog_id?: unknown;
  tags?: unknown;
  draft_body?: unknown;
}

/**
 * PATCH /api/admin/posts/:id (§4.2). Updates metadata and/or a wholesale
 * `draft_body` under the required `expected_updated_at` precondition (§4.5): a
 * mismatch is a 409 with no write. `draft_body`, when present, is validated
 * against the block union (§3.7). Slug immutability (§3.6): the slug is freely
 * editable before first publish and any change after publication is a 400; a slug
 * that collides with another post is a 409.
 */
export async function updatePost(
  id: string,
  input: UpdatePostInput
): Promise<PostResult<PostRow>> {
  const has = (k: keyof UpdatePostInput) => input[k] !== undefined;
  if (
    !has("slug") &&
    !has("title") &&
    !has("excerpt") &&
    !has("cover_media_id") &&
    !has("blog_id") &&
    !has("tags") &&
    !has("draft_body")
  ) {
    return fail("bad_request", "Provide at least one field to update");
  }

  if (!UUID_RE.test(id)) return fail("not_found", "post not found");

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<PostRow>(POSTS).where({ id }).forUpdate().first();
    if (!row) return fail<PostRow>("not_found", "post not found");

    if (!timestampsMatch(row.updated_at, input.expected_updated_at)) {
      return fail<PostRow>(
        "conflict",
        "Post changed since it was loaded (expected_updated_at mismatch)"
      );
    }

    const patch: Record<string, unknown> = { updated_at: trx.fn.now() };

    if (has("slug")) {
      const slug = validateSlug(input.slug);
      if (!slug.ok) return slug;
      if (slug.data !== row.slug) {
        // Slug is immutable once the post has been published (§3.6): changing it
        // breaks every inbound link.
        if (row.published_at !== null) {
          return fail<PostRow>(
            "bad_request",
            "slug is immutable after a post is first published"
          );
        }
        const clash = await trx<PostRow>(POSTS)
          .where({ slug: slug.data })
          .whereNot({ id })
          .select("id")
          .first();
        if (clash) {
          return fail<PostRow>("conflict", `slug "${slug.data}" is already in use`);
        }
        patch.slug = slug.data;
      }
    }

    if (has("title")) {
      const title = validateTitle(input.title);
      if (!title.ok) return title;
      patch.title = title.data;
    }
    if (has("excerpt")) {
      const excerpt = validateExcerpt(input.excerpt);
      if (!excerpt.ok) return excerpt;
      patch.excerpt = excerpt.data;
    }
    if (has("tags")) {
      const tags = validateTags(input.tags);
      if (!tags.ok) return tags;
      patch.tags = tags.data as never;
    }
    if (has("cover_media_id")) {
      const cover = validateCover(input.cover_media_id);
      if (!cover.ok) return cover;
      patch.cover_media_id = cover.data;
    }
    if (has("blog_id")) {
      const blogId = validateBlogId(input.blog_id);
      if (!blogId.ok) return blogId;
      const blogExists = await assertBlogExists(trx as unknown as Knex, blogId.data);
      if (!blogExists.ok) return blogExists;
      patch.blog_id = blogId.data;
    }
    if (has("draft_body")) {
      const body = validateDraftBody(input.draft_body);
      if (!body.ok) return body;
      patch.draft_body = JSON.stringify(body.data);
    }

    const [updated] = await trx<PostRow>(POSTS)
      .where({ id })
      .update(patch as never)
      .returning("*");
    return ok(updated);
  });
}

// ---- Admin: delete (§4.2 DELETE /api/admin/posts/:id) -----------------------

export async function deletePost(id: string): Promise<PostResult<null>> {
  if (!UUID_RE.test(id)) return fail("not_found", "post not found");
  const count = await getDb()<PostRow>(POSTS).where({ id }).del();
  if (count === 0) return fail("not_found", "post not found");
  return ok(null);
}

// ---- Admin: publish (§4.2 POST /api/admin/posts/:id/publish) ----------------

/**
 * POST /api/admin/posts/:id/publish (§4.2 / §3.9). Re-validates `draft_body`
 * against the block union and REFUSES to publish if anything fails (400). On
 * success: `published_body := draft_body` and `published_at` is set — the post
 * goes live. Editing the draft afterwards does not affect the published copy
 * until the next publish (§3.6). The media GC pass is triggered by the router
 * after a successful publish.
 */
export async function publishPost(
  id: string,
  publishedAt: string = new Date().toISOString()
): Promise<PostResult<PostRow>> {
  if (!UUID_RE.test(id)) return fail("not_found", "post not found");

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<PostRow>(POSTS).where({ id }).forUpdate().first();
    if (!row) return fail<PostRow>("not_found", "post not found");

    const body = validateBody(row.draft_body);
    if (!body.ok) return body;

    const [updated] = await trx<PostRow>(POSTS)
      .where({ id })
      .update({
        published_body: JSON.stringify(body.data) as never,
        published_at: publishedAt,
        updated_at: trx.fn.now(),
      } as never)
      .returning("*");
    return ok(updated);
  });
}

// ---- Admin: unpublish (§4.2 POST /api/admin/posts/:id/unpublish) -------------

/**
 * POST /api/admin/posts/:id/unpublish (§4.2 / §3.6). Nulls `published_at` so the
 * post is invisible to the public API again, while RETAINING `published_body` —
 * re-publishing later is `published_body := draft_body` once more.
 */
export async function unpublishPost(id: string): Promise<PostResult<PostRow>> {
  if (!UUID_RE.test(id)) return fail("not_found", "post not found");

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<PostRow>(POSTS).where({ id }).forUpdate().first();
    if (!row) return fail<PostRow>("not_found", "post not found");

    const [updated] = await trx<PostRow>(POSTS)
      .where({ id })
      .update({ published_at: null, updated_at: trx.fn.now() } as never)
      .returning("*");
    return ok(updated);
  });
}

// ---- Public: cursor pagination (§4.1 GET /api/posts) ------------------------

interface Cursor {
  publishedAtMs: number;
  id: string;
}

/**
 * The cursor is an opaque base64 of `<published_at_ms>_<id>` — the sort key of
 * the last item on the previous page. It is opaque to the client (§4.1) and
 * self-describing to us: decoding gives the exact keyset boundary for the next
 * page, so pagination is stable even as new posts are published.
 */
function encodeCursor(publishedAt: Date, id: string): string {
  const raw = `${new Date(publishedAt).getTime()}_${id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor | null {
  try {
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const sep = raw.indexOf("_");
    if (sep <= 0) return null;
    const ms = Number(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (!Number.isFinite(ms) || !UUID_RE.test(id)) return null;
    return { publishedAtMs: ms, id };
  } catch {
    return null;
  }
}

export interface ListPublishedInput {
  limit?: unknown;
  tag?: unknown;
  cursor?: unknown;
  /** Blogs v1.13: filter to one blog's posts by slug (composes with tag/cursor). */
  blog?: unknown;
}

export interface ListPublishedResult {
  posts: PostSummary[];
  next_cursor: string | null;
}

/**
 * GET /api/posts (§4.1). Published posts only, newest-first, as SUMMARIES —
 * `slug`, `title`, `excerpt`, `cover` (resolved to a CDN URL), `tags`,
 * `published_at`; never a body. Keyset pagination on `(published_at, id)` desc
 * with `?limit=`, `?tag=`, `?cursor=`. Fetches `limit + 1` rows to know whether a
 * further page exists and, if so, emits `next_cursor`.
 */
export async function listPublishedPosts(
  input: ListPublishedInput,
  cdnDomain: string
): Promise<PostResult<ListPublishedResult>> {
  let limit = DEFAULT_POSTS_LIMIT;
  if (input.limit !== undefined) {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n <= 0) {
      return fail("bad_request", "limit must be a positive integer");
    }
    limit = Math.min(n, MAX_POSTS_LIMIT);
  }

  let cursor: Cursor | null = null;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") {
      return fail("bad_request", "cursor must be a string");
    }
    cursor = decodeCursor(input.cursor);
    if (!cursor) return fail("bad_request", "invalid cursor");
  }

  let tag: string | null = null;
  if (input.tag !== undefined) {
    if (typeof input.tag !== "string" || input.tag.length === 0) {
      return fail("bad_request", "tag must be a non-empty string");
    }
    tag = input.tag;
  }

  const db = getDb();

  // Blogs v1.13: an optional `?blog=<slug>` filter, composing with tag/cursor. An
  // UNKNOWN blog slug is an empty page, not an error — resolve the slug to its id
  // and short-circuit to an empty result when it matches no blog.
  let blogId: string | null = null;
  if (input.blog !== undefined) {
    if (typeof input.blog !== "string" || input.blog.length === 0) {
      return fail("bad_request", "blog must be a non-empty string");
    }
    const blogRow = await db<{ id: string; slug: string }>(BLOGS)
      .where({ slug: input.blog })
      .select("id")
      .first();
    if (!blogRow) return ok({ posts: [], next_cursor: null });
    blogId = blogRow.id;
  }

  const query = db<PostRow>(POSTS)
    .whereNotNull("published_at")
    .orderBy([
      { column: "published_at", order: "desc" },
      { column: "id", order: "desc" },
    ])
    .limit(limit + 1);

  if (tag) {
    query.whereRaw("? = ANY(tags)", [tag]);
  }
  if (blogId) {
    query.where({ blog_id: blogId });
  }
  if (cursor) {
    // Keyset boundary: strictly older than the last item on the previous page.
    const boundary = new Date(cursor.publishedAtMs).toISOString();
    query.whereRaw(
      "(published_at < ? OR (published_at = ? AND id < ?))",
      [boundary, boundary, cursor.id]
    );
  }

  const rows = await query.select(
    "id",
    "slug",
    "title",
    "excerpt",
    "cover_media_id",
    "blog_id",
    "tags",
    "published_at"
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Resolve every cover in one query.
  const coverIds = Array.from(
    new Set(page.map((r) => r.cover_media_id).filter((v): v is string => !!v))
  );
  const coverKeyMap: Record<string, string> = {};
  const coverAlts: Record<string, string | null> = {};
  if (coverIds.length > 0) {
    const coverRows = await db<{ id: string; s3_key: string; alt: string | null }>(
      MEDIA_ASSETS
    )
      .whereIn("id", coverIds)
      .select("id", "s3_key", "alt");
    for (const c of coverRows) {
      coverKeyMap[c.id] = c.s3_key;
      coverAlts[c.id] = c.alt ?? null;
    }
  }

  // Resolve every owning blog in one query (Blogs v1.13).
  const blogMap = await buildBlogMap(db, page.map((r) => r.blog_id));

  const posts: PostSummary[] = page.map((r) => ({
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    cover:
      r.cover_media_id && coverKeyMap[r.cover_media_id]
        ? {
            url: toCdnUrl(cdnDomain, coverKeyMap[r.cover_media_id]),
            alt: coverAlts[r.cover_media_id] ?? null,
          }
        : null,
    tags: r.tags ?? [],
    published_at: new Date(r.published_at as Date).toISOString(),
    blog: r.blog_id ? blogMap[r.blog_id] ?? null : null,
  }));

  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last
      ? encodeCursor(last.published_at as Date, last.id)
      : null;

  return ok({ posts, next_cursor });
}

// ---- Public: one published post (§4.1 GET /api/posts/:slug) -----------------

export interface PublicPostResult {
  post: PublicPost;
  /** The row's `updated_at`, for the router's ETag (§4.1). */
  etagSource: Date;
}

/**
 * GET /api/posts/:slug (§4.1). One PUBLISHED post — `published_body` only, media
 * map resolved to CDN URLs (§6.8), cover resolved. A slug that is unknown OR
 * exists but has never been published (or was unpublished) is a 404: drafts are
 * invisible to the public API (§3.6).
 */
export async function getPublishedPost(
  slug: string,
  cdnDomain: string
): Promise<PostResult<PublicPostResult>> {
  const db = getDb();
  const row = await db<PostRow>(POSTS).where({ slug }).first();
  if (!row || row.published_at === null) {
    return fail("not_found", "post not found");
  }

  const body = (row.published_body ?? []) as BlockArray;
  const [cover, media, blog] = await Promise.all([
    resolveCover(db, row.cover_media_id, cdnDomain),
    buildBodyMediaMap(db, body, cdnDomain),
    resolveBlog(db, row.blog_id),
  ]);

  return ok({
    post: {
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      cover,
      tags: row.tags ?? [],
      published_at: new Date(row.published_at).toISOString(),
      blog,
      body,
      media,
    },
    etagSource: row.updated_at,
  });
}

// ---- Admin/preview: draft body (§4.2 † GET /api/admin/preview/posts/:id) -----

export interface PostPreview {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  cover: MediaRef | null;
  tags: string[];
  published_at: string | null;
  /** Owning blog (Blogs v1.13), or null when the post belongs to no blog. */
  blog: BlogRef | null;
  body: BlockArray;
  media: Record<string, MediaRef>;
}

/**
 * GET /api/admin/preview/posts/:id † (§4.2 / §7). Serializes the DRAFT body with
 * media resolved to CDN URLs, so the public site can render it inside the preview
 * iframe with a preview token. The draft is NOT re-validated here — an author must
 * be able to preview invalid content before publish-time validation refuses it
 * (§3.9).
 */
export async function getDraftPostPreview(
  id: string,
  cdnDomain: string
): Promise<PostResult<PostPreview>> {
  if (!UUID_RE.test(id)) return fail("not_found", "post not found");
  const db = getDb();
  const row = await db<PostRow>(POSTS).where({ id }).first();
  if (!row) return fail("not_found", "post not found");

  const body = (row.draft_body ?? []) as BlockArray;
  const [cover, media, blog] = await Promise.all([
    resolveCover(db, row.cover_media_id, cdnDomain),
    buildBodyMediaMap(db, body, cdnDomain),
    resolveBlog(db, row.blog_id),
  ]);

  return ok({
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    cover,
    tags: row.tags ?? [],
    published_at: row.published_at
      ? new Date(row.published_at).toISOString()
      : null,
    blog,
    body,
    media,
  });
}
