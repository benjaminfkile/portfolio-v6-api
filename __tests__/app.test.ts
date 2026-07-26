import request from "supertest";
import app from "../src/app";
import { success, failure } from "../src/utils/envelope";

describe("response envelope (§4.3)", () => {
  it("success() matches file-manager-api convention", () => {
    expect(success({ a: 1 })).toEqual({
      status: "ok",
      error: false,
      data: { a: 1 },
    });
  });

  it("failure() matches file-manager-api convention", () => {
    expect(failure("boom")).toEqual({
      status: "error",
      error: true,
      errorMsg: "boom",
    });
  });
});

describe("app basic routes", () => {
  it("GET / returns service name with -dev suffix when not production", async () => {
    app.set("secrets", { node_env: "development" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("portfolio-v6-api-dev");
  });

  it("GET / returns service name without suffix in production", async () => {
    app.set("secrets", { node_env: "production" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("portfolio-v6-api");
  });
});

describe("GET /api/health (§11.1) — no DB call", () => {
  it("returns 200 with the ok envelope", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      error: false,
      data: { service: "portfolio-v6-api", status: "up" },
    });
  });
});

describe("JSON error handler (§4.4)", () => {
  it("returns a JSON 500 envelope, not an HTML/view error", async () => {
    const res = await request(app)
      .post("/")
      .set("Content-Type", "application/json")
      .send("{ this is not valid json");
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ status: "error", error: true });
    expect(typeof res.body.errorMsg).toBe("string");
  });
});
