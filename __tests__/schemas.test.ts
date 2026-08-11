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
  statusData,
  blogData,
  nowPlayingData,
  contactData,
  skillsData,
  duolingoData,
  githubData,
  opsData,
  SECTION_DATA_SCHEMAS,
  SECTION_TYPES,
  postMetadataSchema,
  postSchema,
  slugSchema,
  pageSlugSchema,
  pageSchema,
  draftPageSchema,
  RESERVED_PAGE_SLUGS,
} from "../src/schemas";

describe("Link schema (§3.4) — protocol allowlist", () => {
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
    "rejects the non-http(s) protocol %s",
    (url) => {
      expect(
        linkSchema.safeParse({ type: "other", label: "l", url }).success
      ).toBe(false);
    }
  );

  it("only allows http: and https: protocols", () => {
    expect([...ALLOWED_LINK_PROTOCOLS]).toEqual(["http:", "https:"]);
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
  it("timeline item — valid and invalid", () => {
    expect(
      timelineItemSchema.safeParse({
        date_range: "2020–2022",
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

  it("skills item — valid without proficiency; rejects a leftover proficiency key (strict, v1.5)", () => {
    expect(
      skillsItemSchema.safeParse({
        title: "TypeScript",
        description: "strong",
        icon_source: "devicon:typescript",
      }).success
    ).toBe(true);
    // proficiency was removed from the product — a strict schema rejects it.
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

  it("skills item — optional icon_source_dark; absent round-trips as absent (v1.6)", () => {
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

    // Absent is valid and must NOT materialize a key — renderers fall back to
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

  it("portfolio item — valid with links, rejects bad media_id and js link", () => {
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

  it("portfolio item — skill_refs must be uuids (§Skill Refs v1.8)", () => {
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

  it("portfolio item — legacy tech_icons is rejected by the strict canonical schema", () => {
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

  it("portfolio item — post_refs is an optional ordered uuid array (§Post Refs v1.14)", () => {
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

  it("portfolio item — post_refs rejects non-uuids, >12 entries, and duplicates", () => {
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

  it("draft-lenient portfolio — post_refs stays permissive (array of strings)", () => {
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

  it("postRefSchema — resolved read shape {id, slug, title, blog}", () => {
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

  it("hero — valid and rejects missing title", () => {
    expect(heroData.safeParse({ title: "Ben", tagline: "builder" }).success).toBe(
      true
    );
    expect(heroData.safeParse({ tagline: "no title" }).success).toBe(false);
  });

  it("status — services list, optional response times", () => {
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

  it("blog — positive integer limit", () => {
    expect(blogData.safeParse({ limit: 5, tag: "eng" }).success).toBe(true);
    expect(blogData.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("blog — optional `blog` slug accepts any string (Blogs v1.13)", () => {
    // Draft-lenient / publish schema takes a plain string here; the existence
    // check is a publish-time concern, not a schema one.
    expect(blogData.safeParse({ limit: 5, blog: "code" }).success).toBe(true);
    expect(blogData.safeParse({ limit: 5, blog: "Not A Real Slug" }).success).toBe(true);
    expect(blogData.safeParse({ limit: 5, blog: 42 }).success).toBe(false);
  });

  it("now_playing — idle enum only hide|message", () => {
    expect(nowPlayingData.safeParse({ idle: "hide" }).success).toBe(true);
    expect(
      nowPlayingData.safeParse({ idle: "message", idle_message: "away" }).success
    ).toBe(true);
    expect(nowPlayingData.safeParse({ idle: "explode" }).success).toBe(false);
  });

  it("skills — optional integer sphere_detail 0–4, round-trips absent as absent (v1.5)", () => {
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

    // proficiency is gone from the section data too — unknown keys rejected.
    expect(skillsData.safeParse({ proficiency: 50 }).success).toBe(false);
  });

  it("duolingo/github/ops — optional intro accepted, round-tripped, strict otherwise (v1.6b)", () => {
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

    // v1.10: the section is browsable via the year picker — `weeks` is removed.
    expect(githubData.safeParse({ weeks: 52 }).success).toBe(false);

    const ops = opsData.safeParse({
      heading: "Ops",
      intro: "Live infrastructure metrics.",
    });
    expect(ops.success).toBe(true);
    if (ops.success) expect(ops.data.intro).toBe("Live infrastructure metrics.");

    // v1.7: the lookback is no longer configurable — `window_hours` is rejected.
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

  it("contact — optional links honour the protocol allowlist", () => {
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

  it("rejects the reserved slugs blog/api/admin", () => {
    expect([...RESERVED_PAGE_SLUGS]).toEqual(["blog", "api", "admin"]);
    for (const reserved of RESERVED_PAGE_SLUGS) {
      expect(pageSlugSchema.safeParse(reserved).success).toBe(false);
    }
    // `home` is special, NOT reserved.
    expect(pageSlugSchema.safeParse("home").success).toBe(true);
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
    // But a provided field is still validated — a bad slug is rejected even in
    // a draft, and unknown keys are still rejected.
    expect(draftPageSchema.safeParse({ slug: "Bad Slug" }).success).toBe(false);
    expect(draftPageSchema.safeParse({ slug: "admin" }).success).toBe(false);
    expect(draftPageSchema.safeParse({ nav_position: 1.5 }).success).toBe(false);
    expect(draftPageSchema.safeParse({ surprise: true }).success).toBe(false);
  });
});
