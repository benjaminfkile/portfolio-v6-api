import type { IAppSecrets } from "../interfaces";
import type { UpstreamHandle } from "./upstream";
import {
  readSpotifyHealth,
  readSpotifySuspension,
  type SpotifyHealthRecord,
  type SpotifySuspensionRecord,
} from "./upstream";
import {
  getSpotifyLastSuccessAtMs,
  getSpotifyLastError,
  getSpotifyBackoffUntilMs,
  getSpotifyBudgetExhaustedUntilMs,
} from "./spotifyService";
import type { BudgetState } from "./listener/apiBudget";
import {
  getStoredSpotifyToken,
  SPOTIFY_REFRESH_TOKEN_LIFETIME_MS,
} from "./spotifyTokenStore";
import { resolveEncryptionKey } from "./serviceTokenStore";
import { isSpotifyDisabled } from "./serviceSettingsStore";

/**
 * Truthful admin Spotify status contract — task #113.
 *
 * The admin panel builds its "connected / auth broken / rate limited / off"
 * UI against exactly this shape; the state derivation precedence is fixed and
 * MUST NOT be reordered:
 *
 *   disabled       > (operator toggle — off switch is authoritative)
 *   disconnected   > (no stored grant — token endpoint would 400 anyway)
 *   rate_limited   > (shared 429 record window active)
 *   auth_broken    > (last refresh returned invalid_grant)
 *   connected      > (everything else)
 *
 * `connected` is NEVER reported merely because credentials exist — the poller
 * must have observed something recent (a successful fetch or a non-fatal
 * failure like `other`) and no fatal state (429 / invalid_grant) can be
 * active. Missing observations degrade to `connected` only when a grant is
 * stored AND no active suspension is recorded.
 */

/** The five states the contract may report. */
export type SpotifyState =
  | "connected"
  | "auth_broken"
  | "rate_limited"
  | "disconnected"
  | "disabled";

/** Category of the most recent Spotify failure, as reported to the admin. */
export type SpotifyStatusErrorKind =
  | "invalid_grant"
  | "rate_limited"
  | "other";

/** The exact status contract; every field is present on every response. */
export interface SpotifyStatus {
  state: SpotifyState;
  last_success_at: string | null;
  last_error: { kind: SpotifyStatusErrorKind; at: string } | null;
  rate_limited_until: string | null;
  authorized_at: string | null;
  expires_at: string | null;
  /**
   * Task #120 - the daily Spotify Web API + token-endpoint call budget for
   * this environment. `used` is the count so far this window; `cap` is the
   * ceiling; `resets_at` is the ISO 8601 wall-clock (UTC) of the next reset.
   * Absent when the upstream handle carries no budget guard (unusual: the
   * bootstrap always installs one, but tests may hand-craft a partial
   * handle). Callers that need it are free to degrade to "unknown" on absence.
   */
  budget?: BudgetState;
}

/**
 * Compute the truthful status. Reads span three sources:
 *   - `service_settings` for the enable/disable flag (DB, shared).
 *   - `service_tokens` for authorized_at (DB, shared).
 *   - Redis-backed shared health/suspension records (task #96/#112), with an
 *     in-process mirror fallback so the endpoint keeps working when Redis is
 *     unwired (local dev / tests / a Redis blip).
 * Never throws — a partial read degrades to the safe answer under the
 * precedence rules above.
 */
