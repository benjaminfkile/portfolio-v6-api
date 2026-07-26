import http from "http";
import request from "supertest";

// Boot proof: run the real index.ts start() orchestration (loadConfig -> initDb
// -> listen) under IS_LOCAL=true and confirm the booted server serves
// GET /api/health with 200 and that ZERO AWS calls are made.
//
// The DB layer is mocked (it is a genuinely external, offline dependency here;
// the real Postgres boot path is exercised separately). The AWS SDK is mocked
// only to assert it is never constructed on the IS_LOCAL path.

const clientCtor = jest.fn();
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => {
    clientCtor();
    return { send: jest.fn() };
  }),
  GetSecretValueCommand: jest.fn(),
}));

const initDb = jest.fn().mockResolvedValue({});
const buildDbConnection = jest.fn().mockReturnValue({});
jest.mock("../src/db/db", () => ({
  initDb,
  buildDbConnection,
  getDb: jest.fn(),
  closeDb: jest.fn().mockResolvedValue(undefined),
}));

let server: http.Server | undefined;

beforeAll(async () => {
  process.env.IS_LOCAL = "true";
  process.env.NODE_ENV = "development";
  process.env.PORT = "34567";
  delete process.env.AWS_SECRET_ARN;
  delete process.env.AWS_DB_SECRET_ARN;

  const index = await import("../index");
  server = await index.start();
}, 30000);

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

describe("boot under IS_LOCAL=true (§10)", () => {
  it("runs the secrets -> initDb -> listen path with zero AWS calls", () => {
    expect(initDb).toHaveBeenCalledTimes(1);
    expect(buildDbConnection).toHaveBeenCalledTimes(1);
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it("the booted server serves GET /api/health with 200", async () => {
    const res = await request(server!).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", error: false });
  });
});
