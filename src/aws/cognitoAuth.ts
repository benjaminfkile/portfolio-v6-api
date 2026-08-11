import { CognitoJwtVerifier } from "aws-jwt-verify";

/**
 * Thin wrapper around `aws-jwt-verify` for the admin ID-token path
 * (TECH_SPEC_V1.md §5.3). Kept in its own module so the auth middleware can be
 * unit-tested by mocking this file wholesale — no AWS/Cognito/JWKS network call
 * is ever made in tests.
 *
 * Portfolio v6 has a single class of user, so there is no `users` table and no
 * `cognito_sub` join (§5.3). Verification is: signature + expiry + pool + client
 * (all enforced by the verifier) plus `cognito:groups` ∋ "admins", checked by the
 * caller.
 */

// The shape of the claims we rely on. `aws-jwt-verify` returns a richer payload;
// this narrows it to what requireAdmin() needs.
export interface AdminIdTokenPayload {
  sub: string;
  "cognito:groups"?: string[];
  [claim: string]: unknown;
}

// A verifier caches the pool's JWKS after its first `verify()`, so we cache one
// instance per (pool, client) pair to avoid refetching the key set per request.
// The cache is process-local and holds no secrets — just public configuration.
type Verifier = ReturnType<
  typeof CognitoJwtVerifier.create<{
    userPoolId: string;
    clientId: string;
    tokenUse: "id";
  }>
>;

const verifierCache = new Map<string, Verifier>();

function getVerifier(userPoolId: string, clientId: string): Verifier {
  const key = `${userPoolId}|${clientId}`;
  let verifier = verifierCache.get(key);
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: "id",
    });
    verifierCache.set(key, verifier);
  }
  return verifier;
}

/**
 * Verify a Cognito **ID** token against the configured pool and client. Resolves
 * with the decoded payload; rejects if the token is missing, malformed, expired,
 * or signed for the wrong pool/client (§5.1 — a file-manager token is invalid
 * here because the client id differs).
 */
export async function verifyAdminIdToken(
  token: string,
  userPoolId: string,
  clientId: string
): Promise<AdminIdTokenPayload> {
  const verifier = getVerifier(userPoolId, clientId);
  const payload = await verifier.verify(token);
  return payload as unknown as AdminIdTokenPayload;
}
