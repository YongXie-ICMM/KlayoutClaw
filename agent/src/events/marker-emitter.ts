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
