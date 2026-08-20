/**
 * Spotify listener supervisor (task #118 in the listener series).
 *
 * Owns the dealer websocket lifecycle for one process:
 *   - starts the underlying `DealerListener` ONLY on the current leader
 *     (the existing Redis lease is what gates it, exactly one dealer socket
 *     per environment),
 *   - keeps the listener idle while there is no stored `spotify_listener`
 *     credential, and (re)starts it when the admin saves one - detected by
 *     watching `service_tokens.updated_at` at most once per minute, the same
 *     cheap DB read the auth-resume check uses for the Spotify polling lane,
 *   - on every listener event: writes the shared now-playing snapshot to
 *     Redis (same key the pollers use, so nowPlayingRouter needs zero
 *     changes) and publishes to the gateway realtime hub,
 *   - while a track is playing, re-writes the snapshot every 20s with
 *     `progress_ms` advanced locally from the last event timestamp so
 *     polling-fallback viewers see progress move without any extra Spotify
 *     traffic,
 *   - publishes listener health (`state`, `last_event_at`, `last_error`) into
 *     the shared Redis health record on every transition so non-leaders can
 *     read it for the status endpoint.
 *
 * This module is Redis-and-DB agnostic: everything it touches beyond the
 * DealerListener is injected. That keeps it trivial to unit-test with fakes
 * and free of Express/Postgres coupling.
 */

import type { RedisClient } from "./redisClient";
import {
  writeSnapshot,
  writeListenerHealth,
  type ListenerHealthErrorKind,
  type ListenerHealthRecord,
  type ListenerHealthState,
} from "./snapshotStore";
import {
  publish,
  type RealtimePublisherConfig,
} from "./realtimePublisher";
import type {
  DealerListener,
  DealerState,
} from "../listener/dealerClient";
import type { NowPlaying, NowPlayingTrack } from "../spotifyService";

/**
 * How often the supervisor re-reads `service_tokens.updated_at` for the
 * `spotify_listener` row (the cheap DB check that catches an admin paste).
 * Matches the Spotify polling lane's `SPOTIFY_AUTH_RESUME_CHECK_MS`, both by
 * default and by intent - a fresh credential should surface within one
 * minute, and the read is DB-cheap.
 */
export const LISTENER_CREDENTIAL_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Cadence at which we re-write the snapshot with a locally-advanced
 * `progress_ms` while a track is playing. 20s per the task spec: fast enough
 * that polling-fallback viewers see the progress bar move; slow enough that
 * a paused-then-resumed track never overwrites a genuine cluster push in a
 * misleading way (the next real cluster event overrides the tick).
 */
export const LISTENER_PROGRESS_TICK_MS = 20 * 1000;

/**
 * Ticks scheduled by `setInterval` / `setTimeout` return whatever the runtime
 * provides. We deliberately do not import Node's `Timeout` type here so
 * tests can pass their own timer implementations without lying about types.
 */
export type SupervisorTimerHandle = unknown;

/**
 * Everything the supervisor needs from the outside world. `logger`,
 * `setInterval` / `clearInterval`, and `now` are all injectable so the
 * unit tests can drive time deterministically without touching real timers.
 */
export interface ListenerSupervisorDeps {
  /** Environment name that prefixes every Redis key. */
  env: string;
  /**
   * Cluster Redis client, or null when Redis is unavailable. When null the
   * supervisor short-circuits every start/stop into a no-op - a missing
   * shared snapshot store means we cannot serve the listener path at all,
   * and the polling lane already handles that degrade.
   */
  redis: RedisClient | null;
  /**
   * Realtime publish config (same struct the poll loop uses). When the token
   * or gateway URL is missing, `publish` is a no-op internally.
   */
  publisher: RealtimePublisherConfig;
  /**
   * Factory that builds a `DealerListener` given a stored `sp_dc` cookie.
   * The supervisor owns wiring the listener's callbacks (event/state).
   * Kept as a factory so the supervisor can rebuild the listener on every
   * credential change without worrying about state carried over from the
   * previous cookie.
   */
  createListener: (spDc: string) => DealerListener;
  /**
   * Resolve the currently-stored `sp_dc` cookie for `spotify_listener`.
   * Returns null when absent / decrypt failed / DB errored. On null the
   * supervisor keeps the listener idle.
   */
  loadCredential: () => Promise<string | null>;
  /**
   * Durably persist the latest curated now-playing payload (the DB last-known
   * store). Called on every event and progress tick so `GET /api/now-playing`
   * has a durable answer after a cold start / Redis flush. Must never throw
   * (the store swallows its own errors); optional so tests can omit it.
   */
  persistLastNowPlaying?: (payload: NowPlaying) => Promise<void>;
  /**
   * Cheap DB read of `service_tokens.updated_at` for `spotify_listener`.
   * Called at most once per `credentialCheckIntervalMs`. Returns null on
   * absence or DB error (treated as "no change").
   */
  getCredentialUpdatedAt: () => Promise<Date | null>;
  /** Overridable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Overridable setInterval. Defaults to global setInterval. */
  setInterval?: (fn: () => void, ms: number) => SupervisorTimerHandle;
  /** Overridable clearInterval. Defaults to global clearInterval. */
  clearInterval?: (h: SupervisorTimerHandle) => void;
  /** Structured log sink. Called with a level and a status/timing message. */
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * Override the credential check cadence. Tests override to sub-second.
   */
  credentialCheckIntervalMs?: number;
  /** Override the progress-tick cadence. Tests override to sub-second. */
  progressTickIntervalMs?: number;
}

