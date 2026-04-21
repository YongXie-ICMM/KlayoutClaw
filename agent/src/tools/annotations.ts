/**
 * Tool annotations for v0.4 (spec §1.5).
 * Classifies MCP tools as readonly, readwrite, or backgroundable.
 *
 * In plan mode, only tools with `readonly: true` are allowed. Everything
 * else (readwrite, missing annotation) is denied — see
 * `getReadOnlyForPlanMode` below for the accessor.
 */

import type { ToolAnnotation } from "../types/v04-contracts.js";

export type { ToolAnnotation } from "../types/v04-contracts.js";

/**
 * Static annotations for known KLayout MCP tools.
 *
 * Mutable on purpose — `TOOL_ANNOTATIONS.push(...)` is used by the
 * "annotation present but neither readonly nor readwrite" unit test and by
 * Group 2 future wiring that injects per-registration annotations.
 */
export const TOOL_ANNOTATIONS: ToolAnnotation[] = [
  // ── qlaybot-native tools (readonly) ────────────────────────────────────
  // v0.4.4 §3 / TH-7 — the `thinking` tool is a pure side-effect-free
  // scratchpad (spec TH-3); plan-mode classifies it readonly so it
  // remains callable during plan_drafting / plan_executing.
  { name: "thinking", readonly: true },

  // ── Native MCP tools (readonly) ────────────────────────────────────────
  { name: "screenshot", readonly: true },
  { name: "get_layout_info", readonly: true },
  { name: "route_inspect", readonly: true },
  { name: "validate_pixel_size", readonly: true },

  // ── Native MCP tools (readwrite) ───────────────────────────────────────
  { name: "create_layout", readwrite: true },
  { name: "execute_script", readwrite: true },
  { name: "save_layout", readwrite: true },
  { name: "auto_route", readwrite: true, backgroundable: true },
  { name: "close_layout_view", readwrite: true },
  // F2 — evaluate_design was previously classified readonly. Spec §1.5 flips
  // it to readwrite because it spawns a heavy subprocess we don't want agents
  // running during plan-mode exploration.
  { name: "evaluate_design", readwrite: true },

  // ── Geometry skill tools (readwrite) ───────────────────────────────────
  { name: "add_rect", readwrite: true },
  { name: "add_polygon", readwrite: true },
  { name: "add_path", readwrite: true },
  { name: "create_cell", readwrite: true },
  { name: "add_instance", readwrite: true },

  // ── Display skill tools (readwrite) ────────────────────────────────────
  { name: "toggle_layer", readwrite: true },
  { name: "show_only", readwrite: true },

  // ── Image skill tools (readwrite) ──────────────────────────────────────
  { name: "add_image", readwrite: true },
  { name: "list_images", readwrite: true },
  { name: "remove_image", readwrite: true },

  // ── Visual skill tools (readwrite) ─────────────────────────────────────
  { name: "capture", readwrite: true },

  // ── Nanodevice flakedetect tools (readwrite) ───────────────────────────
  { name: "flakedetect_align", readwrite: true },
  { name: "flakedetect_detect", readwrite: true },
  { name: "flakedetect_combine", readwrite: true },
  { name: "flakedetect_commit", readwrite: true },
  { name: "flakedetect_review", readwrite: true },

  // ── Nanodevice gdsalign tools (readwrite) ──────────────────────────────
  { name: "gdsalign_align_to_gds", readwrite: true },

  // ── Nanodevice routing tools (readwrite) ───────────────────────────────
  { name: "routing_place_pads", readwrite: true },
  { name: "routing_route_leads", readwrite: true },
  { name: "routing_clear_routes", readwrite: true },
];

/**
 * Strip a known KLayout tool-name prefix to get the canonical bare name used
 * as the key in `TOOL_ANNOTATIONS`.
 *
 * F1 (critical): `klayout_native_` MUST appear BEFORE the generic `klayout_`
 * catch-all. Otherwise the generic prefix strips `klayout_native_screenshot`
 * to `native_screenshot` — for which no annotation entry exists — and the
 * readonly native tools (`screenshot`, `get_layout_info`, `route_inspect`,
 * `validate_pixel_size`) would be denied in plan mode, making the feature
 * useless for KLayout exploration.
 */
export function canonicalToolName(registeredName: string): string {
  const PREFIXES = [
    "klayout_native_",
    "klayout_geometry_",
    "klayout_display_",
    "klayout_image_",
    "klayout_visual_",
    "klayout_nanodevice_",
    "klayout_",
  ];
  for (const p of PREFIXES) {
    if (registeredName.startsWith(p)) return registeredName.slice(p.length);
  }
  return registeredName;
}

/**
 * Plan-mode gate: decide whether a registered tool is allowed to execute
 * based on its static annotation. Deny-by-default: tools with no annotation
 * entry are blocked and the `reasons` array names the canonical lookup key.
 */
export function getReadOnlyForPlanMode(registeredName: string): {
  allowed: boolean;
  reasons: string[];
} {
  const canon = canonicalToolName(registeredName);
  const ann = TOOL_ANNOTATIONS.find((a) => a.name === canon);
  if (!ann) return { allowed: false, reasons: [`no annotation for "${canon}"`] };
  if (ann.readonly) return { allowed: true, reasons: [] };
  if (ann.readwrite) return { allowed: false, reasons: ["readwrite: true"] };
  return {
    allowed: false,
    reasons: ["annotation present but neither readonly nor readwrite"],
  };
}

/**
 * Return an icon representing the tool's annotation type.
 * Priority: readonly > readwrite > backgroundable.
 */
export function getToolIcon(ann: ToolAnnotation): string {
  if (ann.readonly) return "\u{1F440}"; // eyes
  if (ann.readwrite) return "\u{1F58A}\uFE0F"; // pen
  if (ann.backgroundable) return "\u26A1"; // lightning
  return "";
}
