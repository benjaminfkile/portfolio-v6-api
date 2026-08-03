import { IAppSecrets, IDBSecrets } from "../interfaces";

export interface LoadedConfig {
  appSecrets: IAppSecrets;
  dbSecrets: IDBSecrets;
}

/** True when the API is running locally (no AWS). See TECH_SPEC_V1.md §10. */
export function isLocal(): boolean {
  return process.env.IS_LOCAL === "true";
}

/**
 * Build the full app/db config from environment variables with sane defaults.
 * Used only on the IS_LOCAL path — no AWS SDK module is even imported here.
 */
function loadLocalConfig(): LoadedConfig {
  const nodeEnv =
    process.env.NODE_ENV === "production" ? "production" : "development";

  const appSecrets: IAppSecrets = {
    db_name: process.env.DB_NAME || "portfolio_v6_local",
    node_env: nodeEnv,
    port: process.env.PORT || "3002",
    s3_bucket_name: process.env.S3_BUCKET_NAME || "bk-portfolio-v6-local",
    cdn_domain: process.env.CDN_DOMAIN || "media-dev.benkile.com",
    cognito_user_pool_id: process.env.COGNITO_USER_POOL_ID || "local-user-pool",
    cognito_client_id: process.env.COGNITO_CLIENT_ID || "local-client-id",
    aws_region: process.env.AWS_REGION || "us-east-1",
    spotify_client_id: process.env.SPOTIFY_CLIENT_ID || "",
    spotify_client_secret: process.env.SPOTIFY_CLIENT_SECRET || "",
    spotify_refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || "",
    spotify_redirect_uri: process.env.SPOTIFY_REDIRECT_URI || undefined,
    token_encryption_key: process.env.TOKEN_ENCRYPTION_KEY || undefined,
    gateway_health_url:
      process.env.GATEWAY_HEALTH_URL || "http://localhost:3000/api/health",
  };

  const dbSecrets: IDBSecrets = {
    username: process.env.DB_USER || "node",
    password: process.env.DB_PASSWORD || "",
  };

  return { appSecrets, dbSecrets };
}

/**
 * Resolve configuration for boot.
 *
 * - IS_LOCAL=true  → everything from env with defaults; NO AWS call is made and
 *   the AWS SDK modules are never imported.
 * - otherwise      → AWS Secrets Manager (getAppSecrets/getDBSecrets), imported
 *   lazily so the SDK is loaded only on the path that needs it.
 */
export async function loadConfig(): Promise<LoadedConfig> {
  if (isLocal()) {
    return loadLocalConfig();
  }

  const { getAppSecrets } = await import("../aws/getAppSecrets");
  const { getDBSecrets } = await import("../aws/getDBSecrets");

  const [appSecrets, dbSecrets] = await Promise.all([
    getAppSecrets(),
    getDBSecrets(),
  ]);

  return { appSecrets, dbSecrets };
}
