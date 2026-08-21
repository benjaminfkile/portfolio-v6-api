import {
  linkSchema,
  ALLOWED_LINK_PROTOCOLS,
  blockSchema,
  blockArraySchema,
  CODE_LANGUAGES,
  isSupportedLanguage,
  timelineItemSchema,
  skillsItemSchema,
  portfolioItemSchema,
  postRefSchema,
  DRAFT_ITEM_SCHEMAS,
  heroData,
  heroBackground,
  statusData,
  blogData,
  nowPlayingData,
  contactData,
  skillsData,
  duolingoData,
  githubData,
  opsData,
  resumeData,
  SECTION_DATA_SCHEMAS,
  DRAFT_SECTION_DATA_SCHEMAS,
  SECTION_TYPES,
  postMetadataSchema,
  postSchema,
  slugSchema,
  pageSlugSchema,
  pageSchema,
  draftPageSchema,
  RESERVED_PAGE_SLUGS,
} from "../src/schemas";
import { stripEmptyStrings } from "../src/utils/draftData";

describe("Link schema (§3.4), protocol allowlist", () => {
  it("accepts http and https URLs with a required label", () => {
    expect(
      linkSchema.safeParse({
        type: "repo",
        label: "portfolio-v6-api",
        url: "https://github.com/x/y",
      }).success
    ).toBe(true);
    expect(
      linkSchema.safeParse({
        type: "prod",
        label: "Live site",
        url: "http://example.com",
      }).success
    ).toBe(true);
  });

  it("rejects javascript: URLs (stored-XSS vector)", () => {
    const res = linkSchema.safeParse({
      type: "other",
      label: "evil",
      url: "javascript:alert(document.cookie)",
    });
    expect(res.success).toBe(false);
  });

  it.each(["data:text/html,x", "file:///etc/passwd", "ftp://host/f"])(
    "rejects the non-allowlisted protocol %s",
    (url) => {
      expect(
        linkSchema.safeParse({ type: "other", label: "l", url }).success
      ).toBe(false);
    }
  );

  it("accepts mailto: URLs (contact-section email links)", () => {
    expect(
      linkSchema.safeParse({
        type: "other",
        label: "Email",
        url: "mailto:someone@example.com",
      }).success
    ).toBe(true);
  });

  it("accepts tel: URLs (contact-section phone links)", () => {
    expect(
      linkSchema.safeParse({
        type: "other",
        label: "Phone",
        url: "tel:+14065551234",
      }).success
    ).toBe(true);
  });

  it("accepts uppercase MAILTO: (URL parser normalizes the scheme to lower-case)", () => {
    expect(
      linkSchema.safeParse({
        type: "other",
        label: "Email",
        url: "MAILTO:someone@example.com",
      }).success
    ).toBe(true);
  });

  it("rejects a bare email address (no scheme), must be a real URL", () => {
    expect(
      linkSchema.safeParse({
        type: "other",
        label: "Email",
        url: "someone@example.com",
      }).success
    ).toBe(false);
  });

  it("surfaces the widened allowlist as the validation error message", () => {
    const res = linkSchema.safeParse({
      type: "other",
      label: "x",
      url: "javascript:alert(1)",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) =>
          i.message.includes("http, https, mailto, or tel")
        )
      ).toBe(true);
    }
  });

  it("only allows http:, https:, mailto:, and tel: protocols", () => {
    expect([...ALLOWED_LINK_PROTOCOLS]).toEqual([
      "http:",
      "https:",
      "mailto:",
      "tel:",
    ]);
  });

  it("requires a non-empty label (never derived from type)", () => {
    expect(
      linkSchema.safeParse({ type: "repo", label: "", url: "https://a.com" })
        .success
    ).toBe(false);
    expect(
      linkSchema.safeParse({ type: "repo", url: "https://a.com" }).success
    ).toBe(false);
  });

  it("rejects an unknown link type", () => {
    expect(
      linkSchema.safeParse({
        type: "wormhole",
        label: "l",
        url: "https://a.com",
      }).success
    ).toBe(false);
  });
});

