import { IAppSecrets } from "../interfaces";

/**
 * Integration descriptors (§4.7) — the single registry that the admin
 * `/api/admin/integrations` router drives for every admin-granted integration.
 *
 * Two cases, one per auth kind:
 *   - github   ('api_key') — a personal access token pasted by the admin.
 *   - duolingo ('value')   — a public username pasted by the admin (not secret;
 *                            handled uniformly so the store has one shape).
 *
 * Spotify is NOT here: now-playing is driven by the connect-listener (an
 * admin-pasted `sp_dc` cookie managed by the dedicated listener endpoints), and
 * the old Spotify Web API polling / OAuth path was removed.
 *
 * A descriptor carries everything the router needs so no integration-specific
 * branching lives in the router: display name, auth kind, the OAuth wiring (for
 * 'oauth' kinds only), an expiry policy, an optional secrets-fallback probe, and
 * an optional post-write hook to clear any in-memory runtime state.
 */

export type IntegrationKey = "github" | "duolingo";
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
   * row. NO real integration uses this today — every shipping integration is
   * admin-granted only. Kept in the interface so a future integration could
   * opt in without reshaping the descriptor.
   */
  secretsFallback?(secrets: IAppSecrets): boolean;
  /** Clear any in-memory runtime state after the stored credential changes. */
  onTokenChanged?(): void;
}

export const INTEGRATION_DESCRIPTORS: IntegrationDescriptor[] = [
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
