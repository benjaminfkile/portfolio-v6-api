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
});