export interface ListenerSupervisor {
  /**
   * Called by the leader-lease `onLeadershipGain` callback. Kicks off the
   * credential-watch loop and, if a credential is present, immediately
   * starts the dealer listener. Idempotent - a second call while already
   * running is a no-op.
   */
  onLeadershipGain(): Promise<void>;
  /**
   * Called by the leader-lease `onLostLease` / shutdown path. Stops the
   * dealer listener, tears down the credential watch and progress tick, and
   * flushes a final `state: idle` health record so non-leaders see the
   * listener has stepped down.
   */
  onLeadershipLoss(): Promise<void>;
  /**
   * True while the listener is `connected`. Wired into the Spotify polling
   * lane's `isListenerConnected` dep so the polling lane returns
   * `skip-listener-active` and does not fetch redundantly.
   */
  isListenerConnected(): boolean;
  /**
   * The listener's current state, exposed for tests + the admin status
   * endpoint. Always safe to call.
   */
  getListenerState(): DealerState | "idle";
  /**
   * Fully tear down the supervisor. Called from `bootstrapUpstream`'s
   * `stop()` path. Idempotent.
   */
  stop(): Promise<void>;
}

const IDLE_STATE: DealerState = "idle";

/**
 * Map the dealer's five internal states to the categorized `state` field on
 * the shared listener health record. Currently 1:1; kept as a separate
 * function so a future divergence (e.g. a distinct `starting` bucket)
 * doesn't require touching every writer.
 */
function toHealthState(state: DealerState): ListenerHealthState {
  return state;
}

/**
 * Build the supervisor. Nothing runs until `onLeadershipGain` is called,
 * exactly as the leader-lease callback expects.
 */
