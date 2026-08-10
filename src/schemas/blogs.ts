import { z } from "zod";

/**
 * Blog schema — Blogs v1.13.
 *
 * A blog is a named grouping a post can belong to ("Code", "Food",
 * "Motorcycle"): a URL-safe `slug` and a display `name`. Unlike a page slug a
 * blog slug is NEVER a route (blogs only scope the post index via `?blog=`), so
 * there is no reserved-slug list — only the shared lowercase-kebab format rule.
 *
 * `blogRefSchema` is the read-time reference shape a public post/summary carries
 * (`blog: {slug, name} | null`); it surfaces through `GET /api/schema` so the
 * frontends' `sync:types` generates the `Blog` type once (§8.4).
 */

/**
 * URL segment for a blog (Blogs v1.13): lowercase `[a-z0-9-]+`, unique (enforced
 * by the `blogs.slug` UNIQUE constraint). No reserved list — a blog slug never
 * becomes a route.
 */
export const blogSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+$/,
    "blog slug must be lowercase letters, digits, and hyphens"
  );

/** Canonical blog row: a valid slug + a non-empty name. `.strict()` rejects junk. */
export const blogSchema = z
  .object({
    slug: blogSlugSchema,
    name: z.string().min(1),
  })
  .strict();

/**
 * The resolved blog reference a public post summary / post carries (Blogs v1.13):
 * `{ slug, name }`, or `null` for a post that belongs to no blog. Surfaced in the
 * schema so a `Blog` type is generated for the frontends (§8.4).
 */
export const blogRefSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
  })
  .strict();

export type Blog = z.infer<typeof blogSchema>;
export type BlogRef = z.infer<typeof blogRefSchema>;
