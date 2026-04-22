/**
 * TranscriptMarkerEmitter — qlaybot-owned per-session event emitter for
 * transcript markers (spec §4.7 Producer). Resilient dispatch: a throwing
 * subscriber never prevents later subscribers from receiving the marker,
 * and emit() itself never re-throws.
 */
import type { TranscriptMarker } from "./marker-types.js";

export type TranscriptMarkerListener = (marker: TranscriptMarker) => void;

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

  emit(event: "marker", marker: TranscriptMarker): void {
    if (event !== "marker") return;
    // Snapshot listeners so re-entrant on/off from inside a listener
    // cannot change the iteration.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(marker);
      } catch {
        // Resilient dispatch — one misbehaving consumer must not break
        // the chain for the others.
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
 * passing a primitive throws synchronously (the underlying WeakMap
 * rejects non-object keys with TypeError).
 */
export function setTranscriptMarkerEmitter(
  session: object,
  emitter: TranscriptMarkerEmitter,
): void {
  SESSION_EMITTER_REGISTRY.set(session, emitter);
}
