import type { IAppSecrets } from "../interfaces";
import type { UpstreamHandle } from "./upstream";
import {
  readSpotifyHealth,
  readSpotifySuspension,
  spotifyListenerHealthKey,
  type ListenerHealthRecord,
  type ListenerHealthState,
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
import { getListenerCredential } from "./listenerCredentialStore";
import { isSpotifyDisabled } from "./serviceSettingsStore";

/**
 * Truthful admin Spotify status contract - task #113, extended by task #122.
 *
 * The admin panel builds its "connected / auth broken / rate limited / off"
 * UI against exactly this shape; the polling-state derivation precedence is
 * fixed and MUST NOT be reordered:
 *
 *   disabled       > (operator toggle - off switch is authoritative)
 *   disconnected   > (no stored grant - token endpoint would 400 anyway)
 *   rate_limited   > (shared 429 record window active)
 *   auth_broken    > (last refresh returned invalid_grant)
 *   connected      > (everything else)
 *
 * `connected` (polling) is NEVER reported merely because credentials exist -
 * the poller must have observed something recent (a successful fetch or a
 * non-fatal failure like `other`) and no fatal state (429 / invalid_grant)
 * can be active. Missing observations degrade to `connected` only when a
 * grant is stored AND no active suspension is recorded.
 *
 * Task #122 adds three top-level fields WITHOUT altering the 5-state
 * polling `state` contract:
 *
 *   - `source` - which lane is currently authoritative for now-playing:
 *       "listener" when the shared listener health record says connected,
 *       "polling"  when the polling lane is eligible to fetch (grant
 *                  stored, not disabled, not suspended), else
 *       "none".
 *   - `listener` - a curated snapshot of the connect-listener's shared
 *       health record (task #118 / #4-of-9), degraded to `state: "unknown"`
 *       when Redis is unreachable so any instance answers without a 5xx.
 *   - `budget`  - the daily Web API call budget (task #120 / #6-of-9),
 *       always present (BudgetState object or null when neither Redis nor
 *       the in-process fallback has any data).
 */

/** The five polling-lane states the contract may report. */
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

/**
 * Which lane the status contract reports as the current now-playing source.
 *   "listener" - the dealer websocket is holding a live cluster subscription.
 *   "polling"  - the polling fallback is eligible to fetch (grant stored,
 *                not disabled, not rate-limited, not auth-broken).
 *   "none"     - neither lane is producing events right now.
 */
export type SpotifySource = "listener" | "polling" | "none";

/**
 * Lifecycle state of the connect-listener as surfaced on the status
 * contract. Extends `ListenerHealthState` (task #118) with two derived
 * cases that only make sense at the status layer:
 *   - `no_credential` - no `spotify_listener` (sp_dc) row is stored, so
 *     the listener cannot even start.
 *   - `unknown`       - Redis is unreachable AND no in-process signal is
 *     available (the listener supervisor runs on the leader only), so this
 *     instance cannot say what state the dealer socket is in.
 */
export type ListenerReportedState =
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "credential_dead"
  | "no_credential"
  | "unknown";

/** Curated listener snapshot on the status contract. */
export interface SpotifyListenerStatus {
  state: ListenerReportedState;
  /** ISO 8601 of the last cluster event we processed, or null. */
  last_event_at: string | null;
  /** Category of the last observed listener error, or null. */
  error_kind: string | null;
  /** True iff a `spotify_listener` (sp_dc) row is stored. */
  credential_present: boolean;
}

/** The exact status contract; every field is present on every response. */
export interface SpotifyStatus {
  state: SpotifyState;
  /** Task #122 - which lane is authoritative for now-playing right now. */
  source: SpotifySource;
  /** Task #122 - curated snapshot of the connect-listener's health. */
  listener: SpotifyListenerStatus;
  last_success_at: string | null;
  last_error: { kind: SpotifyStatusErrorKind; at: string } | null;
  rate_limited_until: string | null;
  authorized_at: string | null;
  expires_at: string | null;
  /**
   * Task #120 - the daily Spotify Web API + token-endpoint call budget for
   * this environment. `used` is the count so far this window; `cap` is the
   * ceiling; `resets_at` is the ISO 8601 wall-clock (UTC) of the next reset.
   * Task #122 makes this field ALWAYS present (BudgetState object or null
   * when the upstream handle carries no budget guard and no in-process
   * fallback has data), so the admin UI can render a stable slot.
   */
  budget: BudgetState | null;
}

/**
 * Compute the truthful status. Reads span four sources:
 *   - `service_settings` for the enable/disable flag (DB, shared).
 *   - `service_tokens` for authorized_at + listener credential presence
 *     (DB, shared).
 *   - Redis-backed shared health/suspension records (task #96/#112/#118),
 *     with an in-process mirror fallback so the endpoint keeps working
 *     when Redis is unwired (local dev / tests / a Redis blip).
 *   - The task #120 daily-call budget (Redis-backed with in-process
 *     fallback).
 * Never throws - a partial read degrades to the safe answer under the
 * precedence rules above. Redis unavailable degrades the listener to
 * state `unknown` rather than surfacing an error.
 */
export async function computeSpotifyStatus(
  secrets: IAppSecrets | undefined,
  upstream: UpstreamHandle | null,
  now: number = Date.now()
): Promise<SpotifyStatus> {
  const disabled = await isSpotifyDisabled().catch(() => false);

  const encryptionKey = resolveEncryptionKey(secrets);
  const stored = await getStoredSpotifyToken(encryptionKey).catch(() => null);
  const listenerCredential = await getListenerCredential(encryptionKey).catch(
    () => null
  );

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
  let listenerHealth: ListenerHealthRecord | null = null;
  // Track a Redis read failure on the listener key separately from a clean
  // absence, so we can degrade to `unknown` (Redis outage) instead of `idle`
  // (no record written yet). We do a raw `redis.get` here rather than going
  // through `readListenerHealth` because that helper swallows errors and
  // returns `null` in BOTH cases; the status endpoint needs to distinguish.
  let listenerReadFailed = false;
  if (redis) {
    sharedHealth = await readSpotifyHealth(redis, env).catch(() => null);
    sharedSuspension = await readSpotifySuspension(redis, env).catch(
      () => null
    );
    try {
      const raw = await redis.get(spotifyListenerHealthKey(env));
      listenerHealth = parseListenerHealth(raw);
    } catch {
      listenerReadFailed = true;
    }
  }

  // In-process mirror fallback (task #97 pattern) - when Redis is unwired /
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

  // Rate-limit deadline - the shared 429 record is the authoritative source
  // (its `suspended_until` matches the leader's backoff window). Fall back
  // to the local mirror so a Redis blip does not lose the fact of an active
  // 429 that this instance already observed. Task #120: a "budget" record
  // is functionally identical from the admin's perspective ("polling is
  // paused until X") so it also surfaces as rate_limited here; the budget
  // field on the response carries the machine-readable used/cap/resets_at
  // for anything that needs the finer distinction.
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
  // absence on the upstream handle degrades to a null `budget` field so the
  // slot stays stable for the admin UI.
  let budgetState: BudgetState | null = null;
  if (upstream?.apiBudget) {
    try {
      budgetState = await upstream.apiBudget.getState(now);
    } catch {
      budgetState = null;
    }
  }

  // ---- State derivation (polling lane; precedence: disabled > disconnected
  //      > rate_limited > auth_broken > connected) ----------------------
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

  // ---- Listener status (task #122) --------------------------------------
  // Precedence:
  //   1. no credential stored             -> "no_credential"
  //   2. Redis unavailable (unset OR      -> "unknown" (the listener
  //      unreachable)                        supervisor cannot run / this
  //                                          instance cannot see it)
  //   3. shared health record set         -> its state verbatim
  //   4. otherwise (credential present,   -> "idle" (no supervisor has
  //      Redis reachable, no record yet)     ever written a record - fresh
  //                                          install / stopped leader)
  let listenerState: ListenerReportedState;
  if (!listenerCredential) {
    listenerState = "no_credential";
  } else if (!redis || listenerReadFailed) {
    listenerState = "unknown";
  } else if (listenerHealth) {
    listenerState = listenerHealth.state;
  } else {
    listenerState = "idle";
  }

  const listener: SpotifyListenerStatus = {
    state: listenerState,
    last_event_at: listenerHealth?.last_event_at ?? null,
    error_kind: listenerHealth?.last_error?.kind ?? null,
    credential_present: listenerCredential != null,
  };

  // ---- Source derivation (task #122) ------------------------------------
  // The listener wins whenever it is `connected` - that IS the primary
  // source. Otherwise the polling lane is the source iff it is eligible to
  // fetch: state === "connected" already encodes "grant stored AND not
  // disabled AND not rate_limited AND not auth_broken". Everything else is
  // "none".
  let source: SpotifySource;
  if (listenerState === "connected") {
    source = "listener";
  } else if (state === "connected") {
    source = "polling";
  } else {
    source = "none";
  }

  return {
    state,
    source,
    listener,
    last_success_at: lastSuccessAt,
    last_error:
      errKind && errAt
        ? { kind: errKind, at: errAt }
        : null,
    rate_limited_until: rateLimitedUntil,
    authorized_at: authorizedAt,
    expires_at: expiresAt,
    budget: budgetState,
  };
}

/**
 * Parse a raw shared listener health record from Redis. Mirrors the shape
 * validation in `readListenerHealth` but never swallows the surrounding
 * Redis error - a bare parse failure yields `null` (which the caller
 * treats as "no record yet"); the caller catches the surrounding get()
 * error separately so we can distinguish that from an absent key.
 */
function parseListenerHealth(raw: string | null): ListenerHealthRecord | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as ListenerHealthRecord;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.state === "string" &&
      isListenerState(parsed.state)
    ) {
      return {
        state: parsed.state,
        last_event_at:
          typeof parsed.last_event_at === "string"
            ? parsed.last_event_at
            : null,
        last_error:
          parsed.last_error &&
          typeof parsed.last_error === "object" &&
          typeof parsed.last_error.kind === "string" &&
          typeof parsed.last_error.at === "string" &&
          (parsed.last_error.kind === "invalid_cookie" ||
            parsed.last_error.kind === "transient")
            ? {
                kind: parsed.last_error.kind,
                at: parsed.last_error.at,
              }
            : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isListenerState(v: string): v is ListenerHealthState {
  return (
    v === "idle" ||
    v === "connecting" ||
    v === "connected" ||
    v === "backoff" ||
    v === "credential_dead"
  );
}
