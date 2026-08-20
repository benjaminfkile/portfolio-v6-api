import type { IAppSecrets } from "../interfaces";
import type { UpstreamHandle } from "./upstream";
import {
  spotifyListenerHealthKey,
  type ListenerHealthRecord,
  type ListenerHealthState,
} from "./upstream";
import { resolveEncryptionKey } from "./serviceTokenStore";
import { getListenerCredential } from "./listenerCredentialStore";

/**
 * Truthful admin Spotify status contract — listener-only.
 *
 * Now-playing is driven entirely by the connect-listener (the dealer
 * websocket); the Spotify Web API polling path was removed. This contract
 * therefore reports only which source is authoritative and the listener's
 * health:
 *
 *   - `source`   - "listener" when the shared listener health record says the
 *                  dealer socket is `connected`, else "none".
 *   - `listener` - a curated snapshot of the connect-listener's shared health
 *                  record (task #118), degraded to `state: "unknown"` when
 *                  Redis is unreachable so any instance answers without a 5xx.
 */

/** Which source is authoritative for now-playing. */
export type SpotifySource = "listener" | "none";

/**
 * Lifecycle state of the connect-listener as surfaced on the status contract.
 * Extends `ListenerHealthState` with two cases that only exist at this layer:
 *   - `no_credential` - no `spotify_listener` (sp_dc) row is stored, so the
 *     listener cannot start.
 *   - `unknown`       - Redis is unreachable, so this instance cannot say what
 *     state the dealer socket is in (the supervisor runs on the leader only).
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
  source: SpotifySource;
  listener: SpotifyListenerStatus;
}

/**
 * Compute the truthful listener status. Reads the stored `spotify_listener`
 * credential presence (DB) and the Redis-backed shared listener health record
 * (task #118). Never throws: a partial read degrades to the safe answer, and
 * Redis unavailable degrades the listener to `state: "unknown"` rather than a
 * 5xx.
 */
export async function computeSpotifyStatus(
  secrets: IAppSecrets | undefined,
  upstream: UpstreamHandle | null
): Promise<SpotifyStatus> {
  const encryptionKey = resolveEncryptionKey(secrets);
  const listenerCredential = await getListenerCredential(encryptionKey).catch(
    () => null
  );

  const env = secrets?.node_env ?? "development";
  const redis = upstream?.redis ?? null;

  let listenerHealth: ListenerHealthRecord | null = null;
  // Distinguish a Redis read failure (-> "unknown") from a clean absence
  // (-> "idle", no record written yet). We read the key raw because the
  // shared helper swallows errors and returns null in BOTH cases.
  let listenerReadFailed = false;
  if (redis) {
    try {
      const raw = await redis.get(spotifyListenerHealthKey(env));
      listenerHealth = parseListenerHealth(raw);
    } catch {
      listenerReadFailed = true;
    }
  }

  // Listener state precedence:
  //   1. no credential stored          -> "no_credential"
  //   2. Redis unavailable/unreachable -> "unknown"
  //   3. shared health record set      -> its state verbatim
  //   4. credential present, Redis ok, -> "idle" (no record written yet)
  //      no record
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

  const source: SpotifySource =
    listenerState === "connected" ? "listener" : "none";

  return { source, listener };
}

/**
 * Parse a raw shared listener health record from Redis. A bare parse failure
 * yields `null` (the caller treats that as "no record yet"); the caller
 * catches the surrounding get() error separately so it can distinguish that
 * from an absent key.
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