describe("Block discriminated union (§3.7)", () => {
  const valid = [
    { type: "heading", level: 2, text: "Title" },
    { type: "paragraph", text: "Some **bold** prose" },
    { type: "code", language: "typescript", code: "const x = 1;" },
    { type: "code", language: "typescript", code: "x", filename: "src/app.ts" },
    {
      type: "media",
      media_id: "11111111-1111-1111-1111-111111111111",
      caption: "a photo",
    },
    { type: "list", ordered: true, items: ["a", "b"] },
    { type: "quote", text: "words", attribution: "someone" },
    {
      type: "links",
      links: [{ type: "docs", label: "Docs", url: "https://d.com" }],
    },
    { type: "divider" },
  ];

  it.each(valid)("accepts a valid %# block", (block) => {
    expect(blockSchema.safeParse(block).success).toBe(true);
  });

  it("covers all eight block types", () => {
    const types = new Set(valid.map((b) => b.type));
    expect(types).toEqual(
      new Set([
        "heading",
        "paragraph",
        "code",
        "media",
        "list",
        "quote",
        "links",
        "divider",
      ])
    );
  });

  it("rejects an unknown block type", () => {
    expect(blockSchema.safeParse({ type: "carousel" }).success).toBe(false);
  });

  it("rejects a heading with an out-of-range level", () => {
    expect(
      blockSchema.safeParse({ type: "heading", level: 1, text: "x" }).success
    ).toBe(false);
  });

  it("rejects a links block containing a javascript: URL", () => {
    expect(
      blockSchema.safeParse({
        type: "links",
        links: [{ type: "other", label: "x", url: "javascript:alert(1)" }],
      }).success
    ).toBe(false);
  });

  it("rejects a whole body that contains a single invalid block", () => {
    const body = [
      { type: "heading", level: 3, text: "ok" },
      { type: "paragraph", text: "still ok" },
      { type: "bogus", data: 1 },
    ];
    const res = blockArraySchema.safeParse(body);
    expect(res.success).toBe(false);
  });

  it("accepts a valid multi-block body", () => {
    const body = [
      { type: "heading", level: 2, text: "Intro" },
      { type: "paragraph", text: "hi" },
      { type: "divider" },
    ];
    expect(blockArraySchema.safeParse(body).success).toBe(true);
  });
});

describe("code block language allowlist (§3.7 pass-through)", () => {
  it("exports the allowlist and flags membership", () => {
    expect(CODE_LANGUAGES).toContain("typescript");
    expect(isSupportedLanguage("typescript")).toBe(true);
    expect(isSupportedLanguage("brainfuck")).toBe(false);
  });

  it("accepts an unknown language at the validation level (renders as plain text)", () => {
    // Pass-through: unknown language must NOT fail validation.
    expect(
      blockSchema.safeParse({
        type: "code",
        language: "brainfuck",
        code: "+[.]",
      }).success
    ).toBe(true);
  });

  it("still requires a non-empty language string", () => {
    expect(
      blockSchema.safeParse({ type: "code", language: "", code: "x" }).success
    ).toBe(false);
  });
});

