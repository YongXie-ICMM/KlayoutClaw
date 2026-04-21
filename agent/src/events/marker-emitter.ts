/**
 * TranscriptMarkerEmitter — qlaybot-owned per-session event emitter for
 * transcript markers (spec §4.7 Producer).
 *
 * A hand-rolled minimal emitter:
 *  - Single event name: "marker"
 *  - emit("marker", m) dispatches synchronously to every subscriber
 *  - Each subscriber is wrapped in try/swallow (resilient dispatch —
 *    mirrors the PlanManager._emit pattern at
 *    agent/src/planning/index.ts:227-236). A thrown subscriber never
 *    prevents later subscribers from receiving the marker, and emit()
 *    itself never re-throws.
 *  - No external deps — pure module, no Node EventEmitter.
 *
 * The marker argument is intentionally typed `unknown` at this layer so
 * the producer type (TranscriptMarker — defined in marker-types.ts) and
 * the transport layer remain decoupled. Consumers that need the narrowed
 * union import it from ./marker-types.js directly.
 */
export type TranscriptMarkerListener = (marker: unknown) => void;

export class TranscriptMarkerEmitter {
  /** Ordered list of subscribers. Registration order is preserved. */
  private listeners: TranscriptMarkerListener[] = [];

  /**
   * Subscribe to `"marker"` events. Returns void; use off() to
   * unsubscribe (or the unsubscribe helper returned by consumers such as
   * subscribeToSession).
   */
  on(event: "marker", listener: TranscriptMarkerListener): void {
    if (event !== "marker") return;
    this.listeners.push(listener);
  }

  /**
   * Remove a specific listener. Only the first occurrence of the given
   * reference is removed (matching Node EventEmitter semantics).
   */
  off(event: "marker", listener: TranscriptMarkerListener): void {
    if (event !== "marker") return;
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) {
      this.listeners.splice(idx, 1);
    }
  }

  /**
   * Dispatch the marker to every subscriber. A throwing subscriber does
   * NOT prevent later subscribers from receiving the marker, and emit()
   * itself never re-throws (spec §4.7 resilient dispatch).
   */
  emit(event: "marker", marker: unknown): void {
    if (event !== "marker") return;
    // Snapshot listeners before dispatch so re-entrant on/off from inside
    // a listener cannot change the iteration.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(marker);
      } catch {
        // Swallow subscriber errors — one misbehaving consumer must not
        // break the chain for the others.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-session registry (Task 0.2)
// ---------------------------------------------------------------------------
//
// WeakMap<AgentSession, TranscriptMarkerEmitter> — parallels the
// PlanSlugCache pattern from PM-12. The registry never auto-creates an
// emitter; consumers must call setTranscriptMarkerEmitter first. Keys
// are session object references (WeakMap semantics), so a primitive key
// throws at registration time.
//
// We deliberately leave the key type as `object` rather than binding to
// the SDK's `AgentSession` so the module stays import-cheap and doesn't
// pull the SDK's full surface just to type a map key.

const SESSION_EMITTER_REGISTRY: WeakMap<object, TranscriptMarkerEmitter> =
  new WeakMap();

/**
 * Look up the emitter bound to a session. Returns `undefined` if none is
 * registered — callers must handle that case (typically by constructing
 * one and registering via `setTranscriptMarkerEmitter`). This getter
 * NEVER auto-creates an emitter.
 */
export function getTranscriptMarkerEmitter(
  session: object,
): TranscriptMarkerEmitter | undefined {
  return SESSION_EMITTER_REGISTRY.get(session);
}

/**
 * Register the emitter on the session. WeakMap keys must be objects —
 * passing a primitive throws synchronously (guards against a regression
 * that swaps the WeakMap for a plain Map keyed by JSON).
 */
export function setTranscriptMarkerEmitter(
  session: object,
  emitter: TranscriptMarkerEmitter,
): void {
  // Node's native WeakMap.set already throws a TypeError for primitive
  // keys, but we guard explicitly so the error message points at THIS
  // function rather than at a WeakMap internal trace. Accept objects and
  // functions (WeakMap semantics).
  if (
    session === null ||
    (typeof session !== "object" && typeof session !== "function")
  ) {
    throw new TypeError(
      "setTranscriptMarkerEmitter: session key must be an object (WeakMap registry)",
    );
  }
  SESSION_EMITTER_REGISTRY.set(session, emitter);
}
