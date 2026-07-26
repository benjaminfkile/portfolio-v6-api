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
});
