/**
 * Tool annotations for v0.4.
 * Classifies MCP tools as readonly, readwrite, or backgroundable.
 */

import type { ToolAnnotation } from "../types/v04-contracts.js";

export type { ToolAnnotation } from "../types/v04-contracts.js";

/**
 * Static annotations for known KLayout MCP tools.
 */
export const TOOL_ANNOTATIONS: ToolAnnotation[] = [
  { name: "screenshot", readonly: true },
  { name: "get_layout_info", readonly: true },
  { name: "create_layout", readwrite: true },
  { name: "execute_script", readwrite: true },
  { name: "save_layout", readwrite: true },
  { name: "auto_route", readwrite: true, backgroundable: true },
  { name: "evaluate_design", readonly: true },
  { name: "validate_pixel_size", readonly: true },
];

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
