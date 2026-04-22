/**
 * Task 2.15 — Blocker Classifier (§4.5 normative classification table).
 *
 * Public API:
 *   classifyToolResult(toolName, result) → "recoverable" | "unrecoverable" | "not-in-scope"
 *   classifyWithPattern(toolName, result) → { classification, pattern, reason }
 *
 * The state machine consumes `classifyWithPattern` to produce
 * plan_execution_aborted{reason, tool, pattern, replan_count} markers. The
 * bare `classifyToolResult` helper is a thin projection for call sites that
 * only need the triage result (e.g. blocker-classifier unit tests).
 */
export type Classification =
  | "recoverable"
  | "unrecoverable"
  | "not-in-scope";

/** Shape matching the MCP envelope the harness actually sees. */
export interface ToolResultEnvelope {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface ClassificationResult {
  classification: Classification;
  /** Normative pattern identifier from §4.5. Empty for recoverable/not-in-scope. */
  pattern: string;
  /** Short human-readable reason; empty for recoverable/not-in-scope. */
  reason: string;
}

const IN_SCOPE_TOOLS = new Set<string>([
  "klayout_native_auto_route",
  "klayout_native_evaluate_design",
  "klayout_native_execute_script",
  "klayout_native_save_layout",
]);

const AUTO_ROUTE = "klayout_native_auto_route";
const EVALUATE_DESIGN = "klayout_native_evaluate_design";

/** Simple spec-pattern match used by §4.5: `/Server busy:/i`. */
const SERVER_BUSY_RE = /Server busy:/i;

/**
 * Narrowing classifier used by the state machine. Returns the raw
 * classification; callers who need `pattern`/`reason` should call
 * {@link classifyWithPattern} instead.
 */
export function classifyToolResult(
  toolName: string,
  result: ToolResultEnvelope,
): Classification {
  return classifyWithPattern(toolName, result).classification;
}

/**
 * Full classification with the §4.5 pattern identifier + a short
 * human reason. Pattern is empty ("") for recoverable / not-in-scope —
 * only unrecoverable classifications populate it (the marker shape in
 * §4.6 uses `pattern` only on plan_execution_aborted).
 */
export function classifyWithPattern(
  toolName: string,
  result: ToolResultEnvelope,
): ClassificationResult {
  // Row: tool outside the in-scope set → not-in-scope, no further inspection.
  if (!IN_SCOPE_TOOLS.has(toolName)) {
    return { classification: "not-in-scope", pattern: "", reason: "" };
  }

  // Row: exception envelope (isError:true). Match "Server busy:" → recoverable,
  // every other error text → unrecoverable with the generic "isError:true"
  // pattern from §4.5.
  if (result.isError === true) {
    const text = firstText(result);
    if (SERVER_BUSY_RE.test(text)) {
      return { classification: "recoverable", pattern: "", reason: "" };
    }
    return {
      classification: "unrecoverable",
      pattern: "isError:true",
      reason: `${toolName} returned an error envelope`,
    };
  }

  // Row: empty content array for an in-scope tool → unrecoverable (Overseer
  // decision (b): no signal is worse than a clear failure signal).
  if (result.content.length === 0) {
    return {
      classification: "unrecoverable",
      pattern: "isError:true",
      reason: `${toolName} returned an empty content envelope`,
    };
  }

  // execute_script / save_layout success envelopes carry no structured payload
  // classification rule per §4.5 — fall through to "recoverable".
  if (toolName !== AUTO_ROUTE && toolName !== EVALUATE_DESIGN) {
    return { classification: "recoverable", pattern: "", reason: "" };
  }

  // Parse the payload for tools that have a structured classification row.
  const text = firstText(result);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Overseer decision (a): unparseable payload from a plan-invalidating
    // tool is conservatively classified as unrecoverable.
    return {
      classification: "unrecoverable",
      pattern: "isError:true",
      reason: `${toolName} returned a malformed payload`,
    };
  }

  if (toolName === AUTO_ROUTE) {
    return classifyAutoRoute(payload);
  }

  // toolName === EVALUATE_DESIGN
  return classifyEvaluateDesign(payload);
}

function classifyAutoRoute(payload: unknown): ClassificationResult {
  if (!isObject(payload)) {
    return {
      classification: "unrecoverable",
      pattern: "isError:true",
      reason: "auto_route returned a non-object payload",
    };
  }
  const status = payload["status"];

  if (status === "failed") {
    return {
      classification: "unrecoverable",
      pattern: "auto_route:failed",
      reason: "auto_route reported status:failed",
    };
  }

  if (status === "partial") {
    const errors = Array.isArray(payload["errors"]) ? payload["errors"] : [];
    // Any error entry that does NOT start with "auto_map_resolution" counts
    // as a hard failure. Empty errors array or only auto-map notes → recoverable.
    const hasHardError = errors.some(
      (e) => typeof e === "string" && !e.startsWith("auto_map_resolution"),
    );
    if (hasHardError) {
      return {
        classification: "unrecoverable",
        pattern: "auto_route:partial_with_errors",
        reason: "auto_route partial with non-auto_map error entries",
      };
    }
    return { classification: "recoverable", pattern: "", reason: "" };
  }

  // status === "success" | "dry_run" | anything else not-failed/partial → recoverable.
  return { classification: "recoverable", pattern: "", reason: "" };
}

function classifyEvaluateDesign(payload: unknown): ClassificationResult {
  if (!isObject(payload) || !("overall" in payload)) {
    return {
      classification: "unrecoverable",
      pattern: "isError:true",
      reason: "evaluate_design payload missing `overall`",
    };
  }
  const overall = payload["overall"];
  if (typeof overall !== "number") {
    return {
      classification: "unrecoverable",
      pattern: "isError:true",
      reason: "evaluate_design `overall` is not a number",
    };
  }
  if (overall < 0.3) {
    return {
      classification: "unrecoverable",
      pattern: "evaluate_design:low_overall",
      reason: `evaluate_design overall=${overall} below 0.30 threshold`,
    };
  }
  return { classification: "recoverable", pattern: "", reason: "" };
}

function firstText(result: ToolResultEnvelope): string {
  const entry = result.content[0];
  if (entry && typeof entry.text === "string") return entry.text;
  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
