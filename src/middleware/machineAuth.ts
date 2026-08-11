import { Request } from "express";
import { verifyMachineAccessToken } from "../aws/cognitoAuth";
import { IAppSecrets } from "../interfaces";

/**
 * Machine Auth v1.15 — the client-credentials ACCESS-token check shared by
 * `requireAdminOrMachine` (grants the narrow machine surface) and `requireAdmin`
 * (denies a valid machine token with 403 everywhere else). Kept in its own module
 * so it depends on nothing in `requireAdmin.ts` — that keeps the import graph
 * acyclic while both middlewares can classify a machine principal identically.
 *
 * The verified machine app-client id is attached to the request so the publish
 * handler can attribute a machine publish as `machine:<client_id>` (§ contract 4).
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      machineClient?: string;
    }
  }
}

/** Default resource-server scope the machine token must carry when unconfigured. */
export const DEFAULT_MACHINE_SCOPE = "portfolio-api/machine";

/**
 * Result of classifying a request against the machine app client:
 *  - `off`     — the feature is not configured (`machine_client_id` unset); a
 *                strict no-op so behavior is identical to before the feature.
 *  - `invalid` — configured, but no bearer or the token is not a valid machine
 *                access token (missing/malformed/expired/wrong pool-or-client).
 *  - `valid`   — a genuine machine access token; `hasScope` says whether it also
 *                carries the required resource-server scope.
 */
export interface MachineCheckResult {
  status: "off" | "invalid" | "valid";
  clientId?: string;
  hasScope?: boolean;
}

function getSecrets(req: Request): IAppSecrets | undefined {
  return req.app.get("secrets") as IAppSecrets | undefined;
}

function bearerToken(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Classify the request's bearer as a Cognito client-credentials ACCESS token for
 * the configured machine app client. Never throws for auth reasons (a verifier
 * rejection is `invalid`), never logs the token, and makes no AWS call when the
 * feature is off.
 */
export async function checkMachine(req: Request): Promise<MachineCheckResult> {
  const secrets = getSecrets(req);
  const machineClientId = secrets?.machine_client_id;
  if (!secrets || !machineClientId) {
    return { status: "off" };
  }

  const token = bearerToken(req);
  if (!token) {
    return { status: "invalid" };
  }

  let payload;
  try {
    payload = await verifyMachineAccessToken(
      token,
      secrets.cognito_user_pool_id,
      machineClientId
    );
  } catch {
    return { status: "invalid" };
  }

  const requiredScope = secrets.machine_scope?.trim() || DEFAULT_MACHINE_SCOPE;
  // Cognito grants scopes as a single space-delimited `scope` string.
  const scopes =
    typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : [];

  return {
    status: "valid",
    clientId: machineClientId,
    hasScope: scopes.includes(requiredScope),
  };
}