export function createListenerSupervisor(
  deps: ListenerSupervisorDeps
): ListenerSupervisor {
  const now = deps.now ?? (() => Date.now());
  const setIntervalFn =
    deps.setInterval ??
    ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown);
  const clearIntervalFn =
    deps.clearInterval ??
    ((h: SupervisorTimerHandle) =>
      clearInterval(h as ReturnType<typeof setInterval>));
  const log = deps.logger ?? (() => undefined);
  const credentialIntervalMs =
    deps.credentialCheckIntervalMs ?? LISTENER_CREDENTIAL_CHECK_INTERVAL_MS;
  const progressIntervalMs =
    deps.progressTickIntervalMs ?? LISTENER_PROGRESS_TICK_MS;

  // Lifecycle state - `active` is true between onLeadershipGain and
  // onLeadershipLoss / stop.
  let active = false;
  // The currently-running dealer listener (null while idle or between
  // credential rotations).
  let listener: DealerListener | null = null;
  let listenerState: DealerState = IDLE_STATE;
  // Snapshot of the `service_tokens.updated_at` we last observed for the
  // `spotify_listener` row. Null means "never seen a row" so any real
  // timestamp triggers a start.
  let lastSeenCredentialUpdatedAt: Date | null = null;
  // The most recent (sp_dc) fingerprint we started the listener with, so a
  // subsequent restart under an unchanged cookie is a no-op. We do NOT keep
  // the plaintext sp_dc here - just an updated_at snapshot suffices to
  // detect a fresh admin paste.
  let credentialCheckTimer: SupervisorTimerHandle | null = null;
  let progressTimer: SupervisorTimerHandle | null = null;
  // The last NowPlaying we saw from the dealer, plus the wall-clock we
  // observed it at. Used by the 20s progress tick to advance `progress_ms`
  // without any Spotify traffic.
  let lastPlayingEvent: { payload: NowPlaying; observedAtMs: number } | null =
    null;
  // Last error we surfaced to the health record. `null` means the last
  // observation was clean.
  let lastError: {
    kind: ListenerHealthErrorKind;
    atMs: number;
  } | null = null;
  let lastEventAtMs: number | null = null;
  // Unsubscribers for the current listener's event / state callbacks; cleared
  // during teardown so the callbacks never fire against a dead supervisor.
  let unsubscribers: Array<() => void> = [];

  async function writeHealth(): Promise<void> {
    if (!deps.redis) return;
    const record: ListenerHealthRecord = {
      state: toHealthState(listenerState),
      last_event_at:
        lastEventAtMs != null ? new Date(lastEventAtMs).toISOString() : null,
      last_error: lastError
        ? {
            kind: lastError.kind,
            at: new Date(lastError.atMs).toISOString(),
          }
        : null,
    };
    await writeListenerHealth(deps.redis, deps.env, record);
  }

  async function writeAndPublishNowPlaying(payload: NowPlaying): Promise<void> {
    // Persist the durable last-known FIRST, independent of Redis, so a cold
    // start / Redis flush can still serve the last track on load. The store
    // swallows its own errors, so this never fails the event path.
    if (deps.persistLastNowPlaying) {
      await deps.persistLastNowPlaying(payload);
    }
    if (!deps.redis) return;
    await writeSnapshot(deps.redis, deps.env, "now-playing", payload);
    await publish(deps.publisher, {
      topic: "now-playing",
      event: "snapshot",
      data: payload,
    });
  }

  function stopProgressTicker(): void {
    if (progressTimer != null) {
      clearIntervalFn(progressTimer);
      progressTimer = null;
    }
  }

  function ensureProgressTicker(): void {
    if (progressTimer != null) return;
    progressTimer = setIntervalFn(() => {
      void tickProgress();
    }, progressIntervalMs);
  }

  /**
   * Called every `progressIntervalMs` while the last event was a playing
   * track. Advances `progress_ms` from the observed timestamp and writes
   * the resulting snapshot. Never hits Spotify.
   */
  async function tickProgress(): Promise<void> {
    if (!active || !lastPlayingEvent) return;
    const evt = lastPlayingEvent;
    if (evt.payload.playing !== true) return;
    const track = evt.payload.track;
    if (track.progress_ms == null) return;
    const elapsed = Math.max(0, now() - evt.observedAtMs);
    let progress = track.progress_ms + elapsed;
    if (track.duration_ms != null && progress > track.duration_ms) {
      // Clamp to the track duration - once we pass it we simply hold; the
      // next real cluster event (paused, or a new track) will supersede
      // this synthetic snapshot.
      progress = track.duration_ms;
    }
    const advanced: NowPlayingTrack = { ...track, progress_ms: progress };
    const payload: NowPlaying = { playing: true, track: advanced };
    try {
      await writeAndPublishNowPlaying(payload);
    } catch (err) {
      log(
        "warn",
        `progress-tick write failed: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
  }

  async function handleEvent(payload: NowPlaying): Promise<void> {
    if (!active) return;
    lastEventAtMs = now();
    // A clean event resets the last-error mirror: the most recent
    // observation IS the cluster push, and any prior transient failure is
    // no longer the current story.
    lastError = null;
    if (payload.playing === true) {
      lastPlayingEvent = { payload, observedAtMs: now() };
      ensureProgressTicker();
    } else {
      lastPlayingEvent = null;
      stopProgressTicker();
    }
    try {
      await writeAndPublishNowPlaying(payload);
    } catch (err) {
      log(
        "warn",
        `event write failed: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
    // Refresh the health record so non-leaders see the fresh `last_event_at`.
    await writeHealth().catch((err) =>
      log(
        "warn",
        `health write failed: ${err instanceof Error ? err.message : "unknown"}`
      )
    );
  }

  async function handleStateChange(next: DealerState): Promise<void> {
    listenerState = next;
    if (next === "credential_dead") {
      lastError = { kind: "invalid_cookie", atMs: now() };
      // Stop the progress ticker: no more events until an admin paste. The
      // credential watch will restart the listener when it observes a fresh
      // updated_at.
      stopProgressTicker();
      lastPlayingEvent = null;
    } else if (next === "backoff") {
      // Every backoff transition is a `transient` failure from our health
      // consumers' perspective (an invalid_cookie would have gone to
      // credential_dead instead). Do not overwrite a `invalid_cookie` that
      // is still current.
      if (!lastError || lastError.kind !== "invalid_cookie") {
        lastError = { kind: "transient", atMs: now() };
      }
    } else if (next === "connected") {
      // A successful (re)connect clears any lingering transient error - the
      // most recent observation is a healthy handshake.
      if (lastError && lastError.kind === "transient") {
        lastError = null;
      }
    }
    await writeHealth().catch((err) =>
      log(
        "warn",
        `health write failed: ${err instanceof Error ? err.message : "unknown"}`
      )
    );
  }

  function tearDownCurrentListener(): void {
    for (const unsub of unsubscribers) {
      try {
        unsub();
      } catch {
        // Nothing to do - the callback bookkeeping is best-effort.
      }
    }
    unsubscribers = [];
    if (listener) {
      try {
        listener.stop();
      } catch {
        // stop() is documented as idempotent, but if the dealer implementation
        // ever changed we do not want the teardown to throw.
      }
      listener = null;
    }
    listenerState = IDLE_STATE;
    lastPlayingEvent = null;
    stopProgressTicker();
  }

  async function startListenerFromCredential(): Promise<void> {
    const spDc = await deps.loadCredential().catch((err) => {
      log(
        "warn",
        `loadCredential failed: ${err instanceof Error ? err.message : "unknown"}`
      );
      return null;
    });
    if (!spDc) {
      // No credential yet - stay idle and refresh health so consumers see it.
      tearDownCurrentListener();
      await writeHealth().catch(() => undefined);
      return;
    }
    // Tear down any previous listener (e.g. one running against the OLD
    // credential) so a rotation always starts a fresh dealer.
    tearDownCurrentListener();
    const created = deps.createListener(spDc);
    listener = created;
    unsubscribers.push(
      created.onEvent((payload) => {
        void handleEvent(payload);
      })
    );
    unsubscribers.push(
      created.onStateChange((state) => {
        void handleStateChange(state);
      })
    );
    try {
      created.start();
    } catch (err) {
      log(
        "warn",
        `listener start failed: ${err instanceof Error ? err.message : "unknown"}`
      );
      lastError = { kind: "transient", atMs: now() };
      await writeHealth().catch(() => undefined);
    }
  }

  /**
   * Check whether the stored credential has changed since the last poll.
   * On any observed change: rebuild the listener (which restarts even from
   * `credential_dead`, per the dealer client's contract). Non-throwing.
   */
  async function checkCredentialForChanges(): Promise<void> {
    if (!active) return;
    const observed = await deps
      .getCredentialUpdatedAt()
      .catch(() => null);
    const changed =
      (observed === null) !== (lastSeenCredentialUpdatedAt === null) ||
      (observed !== null &&
        lastSeenCredentialUpdatedAt !== null &&
        observed.getTime() !== lastSeenCredentialUpdatedAt.getTime());
    if (!changed) return;
    lastSeenCredentialUpdatedAt = observed;
    log(
      "info",
      `listener credential updated_at changed; ${observed ? "restarting" : "stopping"} dealer`
    );
    await startListenerFromCredential();
  }

  function ensureCredentialWatch(): void {
    if (credentialCheckTimer != null) return;
    credentialCheckTimer = setIntervalFn(() => {
      void checkCredentialForChanges();
    }, credentialIntervalMs);
  }

  function stopCredentialWatch(): void {
    if (credentialCheckTimer != null) {
      clearIntervalFn(credentialCheckTimer);
      credentialCheckTimer = null;
    }
  }

  async function onLeadershipGain(): Promise<void> {
    if (active) return;
    active = true;
    // Prime the credential-updated-at snapshot with whatever is stored now
    // so a genuine subsequent change triggers a rebuild - not the initial
    // observation (which we treat as "start against what's stored").
    lastSeenCredentialUpdatedAt = await deps
      .getCredentialUpdatedAt()
      .catch(() => null);
    ensureCredentialWatch();
    await startListenerFromCredential();
  }

  async function onLeadershipLoss(): Promise<void> {
    if (!active) return;
    active = false;
    stopCredentialWatch();
    tearDownCurrentListener();
    lastError = null;
    lastEventAtMs = null;
    lastSeenCredentialUpdatedAt = null;
    // Flush an `idle` health record so any consumer / freshly-elected leader
    // sees that the listener is not currently owned by this instance.
    await writeHealth().catch(() => undefined);
  }

  async function stop(): Promise<void> {
    await onLeadershipLoss();
  }

  return {
    onLeadershipGain,
    onLeadershipLoss,
    isListenerConnected: () => listenerState === "connected",
    getListenerState: () => listenerState,
    stop,
  };
}
