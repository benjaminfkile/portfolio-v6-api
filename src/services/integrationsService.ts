import { IAppSecrets } from "../interfaces";
import {
  buildAuthorizeUrl as buildSpotifyAuthorizeUrl,
  exchangeCodeForRefreshToken as exchangeSpotifyCode,
  resolveRedirectUri as resolveSpotifyRedirectUri,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_OAUTH_SCOPE,
  SPOTIFY_OAUTH_TOKEN_URL,
} from "./spotifyOAuthService";
import { SPOTIFY_REFRESH_TOKEN_LIFETIME_MS } from "./spotifyTokenStore";
import { clearSpotifyRuntimeState } from "./spotifyService";

/**
 * Integration descriptors (§4.7) — the single registry that generalizes the
 * §4.6 Spotify flow into a pattern the admin `/api/admin/integrations` router
 * drives for every integration.
 *
 * Three real cases, one per auth kind:
 *   - spotify  ('oauth')   — a browser authorization-code flow yields a refresh
 *                            token; expires 180 days after authorization.
 *   - github   ('api_key') — a personal access token pasted by the admin.
 *   - duolingo ('value')   — a public username pasted by the admin (not secret;
 *                            handled uniformly so the store has one shape).
 *
 * A descriptor carries everything the router needs so no integration-specific
 * branching lives in the router: display name, auth kind, the OAuth wiring (for
 * 'oauth' kinds only), an expiry policy, an optional secrets-fallback probe (only
 * Spotify has a static bootstrap secret), and an optional post-write hook to
 * clear any in-memory runtime state.
 */

export type IntegrationKey = "spotify" | "github" | "duolingo";
export type AuthKind = "oauth" | "api_key" | "value";

/** OAuth wiring for an 'oauth' descriptor. Absent on api_key/value kinds. */
export interface OAuthWiring {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** The exact redirect URI registered upstream (spotify_redirect_uri or default). */
  resolveRedirectUri(secrets: IAppSecrets): string;
  /** The client credentials pulled from app secrets. */
  resolveClientCredentials(secrets: IAppSecrets): {
    clientId: string;
    clientSecret: string;
  };
  /** Build the upstream authorize URL the admin's browser is sent to. */
  buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string;
  /** Exchange the returned code for the long-lived credential to store. */
  exchangeCode(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    code: string
  ): Promise<string>;
}

export interface IntegrationDescriptor {
  key: IntegrationKey;
  display_name: string;
  auth_kind: AuthKind;
  /** Present iff auth_kind === 'oauth'. */
  oauth?: OAuthWiring;
  /**
   * Expiry policy: given the authorization instant, the expiry instant, or null
   * when the credential does not expire (github/duolingo).
   */
  expiresAt(authorizedAt: Date): Date | null;
  /**
   * True when a static app-secret provides this integration without a stored
   * row. NO real integration uses this today — Spotify's static
   * `spotify_refresh_token` fallback was killed by task #112 (admin-granted
   * credentials ONLY), and github/duolingo never had a static path. Kept in
   * the interface so a future integration could opt in without reshaping
   * the descriptor.
   */
  secretsFallback?(secrets: IAppSecrets): boolean;
  /** Clear any in-memory runtime state after the stored credential changes. */
  onTokenChanged?(): void;
}

export const INTEGRATION_DESCRIPTORS: IntegrationDescriptor[] = [
  {
    key: "spotify",
    display_name: "Spotify",
    auth_kind: "oauth",
    oauth: {
      authorizeUrl: SPOTIFY_AUTHORIZE_URL,
      tokenUrl: SPOTIFY_OAUTH_TOKEN_URL,
      scopes: [SPOTIFY_OAUTH_SCOPE],
      resolveRedirectUri: resolveSpotifyRedirectUri,
      resolveClientCredentials: (secrets) => ({
        clientId: secrets.spotify_client_id,
        clientSecret: secrets.spotify_client_secret,
      }),
      buildAuthorizeUrl: buildSpotifyAuthorizeUrl,
      exchangeCode: exchangeSpotifyCode,
    },
    // Spotify refresh tokens expire 180 days after authorization (§4.6).
    expiresAt: (authorizedAt) =>
      new Date(authorizedAt.getTime() + SPOTIFY_REFRESH_TOKEN_LIFETIME_MS),
    // Task #112 killed the static spotify_refresh_token fallback — the admin
    // reconnect flow is the only bootstrap. Missing service_tokens row =
    // DISCONNECTED (silent, zero Spotify calls).
    onTokenChanged: clearSpotifyRuntimeState,
  },
  {
    key: "github",
    display_name: "GitHub",
    auth_kind: "api_key",
    // A PAT does not carry a tracked expiry here; treat it as non-expiring.
    expiresAt: () => null,
  },
  {
    key: "duolingo",
    display_name: "Duolingo",
    auth_kind: "value",
    // A public username never expires.
    expiresAt: () => null,
  },
];

/** Look up a descriptor by key, or undefined for an unknown integration. */
export function getIntegrationDescriptor(
  key: string
): IntegrationDescriptor | undefined {
  return INTEGRATION_DESCRIPTORS.find((d) => d.key === key);
}
