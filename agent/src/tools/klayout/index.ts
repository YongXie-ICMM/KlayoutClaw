/**
 * Register all KLayout domain tool groups.
 * Returns a flat array of all domain tools with namespaced names.
 */

import type { NamespacedTool } from "../../mcp/types.js";
import { registerGeometryTools } from "./geometry.js";
import { registerDisplayTools } from "./display.js";
import { registerImageTools } from "./image.js";
import { registerVisualTools } from "./visual.js";
import { registerNanodeviceTools } from "./nanodevice.js";

/**
 * Register all domain tools from all groups.
 * Each tool has a `generateCode` method for pya code generation.
 */
export function registerAllDomainTools(): (NamespacedTool & { generateCode: (args: Record<string, unknown>) => string })[] {
  return [
    ...registerGeometryTools(),
    ...registerDisplayTools(),
    ...registerImageTools(),
    ...registerVisualTools(),
    ...registerNanodeviceTools(),
  ];
}
