import { z } from "zod";
import { blockArraySchema } from "./blocks";

/**
 * Post metadata schema — TECH_SPEC_V1.md §3.6.
 *
 * The editable, non-body fields of a `posts` row. The body itself is a
 * `Block[]` validated by `./blocks.ts` (`blockArraySchema`); `postSchema` below
 * composes the two. `published_body`/`published_at` are lifecycle-managed by the
 * publish pipeline (task 439/441), not client-supplied, so they are not part of
 * the write schema.
 */

/**
 * URL segment. Immutable once published (§3.6); the admin enforces that rule at
 * the route level. The format is a lowercase kebab slug so it is a safe path
 * component.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "slug must be lowercase alphanumeric words separated by single hyphens"
  );

export const postMetadataSchema = z
  .object({
    slug: slugSchema,
    title: z.string().min(1),
    excerpt: z.string().default(""),
    cover_media_id: z.string().uuid().nullable().optional(),
    // Blogs v1.13: the owning blog, by id. Nullable/optional — a post may belong
    // to no blog. The resolved `blog: {slug, name} | null` is a read-time shape
    // (see `blogRefSchema`), not a write field.
    blog_id: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** Full editable post payload: metadata plus the draft block body (§3.6/§3.7). */
export const postSchema = postMetadataSchema.extend({
  draft_body: blockArraySchema.default([]),
});

export type PostMetadata = z.infer<typeof postMetadataSchema>;
export type Post = z.infer<typeof postSchema>;
