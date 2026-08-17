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
  /**
   * Whether the Postgres connection uses TLS, as the string "true"/"false"
   * (matching the DB_SSL env var it replaces). Optional: when unset,
   * buildDbConnection falls back to DB_SSL from the environment.
   */
  db_ssl?: string;
  /**
   * Name of the CloudWatch dashboard the `ops` live section (§3.5, v1.3) reads
   * through `GET /api/ops`. This is an infra identifier and MUST NOT appear in
   * repo content, code, tests, or logs — it lives only in the stored secret
   * (deployed) or `CLOUDWATCH_DASHBOARD_NAME` (local). Optional: when unset or
   * empty, `/api/ops` serves `{ available: false }` and makes no AWS call.
   */
  cloudwatch_dashboard_name?: string;
  /**
   * Optional Redis URL for the single-poller / shared-snapshot subsystem
   * (task #84). Sourced from the REDIS_URL env var. When unset the app runs
   * with today's per-instance in-memory caches and never opens a Redis
   * connection — local dev and CI stay Redis-free. Deployed installs point
   * this at their per-environment Redis (prod and dev keys never collide —
   * both are prefixed with `node_env`, see loadConfig).
   */
  redis_url?: string;
  /**
   * Base tick for the leader poll loop, milliseconds. Prod runs 5000, dev
   * runs 10000, default 10000. Only the leader ticks — non-leaders serve
   * from the shared snapshot.
   */
  poll_interval_ms?: number;
  /**
   * Internal base URL the container uses to reach the gateway's
   * `POST /internal/publish` endpoint (realtime hub). Defaults to
   * `http://gateway:8080`. Publish failures never affect HTTP serving.
   */
  gateway_internal_url?: string;
  /**
   * Shared secret the gateway injects into every service container so the
   * internal publish endpoint can authenticate us (§ REALTIME.md). Sent as
   * the `X-Gateway-Realtime-Token` header on every publish. Never returned
   * to any response and never logged.
   */
  gateway_realtime_token?: string;
}

// ---- DB secrets (separate Secrets Manager secret via getDBSecrets, §9.3) -----
// RDS-managed secrets also carry `host`/`port` alongside the credentials;
// buildDbConnection prefers them over the DB_HOST/DB_PORT env fallbacks, so a
// deployed container needs no DB_* env vars. Both stay optional — the local
// path (loadLocalConfig) supplies credentials only.
export interface IDBSecrets {
  username: string;
  password: string;
  host?: string;
  port?: number | string;
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
