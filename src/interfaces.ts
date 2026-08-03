// ---- App / API secrets ------------------------------------------------------
// Shape follows the v5 `IAPISecrets` / Secrets Manager convention documented in
// TECH_SPEC_V1.md §9.3 (snake_case keys, as stored in `portfolio-v6-api-secrets`).
// Under IS_LOCAL these are assembled from environment variables instead of AWS
// (see src/config/loadConfig.ts). `gateway_health_url` is not part of the stored
// secret today — it is sourced from the environment and consumed by /api/status
// (task 442); it lives here so both config paths produce one config shape.
export interface IAppSecrets {
  db_name: string;
  node_env: "development" | "production";
  port: string;
  s3_bucket_name: string;
  cdn_domain: string;
  cognito_user_pool_id: string;
  cognito_client_id: string;
  aws_region: string;
  spotify_client_id: string;
  spotify_client_secret: string;
  spotify_refresh_token: string;
  /**
   * Redirect URI for the admin Spotify reconnect flow (adminSpotifyRouter) —
   * must EXACTLY match a Redirect URI registered on the Spotify app. Optional:
   * deployed installs set it in the stored secret (it embeds the public API
   * origin, an infra value that never lives in this repo); locally it defaults
   * to the loopback callback (see spotifyOAuthService.resolveRedirectUri).
   */
  spotify_redirect_uri?: string;
  /**
   * Dedicated key for the service-token encryption at rest (§4.7,
   * serviceTokenStore). Optional: when unset the store derives its key from
   * `spotify_client_secret` for back-compat, so existing Spotify ciphertext stays
   * decryptable until this dedicated key is introduced. Introducing or rotating
   * it re-derives the key; any prior ciphertext then reads as "not connected"
   * (the §4.7 degrade rule) and the fix is re-entering / reconnecting.
   */
  token_encryption_key?: string;
  gateway_health_url?: string;
}

// ---- DB secrets (separate Secrets Manager secret via getDBSecrets, §9.3) -----
export interface IDBSecrets {
  username: string;
  password: string;
}

// ---- Resolved Postgres connection used by initDb ----------------------------
export interface IDbConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

// ---- DB health-check result (ported from file-manager-api) ------------------
export interface IDBHealth {
  connected: boolean;
  connectionUsesProxy: boolean;
  logs?: {
    messages: string[];
    host?: string;
    timestamp: string;
    error?: string;
  };
}

// ---- Standard response envelope (§4.3) --------------------------------------
export interface ISuccessEnvelope<T> {
  status: "ok";
  error: false;
  data: T;
}

export interface IErrorEnvelope {
  status: "error";
  error: true;
  errorMsg: string;
}
