/**
 * KLayout visual domain tools.
 *
 * `klayout_visual_capture` is an **instruction-only** domain tool: it returns
 * a `workflow_plan` describing how to render the full GDS layout as a PNG via
 * the `visual` skill (`tools/gds_to_image.py`). The agent then executes the
 * two-step pipeline itself (save layout via execute_script, then run the
 * converter via bash).
 *
 *   klayout_visual_capture    — workflow_plan: save GDS + render via gdstk/matplotlib
 *   klayout_native_screenshot — current viewport as the user sees it (native MCP tool)
 */

import type { NamespacedTool } from "../../mcp/types.js";
import { pyLiteral } from "./nanodevice.js";

const GROUP = "visual";
const PREFIX = "klayout";

interface CodeGenTool extends NamespacedTool {
  generateCode: (args: Record<string, unknown>) => string;
}

export function registerVisualTools(): CodeGenTool[] {
  return [
    {
      name: `${PREFIX}_${GROUP}_capture`,
      originalName: "capture",
      serverKey: PREFIX,
      group: GROUP,
      description: [
        "Return a workflow_plan for rendering the full KLayout GDS layout as a PNG",
        "using gdstk + matplotlib (per-layer colors, legend, DPI control). This tool",
        "does NOT execute the render — it returns a plan that the agent must run",
        "itself via execute_script (to save the layout) and bash (to run the converter).",
        "This is distinct from `klayout_native_screenshot`, which captures the user's",
        "current viewport with KLayout's own layer colors and current pan/zoom.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          filepath: {
            type: "string",
            description: "Output PNG path (absolute recommended, e.g. /tmp/layout.png)",
          },
          dpi: {
            type: "integer",
            description: "Image DPI (default 200)",
          },
          gds_path: {
            type: "string",
            description: "Intermediate GDS path (default /tmp/klayoutclaw_capture.gds)",
          },
        },
        required: ["filepath"],
      },
      // Instruction-only: return a workflow_plan dict. The agent reads this
      // and runs the two listed steps itself — same pattern as the nanodevice
      // domain tools. See nanodevice.ts::instructionResult for the wrapper.
      generateCode: (args: Record<string, unknown>) => {
        const filepath = typeof args.filepath === "string" ? args.filepath : "/tmp/klayoutclaw_capture.png";
        const gdsPath = typeof args.gds_path === "string" ? args.gds_path : "/tmp/klayoutclaw_capture.gds";
        const dpi = typeof args.dpi === "number" ? args.dpi : 200;

        const plan = {
          type: "workflow_plan",
          action: "render_full_gds_to_png",
          skill: "visual",
          skill_doc: "skills/visual/SKILL.md",
          read_first: "Read skill_doc for per-layer color conventions and legend options.",
          why: "Produces a color-coded rendering of the ENTIRE GDS layout with a legend — not a viewport screenshot. Useful for debug and review.",
          distinct_from_native_screenshot:
            "For a screenshot of the user's current KLayout viewport (with native KLayout layer colors, current pan/zoom), call klayout_native_screenshot instead.",
          steps: {
            "1_save_layout": {
              via: "klayout_native_execute_script",
              code: `_layout.write(${JSON.stringify(gdsPath)})`,
              purpose: "Dump the live layout to a temp GDS file so the converter can read it.",
            },
            "2_render_png": {
              via: "bash",
              command: `python tools/gds_to_image.py ${JSON.stringify(gdsPath)} ${JSON.stringify(filepath)} ${dpi}`,
              fallback_command: `python ~/.klayout/pymacros/gds_to_image.py ${JSON.stringify(gdsPath)} ${JSON.stringify(filepath)} ${dpi}`,
              conda_env: "instrMCPdev",
              purpose: "Render the GDS to a PNG with per-layer colors and a legend.",
              requires: ["gdstk", "matplotlib"],
              timeout_seconds: 120,
            },
          },
          outputs: {
            png_path: filepath,
            gds_path: gdsPath,
            dpi: dpi,
          },
          args,
        };

        return `result = ${pyLiteral(plan)}`;
      },
    } as CodeGenTool,
  ];
}
