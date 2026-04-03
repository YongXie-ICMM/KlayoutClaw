/**
 * KLayout visual domain tools.
 * Generate pya code for: capture (screenshot via MCP native tool).
 */

import type { NamespacedTool } from "../../mcp/types.js";

const GROUP = "visual";
const PREFIX = "klayout";

interface CodeGenTool extends NamespacedTool {
  generateCode: (args: Record<string, unknown>) => string;
}

export function registerVisualTools(): CodeGenTool[] {
  // capture is handled as a native tool call (screenshot), not execute_script
  // So we register it as a domain tool that maps to the native screenshot tool
  return [
    {
      name: `${PREFIX}_${GROUP}_capture`,
      originalName: "capture",
      serverKey: PREFIX,
      group: GROUP,
      description: "Capture the current KLayout viewport as a PNG screenshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          width: { type: "integer", description: "Image width in pixels (default: 800)" },
          height: { type: "integer", description: "Image height in pixels (default: 600)" },
        },
        required: [],
      },
      // capture delegates to screenshot native tool, but we generate a code wrapper
      // that saves to a temp file and returns the path
      generateCode: (args: Record<string, unknown>) => {
        return `
import tempfile, os
# Use the screenshot MCP tool instead of execute_script for actual capture
# This code path is a fallback that saves layout to GDS then converts
filepath = os.path.join(tempfile.gettempdir(), "klayoutclaw_capture.gds")
_layout.write(filepath)
result = {"status": "ok", "gds_path": filepath, "note": "Use klayout_native_screenshot for viewport capture"}
`.trim();
      },
    } as CodeGenTool,
  ];
}