describe("section item schemas (§3.4 table)", () => {
  it("timeline item, valid and invalid", () => {
    expect(
      timelineItemSchema.safeParse({
        date_range: "2020-2022",
        title: "Role",
        description: "did things",
      }).success
    ).toBe(true);
    // missing required title
    expect(
      timelineItemSchema.safeParse({
        date_range: "2020",
        description: "x",
      }).success
    ).toBe(false);
  });

  it("timeline item, media_id was removed; the strict schema rejects it (create + PATCH)", () => {
    // Timeline entries no longer carry an image. The canonical strict schema
    // rejects an unknown `media_id` key with a validation error…
    const create = timelineItemSchema.safeParse({
      date_range: "2020",
      title: "Role",
      description: "did things",
      media_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(create.success).toBe(false);

    // …and the draft-lenient `.partial()` variant used by PATCH is ALSO strict
    // on unknown keys, so a partial update trying to set `media_id` is rejected.
    const patch = DRAFT_ITEM_SCHEMAS.timeline.safeParse({
      media_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(patch.success).toBe(false);
  });

  it("skills item, valid without proficiency; rejects a leftover proficiency key (strict, v1.5)", () => {
    expect(
      skillsItemSchema.safeParse({
        title: "TypeScript",
        description: "strong",
        icon_source: "devicon:typescript",
      }).success
    ).toBe(true);
    // proficiency was removed from the product, a strict schema rejects it.
    expect(
      skillsItemSchema.safeParse({
        title: "TypeScript",
        description: "strong",
        icon_source: "devicon:typescript",
        proficiency: 90,
      }).success
    ).toBe(false);
    // icon_source is required (min 1).
    expect(
      skillsItemSchema.safeParse({
        title: "TypeScript",
        icon_source: "",
      }).success
    ).toBe(false);
  });

  it("skills item, optional icon_source_dark; absent round-trips as absent (v1.6)", () => {
    // A dark-theme override is accepted alongside the required light icon.
    const withDark = skillsItemSchema.safeParse({
      title: "TypeScript",
      icon_source: "https://cdn/ts-original.svg",
      icon_source_dark: "https://cdn/ts-plain.svg",
    });
    expect(withDark.success).toBe(true);
    if (withDark.success) {
      expect(withDark.data.icon_source_dark).toBe("https://cdn/ts-plain.svg");
    }

    // Absent is valid and must NOT materialize a key, renderers fall back to
    // icon_source only when the override is truly absent.
    const noDark = skillsItemSchema.safeParse({
      title: "TypeScript",
      icon_source: "https://cdn/ts-original.svg",
    });
    expect(noDark.success).toBe(true);
    if (noDark.success) {
      expect("icon_source_dark" in noDark.data).toBe(false);
      expect(noDark.data.icon_source_dark).toBeUndefined();
    }

    // Present-but-empty is rejected (min 1), same as icon_source.
    expect(
      skillsItemSchema.safeParse({
        title: "TypeScript",
        icon_source: "https://cdn/ts-original.svg",
        icon_source_dark: "",
      }).success
    ).toBe(false);
  });

  it("portfolio item, valid with links, rejects bad media_id and js link", () => {
    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "short",
        description: "long",
        media_id: "22222222-2222-2222-2222-222222222222",
        skill_refs: [
          "33333333-3333-3333-3333-333333333333",
          "44444444-4444-4444-4444-444444444444",
        ],
        links: [{ type: "repo", label: "Code", url: "https://github.com/x" }],
      }).success
    ).toBe(true);

    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "short",
        description: "long",
        media_id: "not-a-uuid",
        skill_refs: [],
        links: [],
      }).success
    ).toBe(false);

    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "short",
        description: "long",
        media_id: "22222222-2222-2222-2222-222222222222",
        skill_refs: [],
        links: [{ type: "repo", label: "x", url: "javascript:alert(1)" }],
      }).success
    ).toBe(false);
  });

  it("portfolio item, skill_refs must be uuids (§Skill Refs v1.8)", () => {
    // A well-formed uuid array is accepted.
    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "",
        description: "",
        media_id: "22222222-2222-2222-2222-222222222222",
        skill_refs: ["33333333-3333-3333-3333-333333333333"],
        links: [],
      }).success
    ).toBe(true);

    // A non-uuid entry (e.g. a legacy pasted icon name/URL) is rejected.
    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "",
        description: "",
        media_id: "22222222-2222-2222-2222-222222222222",
        skill_refs: ["react"],
        links: [],
      }).success
    ).toBe(false);
  });

  it("portfolio item, legacy tech_icons is rejected by the strict canonical schema", () => {
    // The field was REPLACED by skill_refs; the strict schema now treats
    // tech_icons as an unknown key. Present-tech_icons (even alongside a valid
    // skill_refs) fails, and an item missing skill_refs fails too.
    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "",
        description: "",
        media_id: "22222222-2222-2222-2222-222222222222",
        tech_icons: ["react", "node"],
        skill_refs: [],
        links: [],
      }).success
    ).toBe(false);

    expect(
      portfolioItemSchema.safeParse({
        title: "Project",
        intro: "",
        description: "",
        media_id: "22222222-2222-2222-2222-222222222222",
        tech_icons: ["react", "node"],
        links: [],
      }).success
    ).toBe(false);
  });

  // ---- Post Refs v1.14: portfolio post_refs -------------------------------
  const PORTFOLIO_BASE = {
    title: "Project",
    intro: "",
    description: "",
    media_id: "22222222-2222-2222-2222-222222222222",
    skill_refs: [],
    links: [],
  };
  const PID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const PID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("portfolio item, post_refs is an optional ordered uuid array (§Post Refs v1.14)", () => {
    // Absent is fine (optional).
    expect(portfolioItemSchema.safeParse(PORTFOLIO_BASE).success).toBe(true);
    // An empty array is fine.
    expect(
      portfolioItemSchema.safeParse({ ...PORTFOLIO_BASE, post_refs: [] }).success
    ).toBe(true);
    // Well-formed uuids are accepted.
    expect(
      portfolioItemSchema.safeParse({
        ...PORTFOLIO_BASE,
        post_refs: [PID_A, PID_B],
      }).success
    ).toBe(true);
  });

  it("portfolio item, post_refs rejects non-uuids, >12 entries, and duplicates", () => {
    // Non-uuid entry rejected.
    expect(
      portfolioItemSchema.safeParse({
        ...PORTFOLIO_BASE,
        post_refs: ["not-a-uuid"],
      }).success
    ).toBe(false);
    // More than 12 entries rejected.
    const thirteen = Array.from(
      { length: 13 },
      (_v, i) => `0000000${i.toString(16).padStart(1, "0")}-0000-0000-0000-000000000000`
    );
    expect(
      portfolioItemSchema.safeParse({ ...PORTFOLIO_BASE, post_refs: thirteen })
        .success
    ).toBe(false);
    // Duplicate ids rejected.
    expect(
      portfolioItemSchema.safeParse({
        ...PORTFOLIO_BASE,
        post_refs: [PID_A, PID_A],
      }).success
    ).toBe(false);
  });

  it("draft-lenient portfolio, post_refs stays permissive (array of strings)", () => {
    const draft = DRAFT_ITEM_SCHEMAS.portfolio;
    // A not-yet-valid id string is accepted in a draft (publish re-parses).
    expect(draft.safeParse({ post_refs: ["draft-id", "another"] }).success).toBe(
      true
    );
    // Still must be an array of strings when present.
    expect(draft.safeParse({ post_refs: [123] }).success).toBe(false);
    // Absent is fine.
    expect(draft.safeParse({}).success).toBe(true);
  });

  it("postRefSchema, resolved read shape {id, slug, title, blog}", () => {
    // With an owning blog.
    expect(
      postRefSchema.safeParse({
        id: PID_A,
        slug: "hello-world",
        title: "Hello World",
        blog: { slug: "code", name: "Code" },
      }).success
    ).toBe(true);
    // With no blog (null).
    expect(
      postRefSchema.safeParse({
        id: PID_A,
        slug: "hello-world",
        title: "Hello World",
        blog: null,
      }).success
    ).toBe(true);
    // A non-uuid id is rejected.
    expect(
      postRefSchema.safeParse({
        id: "nope",
        slug: "x",
        title: "X",
        blog: null,
      }).success
    ).toBe(false);
  });
});

