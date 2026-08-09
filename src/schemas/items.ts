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
    links: z.array(linkSchema),
  })
  .strict();

export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type SkillsItem = z.infer<typeof skillsItemSchema>;
export type PortfolioItem = z.infer<typeof portfolioItemSchema>;

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
  portfolio: portfolioItemSchema.partial(),
} as const;
