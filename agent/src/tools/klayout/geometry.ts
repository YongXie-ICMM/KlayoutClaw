/**
 * KLayout geometry domain tools.
 * Generate pya code for: add_rect, add_polygon, add_path, create_cell, add_instance.
 */

import type { NamespacedTool } from "../../mcp/types.js";

const GROUP = "geometry";
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
    inputSchema: {
      type: "object" as const,
      properties,
      required,
    },
    generateCode,
  };
}

export function registerGeometryTools(): CodeGenTool[] {
  return [
    makeTool(
      "add_rect",
      "Add a rectangle to a cell. Coordinates in microns.",
      {
        cell: { type: "string", description: "Cell name" },
        layer: { type: "integer", description: "Layer number" },
        datatype: { type: "integer", description: "Datatype number" },
        x1: { type: "number", description: "Left X in microns" },
        y1: { type: "number", description: "Bottom Y in microns" },
        x2: { type: "number", description: "Right X in microns" },
        y2: { type: "number", description: "Top Y in microns" },
      },
      ["cell", "layer", "datatype", "x1", "y1", "x2", "y2"],
      (args) => {
        const { cell, layer, datatype, x1, y1, x2, y2 } = args;
        return `
dbu = _layout.dbu
c = _layout.cell("${cell}")
if c is None:
    raise ValueError("Cell '${cell}' not found")
li = _layout.layer(${layer}, ${datatype})
c.shapes(li).insert(pya.Box(int(${x1}/dbu), int(${y1}/dbu), int(${x2}/dbu), int(${y2}/dbu)))
result = {"status": "ok", "cell": "${cell}", "layer": ${layer}, "datatype": ${datatype}, "bbox": [${x1}, ${y1}, ${x2}, ${y2}]}
`.trim();
      },
    ),

    makeTool(
      "add_polygon",
      "Add a polygon to a cell. Points as array of [x,y] pairs in microns.",
      {
        cell: { type: "string", description: "Cell name" },
        layer: { type: "integer", description: "Layer number" },
        datatype: { type: "integer", description: "Datatype number" },
        points: { type: "array", description: "Array of [x,y] coordinate pairs in microns", items: { type: "array" } },
      },
      ["cell", "layer", "datatype", "points"],
      (args) => {
        const { cell, layer, datatype, points } = args;
        const ptsJson = JSON.stringify(points);
        return `
dbu = _layout.dbu
c = _layout.cell("${cell}")
if c is None:
    raise ValueError("Cell '${cell}' not found")
li = _layout.layer(${layer}, ${datatype})
pts_raw = ${ptsJson}
pts = [pya.Point(int(p[0]/dbu), int(p[1]/dbu)) for p in pts_raw]
c.shapes(li).insert(pya.Polygon(pts))
result = {"status": "ok", "cell": "${cell}", "num_points": len(pts)}
`.trim();
      },
    ),

    makeTool(
      "add_path",
      "Add a path to a cell. Points as array of [x,y] pairs in microns.",
      {
        cell: { type: "string", description: "Cell name" },
        layer: { type: "integer", description: "Layer number" },
        datatype: { type: "integer", description: "Datatype number" },
        width: { type: "number", description: "Path width in microns" },
        points: { type: "array", description: "Array of [x,y] coordinate pairs in microns", items: { type: "array" } },
      },
      ["cell", "layer", "datatype", "width", "points"],
      (args) => {
        const { cell, layer, datatype, width, points } = args;
        const ptsJson = JSON.stringify(points);
        return `
dbu = _layout.dbu
c = _layout.cell("${cell}")
if c is None:
    raise ValueError("Cell '${cell}' not found")
li = _layout.layer(${layer}, ${datatype})
pts_raw = ${ptsJson}
pts = [pya.Point(int(p[0]/dbu), int(p[1]/dbu)) for p in pts_raw]
c.shapes(li).insert(pya.Path(pts, int(${width}/dbu)))
result = {"status": "ok", "cell": "${cell}", "width": ${width}, "num_points": len(pts)}
`.trim();
      },
    ),

    makeTool(
      "create_cell",
      "Create a new cell in the layout.",
      {
        name: { type: "string", description: "Cell name" },
      },
      ["name"],
      (args) => {
        const { name } = args;
        return `
cell = _layout.create_cell("${name}")
result = {"status": "ok", "name": cell.name, "cell_index": cell.cell_index()}
`.trim();
      },
    ),

    makeTool(
      "add_instance",
      "Place a cell instance (child) inside another cell (parent). Position in microns.",
      {
        parent: { type: "string", description: "Parent cell name" },
        child: { type: "string", description: "Child cell name to instantiate" },
        x: { type: "number", description: "X position in microns (default: 0)" },
        y: { type: "number", description: "Y position in microns (default: 0)" },
      },
      ["parent", "child"],
      (args) => {
        const { parent, child } = args;
        const x = args.x ?? 0;
        const y = args.y ?? 0;
        return `
dbu = _layout.dbu
parent_cell = _layout.cell("${parent}")
child_cell = _layout.cell("${child}")
if parent_cell is None:
    raise ValueError("Parent cell '${parent}' not found")
if child_cell is None:
    raise ValueError("Child cell '${child}' not found")
trans = pya.Trans(pya.Point(int(${x}/dbu), int(${y}/dbu)))
parent_cell.insert(pya.CellInstArray(child_cell.cell_index(), trans))
result = {"status": "ok", "parent": "${parent}", "child": "${child}", "x": ${x}, "y": ${y}}
`.trim();
      },
    ),
  ];
}
