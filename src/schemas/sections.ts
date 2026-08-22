import { z } from "zod";
import { linkSchema } from "./link";

/**
 * Per-section-type `data` schemas, TECH_SPEC_V1.md §3.4 (registry), §3.5 (live
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
  "resume",
  "contact",
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

// Static content sections -------------------------------------------------

/**
 * Hero background media presentation controls. Every key is optional; when
 * absent the site renderer applies its own default (documented alongside each
 * field on the hero background docs) so an existing hero with only
 * `background_media_id` keeps looking exactly as it did before this shape
 * landed. Numbers are `z.coerce.number()` so numeric-string values from a
 * lenient admin form still parse, while the draft path strips `""` first so a
 * cleared field becomes absent (not `0`) via `stripEmptyStrings`. `.strict()`
 * rejects unknown keys so a typo cannot silently persist.
 *
 * `object_position` is a free CSS `object-position` string (e.g. `50% 30%`,
 * `center top`); capped at 40 chars and constrained to a small character set
 * that covers every keyword and percentage/length form without allowing an
 * XSS-shaped value into inline styles.
 */
const OBJECT_POSITION_REGEX = /^[a-zA-Z0-9 %.-]{1,40}$/;

export const heroBackground = z
  .object({
    opacity_dark: z.coerce.number().min(0).max(1).optional(),
    opacity_light: z.coerce.number().min(0).max(1).optional(),
    object_fit: z
      .enum(["cover", "contain", "fill", "none", "scale-down"])
      .optional(),
    object_position: z
      .string()
      .max(40)
      .regex(OBJECT_POSITION_REGEX)
      .optional(),
    blur_px: z.coerce.number().min(0).max(40).optional(),
    grayscale: z.coerce.number().min(0).max(1).optional(),
    brightness: z.coerce.number().min(0).max(2).optional(),
    contrast: z.coerce.number().min(0).max(2).optional(),
    saturate: z.coerce.number().min(0).max(2).optional(),
    scale: z.coerce.number().min(1).max(2).optional(),
    overlay_dark: z.coerce.number().min(0).max(1).optional(),
    overlay_light: z.coerce.number().min(0).max(1).optional(),
  })
  .strict();

export type HeroBackground = z.infer<typeof heroBackground>;

/**
 * §3.8, retained as a static section: title, tagline, optional background
 * media reference plus the optional `background` presentation controls above.
 *
 * Per-theme backdrops, each optional and independent: `background_media_id`
 * renders on the dark theme only, `background_light_media_id` on the light
 * theme only. Either may be absent (that theme then has no backdrop); the same
 * id in both gives a shared image. Both names end in `media_id`, so the publish
 * media map and media delete-protection (`collectMediaRefs`) pick them up with
 * no further plumbing.
 *
 * Product rule (task #106): NO section requires a heading. `title` here is the
 * hero's header-copy field, so it is `.optional()`, a hero with no title is a
 * valid section and simply renders without one. `min(1)` is retained so a
 * PRESENT-but-empty string is still rejected; absent is how the field is
 * omitted (the draft path strips `""` before validation for the same reason).
 */
