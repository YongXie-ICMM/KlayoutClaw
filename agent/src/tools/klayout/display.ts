/**
 * KLayout display domain tools.
 * Generate pya code for: toggle_layer, show_only.
 */

import type { NamespacedTool } from "../../mcp/types.js";

const GROUP = "display";
const PREFIX = "klayout";

interface CodeGenTool extends NamespacedTool {
  generateCode: (args: Record<string, unknown>) => string;
}

function makeTool(
  toolName: string,
  description: string,
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>,
  required: string[],
  generateCode: (args: Record<string, unknown>) => string,
): CodeGenTool {
  return {
    name: `${PREFIX}_${GROUP}_${toolName}`,
    originalName: toolName,
    serverKey: PREFIX,
    group: GROUP,
    description,
    inputSchema: { type: "object" as const, properties, required },
    generateCode,
  };
}

export function registerDisplayTools(): CodeGenTool[] {
  return [
    makeTool(
      "toggle_layer",
      "Toggle layer visibility. Mode: 'on', 'off', or 'toggle' (default).",
      {
        layer: { type: "integer", description: "Layer number" },
        datatype: { type: "integer", description: "Datatype number" },
        mode: { type: "string", description: "Visibility mode: on, off, or toggle (default: toggle)" },
      },
      ["layer", "datatype"],
      (args) => {
        const { layer, datatype } = args;
        const mode = (args.mode as string) ?? "toggle";
        return `
target_layer = ${layer}
target_dt = ${datatype}
mode = "${mode}"
found = False
lp_iter = _layout_view.begin_layers()
while not lp_iter.at_end():
    lp = lp_iter.current()
    if lp.source_layer == target_layer and lp.source_datatype == target_dt:
        found = True
        if mode == "on":
            lp.visible = True
        elif mode == "off":
            lp.visible = False
        else:
            lp.visible = not lp.visible
        _layout_view.set_layer_properties(lp_iter, lp)
        break
    lp_iter.next()
if not found:
    raise ValueError("Layer ${layer}/${datatype} not found in view")
result = {"status": "ok", "layer": target_layer, "datatype": target_dt, "visible": lp.visible}
`.trim();
      },
    ),

    makeTool(
      "show_only",
      "Show only specified layers, hide all others. Layers as array of [layer, datatype] pairs.",
      {
        layers: { type: "array", description: "Array of [layer, datatype] pairs to show", items: { type: "array" } },
      },
      ["layers"],
      (args) => {
        const layersJson = JSON.stringify(args.layers);
        return `
show_set = set(tuple(x) for x in ${layersJson})
changed = []
lp_iter = _layout_view.begin_layers()
while not lp_iter.at_end():
    lp = lp_iter.current()
    key = (lp.source_layer, lp.source_datatype)
    should_show = key in show_set
    if lp.visible != should_show:
        lp.visible = should_show
        _layout_view.set_layer_properties(lp_iter, lp)
        changed.append(list(key))
    lp_iter.next()
result = {"status": "ok", "showing": ${layersJson}, "changed": changed}
`.trim();
      },
    ),
  ];
}
