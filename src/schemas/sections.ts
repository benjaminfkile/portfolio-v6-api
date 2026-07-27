import { z } from "zod";
import { linkSchema } from "./link";

/**
 * Per-section-type `data` schemas — TECH_SPEC_V1.md §3.4 (registry), §3.5 (live
 * sections), §3.8 (hero). `sections.type` is a string in the database and a
 * discriminated union in TypeScript; every type in the registry has a schema
 * for its `data` blob so the JSONB column cannot accept arbitrary garbage
 * (§3.9). The repeatable children of `timeline`/`skills`/`portfolio` live in
 * `section_items` and are validated by `./items.ts`.
 */

export const SECTION_TYPES = [
  "hero",
  "about",
  "timeline",
  "skills",
  "portfolio",
  "status",
  "blog",
  "now_playing",
  "contact",
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

// Static content sections -------------------------------------------------

/** §3.8 — retained as a static section: title, tagline, optional background. */
export const heroData = z
  .object({
    title: z.string().min(1),
    tagline: z.string().optional(),
    background_media_id: z.string().uuid().optional(),
  })
  .strict();

export const aboutData = z
  .object({
    heading: z.string().optional(),
    // Constrained inline markdown; raw HTML is never stored (§3.7 conventions).
    body: z.string().default(""),
  })
  .strict();

/**
 * Sections whose content lives entirely in `section_items`
 * (`timeline`/`skills`/`portfolio`) carry only an optional section-level
 * heading/intro in their own `data`.
 */
const itemSectionData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
  })
  .strict();

export const timelineData = itemSectionData;
export const skillsData = itemSectionData;
export const portfolioData = itemSectionData;

export const contactData = z
  .object({
    heading: z.string().optional(),
    body: z.string().optional(),
    links: z.array(linkSchema).optional(),
  })
  .strict();

// Live sections — config only; data fetched at runtime (§3.5) ------------

/** §3.5 — which services to show, whether to show response times. */
export const statusData = z
  .object({
    services: z.array(z.string().min(1)),
    show_response_times: z.boolean().optional(),
  })
  .strict();

/** §3.5 — how many posts, optional tag filter. */
export const blogData = z
  .object({
    limit: z.number().int().positive(),
    tag: z.string().min(1).optional(),
  })
  .strict();

/** §3.5 — idle behavior (`hide` | `message`), whether to show album art. */
export const nowPlayingData = z
  .object({
    idle: z.enum(["hide", "message"]),
    idle_message: z.string().optional(),
    show_album_art: z.boolean().optional(),
  })
  .strict();

/** Section-type → `data` schema. Every registry type (§3.4) is covered. */
export const SECTION_DATA_SCHEMAS = {
  hero: heroData,
  about: aboutData,
  timeline: timelineData,
  skills: skillsData,
  portfolio: portfolioData,
  status: statusData,
  blog: blogData,
  now_playing: nowPlayingData,
  contact: contactData,
} satisfies Record<SectionType, z.ZodTypeAny>;

/**
 * Draft-lenient variants (§3.9: "Invalid content can reach a draft; it can
 * never reach production"). Admin WRITES validate against these — every
 * provided field must be well-typed (and unknown keys are still rejected via
 * .strict()), but nothing is required, so the admin's create-empty-then-edit
 * flow works. Publish validates the canonical schemas above and is the gate
 * that enforces completeness.
 */
export const DRAFT_SECTION_DATA_SCHEMAS: Record<SectionType, z.ZodTypeAny> = {
  hero: heroData.partial(),
  about: aboutData.partial(),
  timeline: timelineData.partial(),
  skills: skillsData.partial(),
  portfolio: portfolioData.partial(),
  status: statusData.partial(),
  blog: blogData.partial(),
  now_playing: nowPlayingData.partial(),
  contact: contactData.partial(),
};

export type HeroData = z.infer<typeof heroData>;
export type AboutData = z.infer<typeof aboutData>;
export type StatusData = z.infer<typeof statusData>;
export type BlogData = z.infer<typeof blogData>;
export type NowPlayingData = z.infer<typeof nowPlayingData>;
export type ContactData = z.infer<typeof contactData>;
