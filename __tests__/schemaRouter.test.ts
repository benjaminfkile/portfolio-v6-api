import request from "supertest";
import app from "../src/app";
import { buildContentJsonSchema } from "../src/schemas";

describe("GET /api/schema (§8.4)", () => {
  it("serves the JSON Schema derived from the Zod definitions", async () => {
    const res = await request(app).get("/api/schema");
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");

    // It is a JSON Schema document, not the API envelope.
    expect(res.body).toHaveProperty("$schema");
    expect(res.body).not.toHaveProperty("status");
    expect(res.body).not.toHaveProperty("data");
  });

  it("matches the freshly-derived schema and exposes shared $defs", async () => {
    const res = await request(app).get("/api/schema");
    const expected = buildContentJsonSchema();
    expect(res.body).toEqual(expected);

    // Link and Block are emitted once under definitions and referenced.
    const defs = (res.body.definitions ?? res.body["$defs"]) as
      | Record<string, unknown>
      | undefined;
    expect(defs).toBeDefined();
    expect(defs).toHaveProperty("Link");
    expect(defs).toHaveProperty("Block");
  });

  it("surfaces the Blogs v1.13 shapes (blog ref, post blog_id, section blog field)", async () => {
    const res = await request(app).get("/api/schema");
    const root = (res.body.definitions ?? res.body["$defs"])[
      "PortfolioV6Content"
    ] as { properties: Record<string, any> };

    // The resolved blog reference ({slug, name}) a public post/summary carries.
    expect(root.properties).toHaveProperty("blog");
    expect(Object.keys(root.properties.blog.properties)).toEqual(
      expect.arrayContaining(["slug", "name"])
    );

    // The post write shape carries the nullable blog_id.
    expect(root.properties.postMetadata.properties).toHaveProperty("blog_id");

    // The blog SECTION config gains the optional `blog` slug field.
    expect(
      root.properties.sectionData.properties.blog.properties
    ).toHaveProperty("blog");
  });

  it("surfaces the blog section's `mode` and `page_size` (task #101 — Blog-as-a-page)", async () => {
    const res = await request(app).get("/api/schema");
    const defs = (res.body.definitions ?? res.body["$defs"]) as Record<string, any>;
    const root = defs["PortfolioV6Content"] as { properties: Record<string, any> };

    const blogSection = root.properties.sectionData.properties.blog;
    expect(blogSection.properties).toHaveProperty("mode");
    // The enum is exactly {teaser, index}, and 'teaser' is the default.
    expect(blogSection.properties.mode.enum).toEqual(["teaser", "index"]);
    expect(blogSection.properties.mode.default).toBe("teaser");

    // The index-only pagination knob is exposed for `sync:types`.
    expect(blogSection.properties).toHaveProperty("page_size");
  });

  it("no longer lists media_id under the timeline item definition (§3.4 v1.17)", async () => {
    const res = await request(app).get("/api/schema");
    const defs = (res.body.definitions ?? res.body["$defs"]) as Record<string, any>;
    const root = defs["PortfolioV6Content"] as { properties: Record<string, any> };

    const timeline = root.properties.itemData.properties.timeline;

    // The tightened timeline item shape: exactly {date_range, title, description}.
    expect(Object.keys(timeline.properties).sort()).toEqual([
      "date_range",
      "description",
      "title",
    ]);
    // The removed key is gone from the JSON Schema so both frontends' sync:types
    // stops advertising it.
    expect(timeline.properties).not.toHaveProperty("media_id");
  });

  it("surfaces the resume section type (task #92 — heading/intro, no items)", async () => {
    const res = await request(app).get("/api/schema");
    const defs = (res.body.definitions ?? res.body["$defs"]) as Record<string, any>;
    const root = defs["PortfolioV6Content"] as { properties: Record<string, any> };

    // The section-data map for the whole registry gains `resume`, and its shape
    // is exactly `{heading?, intro?}` — mirrors ops/github, no items.
    expect(root.properties.sectionData.properties).toHaveProperty("resume");
    const resume = root.properties.sectionData.properties.resume;
    expect(Object.keys(resume.properties ?? {}).sort()).toEqual(["heading", "intro"]);

    // The resume section deliberately has no items, so the itemData map must
    // NOT gain a `resume` entry (task #92 — a resume replaces itself, versioning
    // happens on the row, not as a list).
    expect(root.properties.itemData.properties).not.toHaveProperty("resume");
  });

  it("surfaces the Post Refs v1.14 shapes (portfolio post_refs + resolved posts + PostRef)", async () => {
    const res = await request(app).get("/api/schema");
    const defs = (res.body.definitions ?? res.body["$defs"]) as Record<string, any>;
    const root = defs["PortfolioV6Content"] as { properties: Record<string, any> };

    const portfolio = root.properties.itemData.properties.portfolio;

    // The item write field: an ordered uuid array of related-post references.
    expect(portfolio.properties).toHaveProperty("post_refs");
    expect(portfolio.properties.post_refs.type).toBe("array");

    // The read-time resolved shape serialized onto each portfolio item.
    expect(portfolio.properties).toHaveProperty("posts");
    expect(portfolio.properties.posts.type).toBe("array");

    // PostRef is emitted once as a named definition (like Link/Block) and the
    // portfolio `posts` array references it — the resolved {id,slug,title,blog}.
    expect(defs).toHaveProperty("PostRef");
    expect(Object.keys(defs.PostRef.properties)).toEqual(
      expect.arrayContaining(["id", "slug", "title", "blog"])
    );
  });
});
