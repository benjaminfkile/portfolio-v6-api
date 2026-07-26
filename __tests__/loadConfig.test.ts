// Prove IS_LOCAL=true sources all config from env and makes ZERO AWS calls.
// The AWS SDK is mocked so we can assert no Secrets Manager client is ever
// constructed on the local path.
const clientCtor = jest.fn();
const sendMock = jest.fn();

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn().mockImplementation((...args) => {
    clientCtor(...args);
    return { send: sendMock };
  }),
  GetSecretValueCommand: jest.fn(),
}));

import { loadConfig, isLocal } from "../src/config/loadConfig";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("loadConfig — IS_LOCAL path", () => {
  it("isLocal() reflects IS_LOCAL=true", () => {
    process.env.IS_LOCAL = "true";
    expect(isLocal()).toBe(true);
  });

  it("sources all config from env and makes zero AWS calls", async () => {
    process.env.IS_LOCAL = "true";
    process.env.NODE_ENV = "development";
    process.env.PORT = "3002";
    process.env.DB_NAME = "portfolio_v6_local";
    process.env.DB_USER = "node";
    process.env.DB_PASSWORD = "";
    process.env.CDN_DOMAIN = "media-dev.benkile.com";
    process.env.COGNITO_USER_POOL_ID = "us-east-1_local";
    process.env.COGNITO_CLIENT_ID = "local-client";
    process.env.SPOTIFY_CLIENT_ID = "spid";
    process.env.GATEWAY_HEALTH_URL = "http://localhost:3000/api/health";

    const config = await loadConfig();

    expect(config.appSecrets).toMatchObject({
      db_name: "portfolio_v6_local",
      node_env: "development",
      port: "3002",
      cdn_domain: "media-dev.benkile.com",
      cognito_user_pool_id: "us-east-1_local",
      cognito_client_id: "local-client",
      spotify_client_id: "spid",
      gateway_health_url: "http://localhost:3000/api/health",
    });
    expect(config.dbSecrets).toEqual({ username: "node", password: "" });

    // The crucial assertion: no AWS client constructed, no send() issued.
    expect(clientCtor).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("falls back to sane defaults when env vars are absent", async () => {
    process.env.IS_LOCAL = "true";
    delete process.env.DB_NAME;
    delete process.env.PORT;
    delete process.env.DB_USER;

    const config = await loadConfig();

    expect(config.appSecrets.db_name).toBe("portfolio_v6_local");
    expect(config.appSecrets.port).toBe("3002");
    expect(config.dbSecrets.username).toBe("node");
    expect(clientCtor).not.toHaveBeenCalled();
  });
});