describe("section data schemas (§3.4/§3.5/§3.8)", () => {
  it("has a schema for every registry section type", () => {
    for (const t of SECTION_TYPES) {
      expect(SECTION_DATA_SCHEMAS[t]).toBeDefined();
    }
    expect(Object.keys(SECTION_DATA_SCHEMAS).sort()).toEqual(
      [...SECTION_TYPES].sort()
    );
  });

  it("hero, title is optional (task #106): absent validates, present-but-empty is still rejected", () => {
    // Present and non-empty, the classic case still works.
    expect(heroData.safeParse({ title: "Ben", tagline: "builder" }).success).toBe(
      true
    );

    // NO section requires a heading (product rule, task #106). A hero with no
    // title validates on the CANONICAL (publish) schema and simply renders
    // without one, including a hero with only a tagline, and a fully empty hero.
    const noTitle = heroData.safeParse({ tagline: "no title" });
    expect(noTitle.success).toBe(true);
    if (noTitle.success) {
      expect("title" in noTitle.data).toBe(false);
    }
    expect(heroData.safeParse({}).success).toBe(true);

    // "Absent is how you omit", an explicit empty string is still rejected by
    // the retained `.min(1)`. The admin write path strips `""` before
    // validation (draftData.stripEmptyStrings), so the empty-string case never
    // reaches the canonical schema in practice.
    expect(heroData.safeParse({ title: "" }).success).toBe(false);
    expect(heroData.safeParse({ title: "", tagline: "x" }).success).toBe(false);

    // Draft-lenient path: partial() also accepts absent, and stripping still
    // means the admin create-empty-then-edit flow works.
    expect(DRAFT_SECTION_DATA_SCHEMAS.hero.safeParse({}).success).toBe(true);
    expect(
      DRAFT_SECTION_DATA_SCHEMAS.hero.safeParse({ tagline: "just a tagline" }).success
    ).toBe(true);
  });

  it("hero, optional strict `background` presentation controls, defaults absent, ranges enforced, unknown key rejected", () => {
    // Absent: an existing hero with only background_media_id keeps its shape
    // (no `background` key is inserted, no defaults materialised).
    const bare = heroData.safeParse({
      title: "Ben",
      background_media_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(bare.success).toBe(true);
    if (bare.success) {
      expect("background" in bare.data).toBe(false);
    }

    // Every key can be provided at once and each one survives the round trip.
    const full = heroBackground.safeParse({
      opacity_dark: 0.2,
      opacity_light: 0.08,
      object_fit: "contain",
      object_position: "50% 30%",
      blur_px: 12,
      grayscale: 0.5,
      brightness: 1.1,
      contrast: 0.9,
      saturate: 1.2,
      scale: 1.25,
      overlay_dark: 0.3,
      overlay_light: 0.1,
    });
    expect(full.success).toBe(true);

    // A `background` sub-object nested in the hero also passes end-to-end.
    expect(
      heroData.safeParse({
        background: { opacity_dark: 0.15, object_fit: "cover" },
      }).success
    ).toBe(true);

    // Range boundaries, each min/max endpoint on each numeric key is inclusive,
    // just past either endpoint is rejected.
    expect(heroBackground.safeParse({ opacity_dark: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ opacity_dark: 1 }).success).toBe(true);
    expect(heroBackground.safeParse({ opacity_dark: -0.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ opacity_dark: 1.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ opacity_light: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ opacity_light: 1 }).success).toBe(true);
    expect(heroBackground.safeParse({ opacity_light: 1.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ blur_px: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ blur_px: 40 }).success).toBe(true);
    expect(heroBackground.safeParse({ blur_px: 40.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ blur_px: -1 }).success).toBe(false);
    expect(heroBackground.safeParse({ grayscale: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ grayscale: 1 }).success).toBe(true);
    expect(heroBackground.safeParse({ grayscale: 1.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ brightness: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ brightness: 2 }).success).toBe(true);
    expect(heroBackground.safeParse({ brightness: 2.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ contrast: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ contrast: 2 }).success).toBe(true);
    expect(heroBackground.safeParse({ contrast: 2.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ saturate: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ saturate: 2 }).success).toBe(true);
    expect(heroBackground.safeParse({ saturate: 2.01 }).success).toBe(false);
    // `scale` starts at 1 (a hero image never shrinks below its natural size).
    expect(heroBackground.safeParse({ scale: 1 }).success).toBe(true);
    expect(heroBackground.safeParse({ scale: 2 }).success).toBe(true);
    expect(heroBackground.safeParse({ scale: 0.99 }).success).toBe(false);
    expect(heroBackground.safeParse({ scale: 2.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ overlay_dark: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ overlay_dark: 1 }).success).toBe(true);
    expect(heroBackground.safeParse({ overlay_dark: 1.01 }).success).toBe(false);
    expect(heroBackground.safeParse({ overlay_light: 0 }).success).toBe(true);
    expect(heroBackground.safeParse({ overlay_light: 1 }).success).toBe(true);
    expect(heroBackground.safeParse({ overlay_light: 1.01 }).success).toBe(false);

    // object_fit is an enum, anything else is rejected.
    for (const fit of ["cover", "contain", "fill", "none", "scale-down"]) {
      expect(heroBackground.safeParse({ object_fit: fit }).success).toBe(true);
    }
    expect(heroBackground.safeParse({ object_fit: "stretch" }).success).toBe(false);

    // object_position, CSS-like short strings pass; typical variants and
    // percentages included. Longer than 40 chars, or containing a disallowed
    // char, is rejected.
    for (const pos of [
      "50% 50%",
      "50% 30%",
      "center top",
      "top",
      "0% 0%",
      "100% 100%",
      "-10% 50%",
    ]) {
      expect(heroBackground.safeParse({ object_position: pos }).success).toBe(true);
    }
    // Length cap.
    expect(
      heroBackground.safeParse({ object_position: "a".repeat(41) }).success
    ).toBe(false);
    // Disallowed characters (angle brackets, quotes, slash, comma) are rejected.
    expect(heroBackground.safeParse({ object_position: "50%,30%" }).success).toBe(
      false
    );
    expect(
      heroBackground.safeParse({ object_position: "<script>" }).success
    ).toBe(false);
    expect(heroBackground.safeParse({ object_position: "50% 30% /" }).success).toBe(
      false
    );

    // Unknown keys inside `background` are rejected (strict). Both a nested
    // typo AND an unknown key on the hero itself must 400.
    expect(
      heroBackground.safeParse({ opacity_darkk: 0.2 }).success
    ).toBe(false);
    expect(
      heroData.safeParse({ background: { totally_unknown: 1 } }).success
    ).toBe(false);

    // Draft-lenient path: partial() keeps the whole thing optional and the
    // strip-empty-strings helper flattens cleared fields inside `background`
    // to absent so a form clearing `object_position` to `""` still validates.
    expect(
      DRAFT_SECTION_DATA_SCHEMAS.hero.safeParse({ background: {} }).success
    ).toBe(true);
    const cleared = stripEmptyStrings({
      background: {
        opacity_dark: 0.1,
        object_position: "",
      },
    }) as Record<string, unknown>;
    const parsedCleared = DRAFT_SECTION_DATA_SCHEMAS.hero.safeParse(cleared);
    expect(parsedCleared.success).toBe(true);
    if (parsedCleared.success) {
      const bg = (parsedCleared.data as { background?: Record<string, unknown> })
        .background;
      expect(bg).toBeDefined();
      expect("object_position" in (bg ?? {})).toBe(false);
      expect(bg!.opacity_dark).toBe(0.1);
    }

    // Numbers-as-strings are tolerated via z.coerce.number(), the admin sends
    // numbers as numbers, but a lenient form that stringified them still parses.
    const coerced = heroBackground.safeParse({
      opacity_dark: "0.25",
      blur_px: "8",
    });
    expect(coerced.success).toBe(true);
    if (coerced.success) {
      expect(coerced.data.opacity_dark).toBe(0.25);
      expect(coerced.data.blur_px).toBe(8);
    }
  });

  it("no section type has a required heading/title/eyebrow (task #106)", () => {
    // NOTHING should require a heading. Every section type's CANONICAL
    // (publish) schema must accept a payload with NO heading/title/eyebrow key,
    // even though structural/config fields (services, idle, sphere_detail,
    // etc.) may still be required. This is what unblocks publishing a page
    // where the admin has intentionally left the header copy blank.
    const HEADER_COPY_KEYS = ["heading", "title", "eyebrow"] as const;

    // A minimal, structurally-complete payload for each section type, the
    // config/structural fields their schema requires, and NOTHING else. If a
    // header-copy field is anywhere in here, that's a bug in the fixture.
    const structuralOnly: Record<string, Record<string, unknown>> = {
      hero: {},
      about: {},
      timeline: {},
      skills: {},
      portfolio: {},
      status: { services: ["gateway"] },
      blog: {},
      now_playing: { idle: "hide" },
      duolingo: {},
      github: {},
      ops: {},
      resume: {},
      contact: {},
    };

    for (const type of SECTION_TYPES) {
      const schema = SECTION_DATA_SCHEMAS[type];
      const payload = structuralOnly[type];
      // Payload sanity: no header-copy key smuggled in.
      for (const key of HEADER_COPY_KEYS) {
        expect(payload).not.toHaveProperty(key);
      }
      const parsed = schema.safeParse(payload);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        for (const key of HEADER_COPY_KEYS) {
          expect(key in parsed.data).toBe(false);
        }
      }
    }
  });

  it("status, services list, optional response times", () => {
    expect(
      statusData.safeParse({
        services: ["gateway", "portfolio-v6-api"],
        show_response_times: true,
      }).success
    ).toBe(true);
    expect(statusData.safeParse({ services: "not-an-array" }).success).toBe(
      false
    );
  });

  it("blog, positive integer limit", () => {
    expect(blogData.safeParse({ limit: 5, tag: "eng" }).success).toBe(true);
    expect(blogData.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("blog, optional `blog` slug accepts any string (Blogs v1.13)", () => {
    // Draft-lenient / publish schema takes a plain string here; the existence
    // check is a publish-time concern, not a schema one.
    expect(blogData.safeParse({ limit: 5, blog: "code" }).success).toBe(true);
    expect(blogData.safeParse({ limit: 5, blog: "Not A Real Slug" }).success).toBe(true);
    expect(blogData.safeParse({ limit: 5, blog: 42 }).success).toBe(false);
  });

  it("blog, mode accepts 'teaser'/'index', rejects other values, defaults to 'teaser' (task #101)", () => {
    // Both modes validate.
    expect(blogData.safeParse({ mode: "teaser", limit: 5 }).success).toBe(true);
    expect(blogData.safeParse({ mode: "index" }).success).toBe(true);
    expect(blogData.safeParse({ mode: "index", page_size: 10 }).success).toBe(true);

    // Unknown values rejected.
    expect(blogData.safeParse({ mode: "other", limit: 5 }).success).toBe(false);
    expect(blogData.safeParse({ mode: "", limit: 5 }).success).toBe(false);
    expect(blogData.safeParse({ mode: 1, limit: 5 }).success).toBe(false);

    // Omitting mode validates and, on the canonical (publish) schema, reads as
    // 'teaser', every section stored before this task (no `mode` key) is
    // untouched.
    const noMode = blogData.safeParse({ limit: 5 });
    expect(noMode.success).toBe(true);
    if (noMode.success) expect(noMode.data.mode).toBe("teaser");

    // Existing sections (no `mode`) validate on the draft-lenient path too.
    expect(
      DRAFT_SECTION_DATA_SCHEMAS.blog.safeParse({ limit: 5, tag: "eng" }).success
    ).toBe(true);
    expect(
      DRAFT_SECTION_DATA_SCHEMAS.blog.safeParse({ mode: "index" }).success
    ).toBe(true);
    expect(
      DRAFT_SECTION_DATA_SCHEMAS.blog.safeParse({ mode: "bogus" }).success
    ).toBe(false);
  });

  it("blog, optional `page_size` is a positive int; unknown keys rejected (task #101)", () => {
    expect(blogData.safeParse({ mode: "index", page_size: 10 }).success).toBe(true);
    expect(blogData.safeParse({ mode: "index", page_size: 0 }).success).toBe(false);
    expect(blogData.safeParse({ mode: "index", page_size: -1 }).success).toBe(false);
    expect(blogData.safeParse({ mode: "index", page_size: 1.5 }).success).toBe(false);
    // .strict() still rejects unknown keys.
    expect(blogData.safeParse({ mode: "index", nope: true }).success).toBe(false);
  });

  it("now_playing, idle enum only hide|message", () => {
    expect(nowPlayingData.safeParse({ idle: "hide" }).success).toBe(true);
    expect(
      nowPlayingData.safeParse({ idle: "message", idle_message: "away" }).success
    ).toBe(true);
    expect(nowPlayingData.safeParse({ idle: "explode" }).success).toBe(false);
  });

  it("skills, optional integer sphere_detail 0-4, round-trips absent as absent (v1.5)", () => {
    // Heading/intro only (no sphere_detail) is valid, and the parsed value has
    // no sphere_detail key: absent must round-trip as absent (AUTO), not a
    // defaulted number.
    const auto = skillsData.safeParse({ heading: "Skills", intro: "what I use" });
    expect(auto.success).toBe(true);
    if (auto.success) {
      expect("sphere_detail" in auto.data).toBe(false);
      expect(auto.data.sphere_detail).toBeUndefined();
    }
    // An empty object (fully AUTO) is valid.
    expect(skillsData.safeParse({}).success).toBe(true);

    // Every in-range detail 0..4 is accepted.
    for (const detail of [0, 1, 2, 3, 4]) {
      expect(skillsData.safeParse({ sphere_detail: detail }).success).toBe(true);
    }

    // Out of range and non-integer are rejected.
    expect(skillsData.safeParse({ sphere_detail: 5 }).success).toBe(false);
    expect(skillsData.safeParse({ sphere_detail: -1 }).success).toBe(false);
    expect(skillsData.safeParse({ sphere_detail: 2.5 }).success).toBe(false);

    // proficiency is gone from the section data too, unknown keys rejected.
    expect(skillsData.safeParse({ proficiency: 50 }).success).toBe(false);
  });

  it("duolingo/github/ops, optional intro accepted, round-tripped, strict otherwise (v1.6b)", () => {
    // Each live-section schema now accepts an optional `intro` (lead-in prose
    // rendered under the heading as a <p>). It round-trips exactly, is valid
    // when absent, and unknown keys are still rejected via .strict().
    const duo = duolingoData.safeParse({
      heading: "Duolingo",
      intro: "How my Spanish is going.",
      language: "es",
    });
    expect(duo.success).toBe(true);
    if (duo.success) expect(duo.data.intro).toBe("How my Spanish is going.");

    const gh = githubData.safeParse({
      heading: "GitHub",
      intro: "A year of commits.",
    });
    expect(gh.success).toBe(true);
    if (gh.success) expect(gh.data.intro).toBe("A year of commits.");

    // v1.10: the section is browsable via the year picker, `weeks` is removed.
    expect(githubData.safeParse({ weeks: 52 }).success).toBe(false);

    const ops = opsData.safeParse({
      heading: "Ops",
      intro: "Live infrastructure metrics.",
    });
    expect(ops.success).toBe(true);
    if (ops.success) expect(ops.data.intro).toBe("Live infrastructure metrics.");

    // v1.7: the lookback is no longer configurable, `window_hours` is rejected.
    expect(opsData.safeParse({ window_hours: 3 }).success).toBe(false);

    // Absent intro round-trips as absent (not defaulted to a string).
    for (const parsed of [
      duolingoData.parse({}),
      githubData.parse({}),
      opsData.parse({}),
    ]) {
      expect("intro" in parsed).toBe(false);
      expect((parsed as { intro?: string }).intro).toBeUndefined();
    }

    // Non-string intro is rejected, and unknown keys are still rejected.
    expect(duolingoData.safeParse({ intro: 42 }).success).toBe(false);
    expect(githubData.safeParse({ nope: "x" }).success).toBe(false);
    expect(opsData.safeParse({ bogus: true }).success).toBe(false);
  });

  it("resume (task #92), heading/intro only, NO items, strict on unknown keys", () => {
    // Registry membership: the section type is real and has both canonical and
    // draft-lenient data schemas backing it.
    expect(SECTION_TYPES).toContain("resume");
    expect(SECTION_DATA_SCHEMAS.resume).toBeDefined();
    expect(DRAFT_SECTION_DATA_SCHEMAS.resume).toBeDefined();

    // Empty object is valid (heading/intro both optional). Absent must round-trip
    // as absent, not defaulted to a string.
    const empty = resumeData.safeParse({});
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect("heading" in empty.data).toBe(false);
      expect("intro" in empty.data).toBe(false);
    }

    // Both fields round-trip exactly.
    const both = resumeData.safeParse({
      heading: "Resume",
      intro: "Grab the latest PDF.",
    });
    expect(both.success).toBe(true);
    if (both.success) {
      expect(both.data.heading).toBe("Resume");
      expect(both.data.intro).toBe("Grab the latest PDF.");
    }

    // The resume section has no items (task #92): no `items` field on data,
    // and no item schema is expected for this section type, unknown keys are
    // rejected by .strict().
    expect(resumeData.safeParse({ items: [{}] }).success).toBe(false);
    expect(resumeData.safeParse({ bogus: true }).success).toBe(false);
    expect(resumeData.safeParse({ heading: 42 }).success).toBe(false);
  });

  it("contact, optional links honour the protocol allowlist", () => {
    expect(
      contactData.safeParse({
        heading: "Contact",
        links: [{ type: "other", label: "Email", url: "https://x.com" }],
      }).success
    ).toBe(true);
    expect(
      contactData.safeParse({
        links: [{ type: "other", label: "Email", url: "javascript:1" }],
      }).success
    ).toBe(false);
  });
});

describe("post metadata schema (§3.6)", () => {
  it("accepts a valid post and applies defaults", () => {
    const res = postMetadataSchema.safeParse({
      slug: "hello-world",
      title: "Hello World",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.excerpt).toBe("");
      expect(res.data.tags).toEqual([]);
    }
  });

  it("rejects an invalid slug", () => {
    expect(slugSchema.safeParse("Hello World").success).toBe(false);
    expect(slugSchema.safeParse("hello--world").success).toBe(false);
    expect(slugSchema.safeParse("hello-world-2").success).toBe(true);
  });

  it("full post schema validates the draft_body blocks", () => {
    expect(
      postSchema.safeParse({
        slug: "post",
        title: "Post",
        draft_body: [{ type: "paragraph", text: "hi" }],
      }).success
    ).toBe(true);
    expect(
      postSchema.safeParse({
        slug: "post",
        title: "Post",
        draft_body: [{ type: "nope" }],
      }).success
    ).toBe(false);
  });

  it("accepts an ISO-8601 published_at (or null), rejects a bad value (task 133)", () => {
    // Accepted: absent, null, and a full ISO datetime.
    expect(
      postMetadataSchema.safeParse({ slug: "p", title: "P" }).success
    ).toBe(true);
    expect(
      postMetadataSchema.safeParse({ slug: "p", title: "P", published_at: null })
        .success
    ).toBe(true);
    expect(
      postMetadataSchema.safeParse({
        slug: "p",
        title: "P",
        published_at: "2025-04-01T12:00:00.000Z",
      }).success
    ).toBe(true);

    // Rejected: a bare date, junk string, wrong type.
    expect(
      postMetadataSchema.safeParse({
        slug: "p",
        title: "P",
        published_at: "2025-04-01",
      }).success
    ).toBe(false);
    expect(
      postMetadataSchema.safeParse({
        slug: "p",
        title: "P",
        published_at: "not-a-date",
      }).success
    ).toBe(false);
    expect(
      postMetadataSchema.safeParse({
        slug: "p",
        title: "P",
        published_at: 12345,
      }).success
    ).toBe(false);
  });
});

describe("page schema (§3.10)", () => {
  it("accepts lowercase slugs with digits and hyphens", () => {
    expect(pageSlugSchema.safeParse("home").success).toBe(true);
    expect(pageSlugSchema.safeParse("projects").success).toBe(true);
    expect(pageSlugSchema.safeParse("about-me").success).toBe(true);
    expect(pageSlugSchema.safeParse("page-2").success).toBe(true);
  });

  it("rejects uppercase, spaces, and other illegal characters", () => {
    expect(pageSlugSchema.safeParse("Home").success).toBe(false);
    expect(pageSlugSchema.safeParse("my page").success).toBe(false);
    expect(pageSlugSchema.safeParse("under_score").success).toBe(false);
    expect(pageSlugSchema.safeParse("slash/y").success).toBe(false);
    expect(pageSlugSchema.safeParse("").success).toBe(false);
  });

  it("rejects the reserved slugs api/admin", () => {
    expect([...RESERVED_PAGE_SLUGS]).toEqual(["api", "admin"]);
    for (const reserved of RESERVED_PAGE_SLUGS) {
      expect(pageSlugSchema.safeParse(reserved).success).toBe(false);
    }
    // `home` is special, NOT reserved.
    expect(pageSlugSchema.safeParse("home").success).toBe(true);
    // `blog` is NOT reserved as of task #101, the blog index now lives inside
    // a normal admin-composed page whose slug is `blog`.
    expect(pageSlugSchema.safeParse("blog").success).toBe(true);
  });

  it("accepts a full page and a null nav_label (served but hidden from nav)", () => {
    expect(
      pageSchema.safeParse({
        slug: "home",
        title: "Ben Kile",
        nav_label: "Home",
        nav_position: 0,
        is_hidden: false,
      }).success
    ).toBe(true);
    expect(
      pageSchema.safeParse({
        slug: "one-off",
        title: "One-off",
        nav_label: null,
        nav_position: 3,
        is_hidden: false,
      }).success
    ).toBe(true);
  });

  it("rejects an empty title, a reserved slug, and unknown keys", () => {
    expect(
      pageSchema.safeParse({
        slug: "ok",
        title: "",
        nav_position: 0,
        is_hidden: false,
      }).success
    ).toBe(false);
    expect(
      pageSchema.safeParse({
        slug: "admin",
        title: "Admin",
        nav_position: 0,
        is_hidden: false,
      }).success
    ).toBe(false);
    expect(
      pageSchema.safeParse({
        slug: "ok",
        title: "OK",
        nav_position: 0,
        is_hidden: false,
        surprise: true,
      }).success
    ).toBe(false);
  });

  it("draft-lenient variant: required fields may be absent (§3.9)", () => {
    // A fresh, incomplete draft passes.
    expect(draftPageSchema.safeParse({}).success).toBe(true);
    expect(draftPageSchema.safeParse({ title: "WIP" }).success).toBe(true);
    // But a provided field is still validated, a bad slug is rejected even in
    // a draft, and unknown keys are still rejected.
    expect(draftPageSchema.safeParse({ slug: "Bad Slug" }).success).toBe(false);
    expect(draftPageSchema.safeParse({ slug: "admin" }).success).toBe(false);
    expect(draftPageSchema.safeParse({ nav_position: 1.5 }).success).toBe(false);
    expect(draftPageSchema.safeParse({ surprise: true }).success).toBe(false);
  });
});