export async function computeSpotifyStatus(
  secrets: IAppSecrets | undefined,
  upstream: UpstreamHandle | null,
  now: number = Date.now()
): Promise<SpotifyStatus> {
  const disabled = await isSpotifyDisabled().catch(() => false);

  const encryptionKey = resolveEncryptionKey(secrets);
  const stored = await getStoredSpotifyToken(encryptionKey).catch(() => null);

  const authorizedAt = stored ? stored.authorizedAt.toISOString() : null;
  const expiresAt = stored
    ? new Date(
        stored.authorizedAt.getTime() + SPOTIFY_REFRESH_TOKEN_LIFETIME_MS
      ).toISOString()
    : null;

  // ---- Sources ------------------------------------------------------------
  const env = secrets?.node_env ?? "development";
  const redis = upstream?.redis ?? null;

  let sharedHealth: SpotifyHealthRecord | null = null;
  let sharedSuspension: SpotifySuspensionRecord | null = null;
  if (redis) {
    sharedHealth = await readSpotifyHealth(redis, env).catch(() => null);
    sharedSuspension = await readSpotifySuspension(redis, env).catch(
      () => null
    );
  }

  // In-process mirror fallback (task #97 pattern) — when Redis is unwired /
  // errored, or when this instance is the leader that just observed the
  // truth locally, the process-local mirror is authoritative.
  const localSuccessMs = getSpotifyLastSuccessAtMs();
  const localErr = getSpotifyLastError();
  const localBackoffUntilMs = getSpotifyBackoffUntilMs();

  // Prefer the shared value when present; fall back to the local mirror.
  const lastSuccessAt =
    sharedHealth?.last_success_at ??
    (localSuccessMs != null ? new Date(localSuccessMs).toISOString() : null);

  const sharedErr = sharedHealth?.last_error ?? null;
  const errKind: SpotifyStatusErrorKind | null = sharedErr
    ? sharedErr.kind
    : localErr
    ? localErr.kind
    : null;
  const errAt: string | null = sharedErr
    ? sharedErr.at
    : localErr
    ? new Date(localErr.atMs).toISOString()
    : null;

  // Rate-limit deadline — the shared 429 record is the authoritative source
  // (its `suspended_until` matches the leader's backoff window). Fall back
  // to the local mirror so a Redis blip does not lose the fact of an active
  // 429 that this instance already observed. Task #120: a "budget" record
  // is functionally identical from the admin's perspective ("polling is
  // paused until X") so it also surfaces as rate_limited here until task
  // #122 splits the status contract; the budget field on the response
  // carries the machine-readable used/cap/resets_at for anything that needs
  // the finer distinction.
  const sharedPauseUntilMs =
    sharedSuspension &&
    (sharedSuspension.reason === "429" ||
      sharedSuspension.reason === "budget")
      ? Date.parse(sharedSuspension.suspended_until)
      : null;
  const localBudgetUntilMs = getSpotifyBudgetExhaustedUntilMs();
  const rateUntilMs = Number.isFinite(sharedPauseUntilMs as number)
    ? (sharedPauseUntilMs as number)
    : localBackoffUntilMs > 0
    ? localBackoffUntilMs
    : localBudgetUntilMs > 0
    ? localBudgetUntilMs
    : sharedErr?.kind === "rate_limited" && sharedErr.rate_limited_until
    ? Date.parse(sharedErr.rate_limited_until)
    : null;

  const rateLimitedUntil =
    rateUntilMs != null && Number.isFinite(rateUntilMs) && rateUntilMs > now
      ? new Date(rateUntilMs).toISOString()
      : null;

  // Task #120 - budget snapshot for the status contract. Never throws;
  // absence on the upstream handle degrades to no `budget` field.
  let budgetState: BudgetState | undefined;
  if (upstream?.apiBudget) {
    try {
      budgetState = await upstream.apiBudget.getState(now);
    } catch {
      budgetState = undefined;
    }
  }

  // ---- State derivation (precedence: disabled > disconnected > rate_limited
  //      > auth_broken > connected) --------------------------------------
  let state: SpotifyState;
  if (disabled) {
    state = "disabled";
  } else if (!stored) {
    state = "disconnected";
  } else if (rateLimitedUntil) {
    state = "rate_limited";
  } else if (errKind === "invalid_grant") {
    // Shared auth suspension also indicates auth_broken even when the health
    // record has not yet caught up (fresh install / no observations yet).
    state = "auth_broken";
  } else if (
    sharedSuspension?.reason === "auth" &&
    Date.parse(sharedSuspension.suspended_until) > now
  ) {
    state = "auth_broken";
  } else {
    state = "connected";
  }

  return {
    state,
    last_success_at: lastSuccessAt,
    last_error:
      errKind && errAt
        ? { kind: errKind, at: errAt }
        : null,
    rate_limited_until: rateLimitedUntil,
    authorized_at: authorizedAt,
    expires_at: expiresAt,
    ...(budgetState ? { budget: budgetState } : {}),
  };
}
