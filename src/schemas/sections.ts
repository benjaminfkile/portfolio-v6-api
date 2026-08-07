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
  "duolingo",
  "github",
  "ops",
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
 * (`timeline`/`portfolio`) carry only an optional section-level heading/intro in
 * their own `data`.
 */
const itemSectionData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
  })
  .strict();

export const timelineData = itemSectionData;
export const portfolioData = itemSectionData;

/**
 * §3.4 (v1.5 Skills Sphere) — the skills section renders its items on a 3D
 * geodesic sphere (three.js `IcosahedronGeometry`). Besides the shared
 * heading/intro, it carries an optional `sphere_detail`: the icosahedron detail
 * parameter (0–4), where the face count is 20·(detail+1)² (0→20, 1→80, 2→180,
 * 3→320, 4→500). It is `.optional()`, NOT `.default()`: absent means AUTO — the
 * renderer picks the smallest detail whose face count ≥ the number of skill
 * items (clamped to 4) — and absent must round-trip as absent.
 */
export const skillsData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
    sphere_detail: z.number().int().min(0).max(4).optional(),
  })
  .strict();

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

/**
 * §3.5 (v1.2 live section) — the Duolingo streak/course card. Config only; the
 * live data is fetched at runtime from `GET /api/duolingo`. `language` is a
 * lowercase Duolingo course code (its `learningLanguage`, e.g. `es`, `fr`,
 * `zs`); the runtime picks the matching course out of the account's courses.
 */
export const LANGUAGE_CODE_REGEX = /^[a-z-]{2,8}$/;

export const duolingoData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
    language: z.string().regex(LANGUAGE_CODE_REGEX).default("es"),
    score_label: z.string().optional(),
  })
  .strict();

/**
 * §3.5 (v1.2 live section) — the GitHub contribution-graph card. Config only;
 * the live data (the contribution calendar) is fetched at runtime from
 * `GET /api/github`. `weeks` is how many trailing weeks of the calendar the
 * component renders (1..53; a GitHub year is ~53 weeks), defaulting to a full
 * year (52). An optional `heading` labels the section.
 */
export const githubData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
    weeks: z.number().int().min(1).max(53).default(52),
  })
  .strict();

/**
 * §3.5 (v1.3 live section) — the ops / CloudWatch metrics card. Config only; the
 * live data (the curated dashboard widgets) is fetched at runtime from
 * `GET /api/ops`. `window_hours` is how many trailing hours of metrics the
 * endpoint queries (1..24; period is a fixed 5-minute grain), defaulting to 3.
 * An optional `heading` labels the section. NO infra identifiers (dashboard
 * name, resource names, ARNs) live in this config — the dashboard name is a
 * deployed secret, resolved server-side (§4.7-style) and never in content.
 */
export const opsData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
    window_hours: z.number().int().min(1).max(24).default(3),
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
  duolingo: duolingoData,
  github: githubData,
  ops: opsData,
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
  duolingo: duolingoData.partial(),
  github: githubData.partial(),
  ops: opsData.partial(),
  contact: contactData.partial(),
};

export type HeroData = z.infer<typeof heroData>;
export type AboutData = z.infer<typeof aboutData>;
export type StatusData = z.infer<typeof statusData>;
export type BlogData = z.infer<typeof blogData>;
export type NowPlayingData = z.infer<typeof nowPlayingData>;
export type DuolingoData = z.infer<typeof duolingoData>;
export type GithubData = z.infer<typeof githubData>;
export type OpsData = z.infer<typeof opsData>;
export type ContactData = z.infer<typeof contactData>;
