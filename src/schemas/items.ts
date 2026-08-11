import { z } from "zod";
import { linkSchema } from "./link";

/**
 * Section item schemas — the item shapes of TECH_SPEC_V1.md §3.4's table.
 *
 * Only the three section types with repeatable children have item schemas:
 * `timeline`, `skills`, `portfolio`. Sections without repeatable content (hero,
 * about, contact, and the live sections) have zero rows in `section_items` and
 * therefore no item schema.
 */

export const timelineItemSchema = z
  .object({
    date_range: z.string().min(1),
    title: z.string().min(1),
    description: z.string().default(""),
    media_id: z.string().uuid().optional(),
  })
  .strict();

export const skillsItemSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().default(""),
    // Default (light-theme) icon URL — required. Source-agnostic plain URL
    // string (devicon, simpleicons, custom, self-hosted); see §Icons v1.6.
    icon_source: z.string().min(1),
    // OPTIONAL dark-theme override URL (§Icons v1.6). Every renderer falls back
    // to `icon_source` when it is absent, so absent must round-trip as absent.
    icon_source_dark: z.string().min(1).optional(),
  })
  .strict();

/**
 * A related-post reference resolved onto a portfolio item at READ time (§Post
 * Refs v1.14). The stored document only ever holds the raw `post_refs` uuid
 * array; `GET /api/content` and the admin preview resolve each ref to a
 * currently-published post and serialize it here — `{ id, slug, title, blog }`,
 * with `blog` the owning blog `{slug, name}` or `null`. Surfaced in the schema so
 * `sync:types` generates the `PostRef` type once (§8.4).
 */
export const postRefSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    // The owning blog `{slug, name}` or `null`. Structurally identical to
    // `blogRefSchema`, but a distinct instance so the derived JSON Schema keeps
    // both this and the root `blog` reference inlined (§8.4).
    blog: z
      .object({ slug: z.string(), name: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * Ordered references to `posts.id` uuids (§Post Refs v1.14): the "related posts"
 * a portfolio project links to. Max 12, no duplicates, render order = array
 * order. Empty/absent is allowed. Publish validates each ref exists in the
 * `posts` table (a dangling ref → 422); refs to UNPUBLISHED posts are valid at
 * publish and simply resolve to nothing at read.
 */
export const postRefsSchema = z
  .array(z.string().uuid())
  .max(12, "at most 12 post_refs are allowed")
  .refine((refs) => new Set(refs).size === refs.length, {
    message: "post_refs must not contain duplicate ids",
  });

export const portfolioItemSchema = z
  .object({
    title: z.string().min(1),
    intro: z.string().default(""),
    description: z.string().default(""),
    media_id: z.string().uuid(),
    playback_rate: z.number().positive().optional(),
    transform_value: z.string().optional(),
    // Ordered references to skills `section_items.id` uuids (§Skill Refs v1.8).
    // Render order = array order. Replaces the legacy `tech_icons` URL list so
    // portfolio icons are enforced-by-construction to match the skills sphere.
    // Empty array allowed; publish validates each ref resolves to a non-hidden
    // skills item of a non-hidden skills section.
    skill_refs: z.array(z.string().uuid()),
    // Ordered references to `posts.id` uuids (§Post Refs v1.14) — the related
    // published posts this project links to. Optional; canonical rules (uuid,
    // max 12, no duplicates) enforced at publish, existence validated there too.
    post_refs: postRefsSchema.optional(),
    links: z.array(linkSchema),
    // READ-time resolution of `post_refs` (§Post Refs v1.14). Never written by a
    // client and never stored in a document — `GET /api/content` / preview inject
    // it, resolving each ref to a currently-published post in author order.
    // Optional so publish (which parses stored, id-only data) round-trips cleanly.
    posts: z.array(postRefSchema).optional(),
  })
  .strict();

export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type SkillsItem = z.infer<typeof skillsItemSchema>;
export type PortfolioItem = z.infer<typeof portfolioItemSchema>;
export type PostRef = z.infer<typeof postRefSchema>;

/**
 * Item schema keyed by the owning section type. Section types absent from this
 * map do not have items (§3.4).
 */
export const ITEM_SCHEMAS = {
  timeline: timelineItemSchema,
  skills: skillsItemSchema,
  portfolio: portfolioItemSchema,
} as const;

export type ItemBearingSectionType = keyof typeof ITEM_SCHEMAS;

/**
 * Draft-lenient item variants (§3.9): provided fields must be well-typed
 * (unknown keys still rejected), nothing required. Publish enforces the
 * canonical schemas above.
 */
export const DRAFT_ITEM_SCHEMAS = {
  timeline: timelineItemSchema.partial(),
  skills: skillsItemSchema.partial(),
  // Draft-lenient portfolio (§3.9 / §Post Refs v1.14): every canonical field is
  // optional, but `post_refs` is relaxed to a bare string array — a half-built
  // draft may hold not-yet-valid ids without blocking the save. Publish re-parses
  // against the canonical `post_refs` (uuid, max 12, no duplicates).
  portfolio: portfolioItemSchema.partial().extend({
    post_refs: z.array(z.string()).optional(),
  }),
} as const;
