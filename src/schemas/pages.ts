import { z } from "zod";

/**
 * Page schema — TECH_SPEC_V1.md §3.10 (Pages, v1.1).
 *
 * A page is a first-class piece of content: a URL segment (`slug`), a `title`,
 * optional navigation metadata (`nav_label` / `nav_position`), and a hidden
 * flag. Its `sections` live in the `sections` table keyed by `page_id`; this
 * schema validates the page row itself, not its sections.
 *
 * Like every other content schema (§3.9) it does triple duty — admin-write
 * validation (draft-lenient), admin form generation, and publish-time
 * validation (canonical) — so the same rules apply everywhere.
 */

/**
 * Slugs reserved from create/rename (§3.10): `api` and `admin`, defensively.
 * `home` is NOT reserved — it is the special slug that renders at `/`.
 *
 * `blog` is NOT reserved as of task #101 (Blog-as-a-page): the blog index now
 * lives inside a normal admin-composed page whose slug is `blog` (a `blog`
 * section in `mode: 'index'`), so the site keeps its `/blog` URL and post URLs
 * `/blog/:slug` unchanged while the blog inherits its nav placement from the
 * regular pages ordering.
 */
export const RESERVED_PAGE_SLUGS = ["api", "admin"] as const;

export type ReservedPageSlug = (typeof RESERVED_PAGE_SLUGS)[number];

/**
 * URL segment for a page (§3.10): lowercase `[a-z0-9-]+`, unique (enforced by
 * the `pages.slug` UNIQUE constraint), and never one of the reserved slugs.
 */
export const pageSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+$/,
    "page slug must be lowercase letters, digits, and hyphens"
  )
  .refine(
    (slug) => !(RESERVED_PAGE_SLUGS as readonly string[]).includes(slug),
    { message: "slug is reserved" }
  );

/**
 * Canonical page schema — enforced at publish (§3.9). A page in the nav has a
 * non-null `nav_label`; a `null` label means "served at its slug but absent from
 * the nav" (§3.10). `.strict()` rejects unknown keys so the row can never hold
 * garbage.
 */
export const pageSchema = z
  .object({
    slug: pageSlugSchema,
    title: z.string().min(1),
    nav_label: z.string().min(1).nullable().optional(),
    nav_position: z.number().int(),
    is_hidden: z.boolean(),
  })
  .strict();

/**
 * Draft-lenient variant (§3.9: "Invalid content can reach a draft; it can never
 * reach production") — the shape admin WRITES validate against. Every provided
 * field must still be well-typed (a bad slug is rejected even in a draft) and
 * unknown keys are still rejected via `.strict()`, but nothing is required so
 * the admin's create-empty-then-edit flow works. Publish validates `pageSchema`
 * above and is the gate that enforces completeness — mirrors
 * `DRAFT_SECTION_DATA_SCHEMAS`.
 */
export const draftPageSchema = pageSchema.partial();

export type Page = z.infer<typeof pageSchema>;
export type DraftPage = z.infer<typeof draftPageSchema>;