export const heroData = z
  .object({
    title: z.string().min(1).optional(),
    tagline: z.string().optional(),
    background_media_id: z.string().uuid().optional(),
    background_light_media_id: z.string().uuid().optional(),
    background: heroBackground.optional(),
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
 * §3.4 (v1.5 Skills Sphere), the skills section renders its items on a 3D
 * geodesic sphere (three.js `IcosahedronGeometry`). Besides the shared
 * heading/intro, it carries an optional `sphere_detail`: the icosahedron detail
 * parameter (0-4), where the face count is 20·(detail+1)² (0→20, 1→80, 2→180,
 * 3→320, 4→500). It is `.optional()`, NOT `.default()`: absent means AUTO, the
 * renderer picks the smallest detail whose face count ≥ the number of skill
 * items (clamped to 4), and absent must round-trip as absent.
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

// Live sections, config only; data fetched at runtime (§3.5) ------------

/** §3.5, which services to show, whether to show response times. */
export const statusData = z
  .object({
    services: z.array(z.string().min(1)),
    show_response_times: z.boolean().optional(),
  })
  .strict();

/**
 * §3.5, the blog section, in two modes (Blog-as-a-page, task #101):
 *
 * - `mode: 'teaser'` (DEFAULT) is the recent-posts card, pick the newest N
 *   posts (optionally scoped by `tag` and/or `blog`) and render them inline.
 *   `limit` is the teaser's N.
 * - `mode: 'index'` renders the full paginated blog index (same blog/tag
 *   filtering) inline, so the blog listing can live inside a normal admin-
 *   composed page and inherit its `nav_position`, no hardcoded /blog nav
 *   link. `page_size` is the index's per-page count.
 *
 * `mode` defaults to `'teaser'` so every section stored before this task (which
 * has no `mode` key) is untouched on both the draft and publish paths (§3.9).
 *
 * `blog` scopes to one named blog (Blogs v1.13); it is a plain string here.
 * Draft-lenient accepts ANY string; publish-time validation
 * (`publishService.validateWorkingSet`) is what refuses a slug that matches no
 * existing blog, as a `ref_validation` → 422 naming the section.
 */
export const blogData = z
  .object({
    mode: z.enum(["teaser", "index"]).default("teaser"),
    limit: z.number().int().positive().optional(),
    tag: z.string().min(1).optional(),
    blog: z.string().min(1).optional(),
    page_size: z.number().int().positive().optional(),
  })
  .strict();

/** §3.5, idle behavior (`hide` | `message`), whether to show album art. */
export const nowPlayingData = z
  .object({
    idle: z.enum(["hide", "message"]),
    idle_message: z.string().optional(),
    show_album_art: z.boolean().optional(),
  })
  .strict();

/**
 * §3.5 (v1.2 live section), the Duolingo streak/course card. Config only; the
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
 * §3.5 (v1.10 GitHub Explorer), the GitHub contribution-graph card. Config
 * only; the live data (the contribution calendar) is fetched at runtime from
 * `GET /api/github[?year=YYYY]`. As of v1.10 the section is fully browsable , 
 * the client always renders the full returned window and offers a year picker , 
 * so the v1.2 `weeks` config (how many trailing weeks to render) is REMOVED;
 * only the header copy (`heading` / `intro`) is snapshotted. The end state
 * mirrors `opsData`: `{ heading?, intro? }`.
 */
export const githubData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
  })
  .strict();

/**
 * §3.5 (v1.7 Ops Replay), the ops / CloudWatch metrics card. Config only; the
 * live data is the immutable DAILY REPLAY report fetched at runtime from
 * `GET /api/ops` (one report per UTC day, replayed client-side). As of the v1.7
 * replay rework the lookback is no longer configurable, a report always covers
 * one full UTC day, so `window_hours` is REMOVED; only the header copy
 * (`heading` / `intro`) is snapshotted. NO infra identifiers (dashboard name,
 * resource names, ARNs) live in this config, the dashboard name is a deployed
 * secret, resolved server-side (§4.7-style) and never in content.
 */
export const opsData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
  })
  .strict();

/**
 * §3.5 (Resume Versions, task #92), the resume card. Config only; the live
 * data is the newest confirmed resume PDF fetched at runtime from
 * `GET /api/resume`. The section has NO items, a resume replaces itself,
 * versioning happens on the row, not as a list, so the shape mirrors the
 * other intro-only live sections (`opsData`, `githubData`): `{ heading?, intro? }`.
 */
export const resumeData = z
  .object({
    heading: z.string().optional(),
    intro: z.string().optional(),
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
  resume: resumeData,
  contact: contactData,
} satisfies Record<SectionType, z.ZodTypeAny>;

/**
 * Draft-lenient variants (§3.9: "Invalid content can reach a draft; it can
 * never reach production"). Admin WRITES validate against these, every
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
  resume: resumeData.partial(),
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
export type ResumeData = z.infer<typeof resumeData>;
export type ContactData = z.infer<typeof contactData>;
