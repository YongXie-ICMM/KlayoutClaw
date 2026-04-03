/**
 * KLayout nanodevice domain tools.
 * Placeholder registrations for: flakedetect, gdsalign, routing.
 * These tools call external Python scripts via bash rather than generating inline pya code.
 */

import type { NamespacedTool } from "../../mcp/types.js";

const PREFIX = "klayout";

interface CodeGenTool extends NamespacedTool {
  generateCode: (args: Record<string, unknown>) => string;
}

function makeNanoTool(
  group: string,
  toolName: string,
  description: string,
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>,
  required: string[],
  generateCode: (args: Record<string, unknown>) => string,
): CodeGenTool {
  return {
    name: `${PREFIX}_${group}_${toolName}`,
    originalName: toolName,
    serverKey: PREFIX,
    group,
    description,
    inputSchema: { type: "object" as const, properties, required },
    generateCode,
  };
}

export function registerNanodeviceTools(): CodeGenTool[] {
  return [
    // --- Flake Detection ---
    makeNanoTool(
      "nanodevice_flakedetect",
      "detect_stack",
      "Run the full van der Waals stack detection pipeline on microscope images.",
      {
        full_stack_image: { type: "string", description: "Path to the full stack microscope image" },
        bottom_part_image: { type: "string", description: "Path to the bottom part image (optional)" },
        top_part_image: { type: "string", description: "Path to the top part image (optional)" },
        output_dir: { type: "string", description: "Output directory for results" },
      },
      ["full_stack_image", "output_dir"],
      (args) => {
        return `
result = {"status": "ok", "note": "Flake detection requires external CV scripts. Use bash tool to run: python skills/nanodevice_flakedetect/scripts/core.py", "args": ${JSON.stringify(args)}}
`.trim();
      },
    ),

    // --- GDS Alignment ---
    makeNanoTool(
      "nanodevice_gdsalign",
      "align_to_gds",
      "Align microscope stack images to a GDS fabrication template using lithographic marker detection.",
      {
        image_path: { type: "string", description: "Path to microscope image" },
        gds_path: { type: "string", description: "Path to GDS template file" },
        output_dir: { type: "string", description: "Output directory" },
      },
      ["image_path", "gds_path", "output_dir"],
      (args) => {
        return `
result = {"status": "ok", "note": "GDS alignment requires external scripts. Use bash tool to run the alignment pipeline.", "args": ${JSON.stringify(args)}}
`.trim();
      },
    ),

    // --- Routing ---
    makeNanoTool(
      "nanodevice_routing",
      "place_pads",
      "Place bonding pads around the device.",
      {
        cell: { type: "string", description: "Cell name" },
        pad_size: { type: "number", description: "Pad size in microns" },
        pad_layer: { type: "integer", description: "Layer for pads" },
        pad_datatype: { type: "integer", description: "Datatype for pads" },
        num_pads: { type: "integer", description: "Number of pads" },
      },
      ["cell", "pad_layer", "pad_datatype", "num_pads"],
      (args) => {
        return `
result = {"status": "ok", "note": "Pad placement requires the routing skill scripts. Use bash tool to run: python skills/nanodevice_routing/scripts/place_pads.py", "args": ${JSON.stringify(args)}}
`.trim();
      },
    ),

    makeNanoTool(
      "nanodevice_routing",
      "route_leads",
      "Route leads from device contacts to bonding pads.",
      {
        cell: { type: "string", description: "Cell name" },
        pin_pairs: { type: "array", description: "Array of [pin_name, pad_index] pairs", items: { type: "array" } },
      },
      ["cell", "pin_pairs"],
      (args) => {
        return `
result = {"status": "ok", "note": "Lead routing requires the routing subprocess. Use klayout_native_auto_route for automated routing.", "args": ${JSON.stringify(args)}}
`.trim();
      },
    ),
  ];
}
