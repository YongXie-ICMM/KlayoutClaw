/**
 * KLayout image domain tools.
 * Generate pya code for: add_image, list_images, remove_image.
 */

import type { NamespacedTool } from "../../mcp/types.js";

const GROUP = "image";
const PREFIX = "klayout";

interface CodeGenTool extends NamespacedTool {
  generateCode: (args: Record<string, unknown>) => string;
}

function makeTool(
  toolName: string,
  description: string,
  properties: Record<string, { type: string; description?: string }>,
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

export function registerImageTools(): CodeGenTool[] {
  return [
    makeTool(
      "add_image",
      "Load a reference image into KLayout as a background overlay. Coordinates in microns.",
      {
        filepath: { type: "string", description: "Absolute path to image file (JPG, PNG, BMP)" },
        pixel_size: { type: "number", description: "Microns per pixel (default: 1.0)" },
        x: { type: "number", description: "X position offset in microns (default: 0)" },
        y: { type: "number", description: "Y position offset in microns (default: 0)" },
        center: { type: "boolean", description: "Center image at the given position (default: false)" },
      },
      ["filepath"],
      (args) => {
        const filepath = args.filepath as string;
        const ps = args.pixel_size ?? 1.0;
        const x = args.x ?? 0;
        const y = args.y ?? 0;
        const center = args.center ?? false;
        return `
import os
filepath = "${filepath}"
if not os.path.exists(filepath):
    raise FileNotFoundError(f"Image not found: {filepath}")
view, layout, cell = _get_or_create_view()
img = pya.Image(filepath)
img.visible = True
ps = ${ps}
x_off = ${x}
y_off = ${y}
if ${center}:
    w_um = img.width() * ps
    h_um = img.height() * ps
    x_off = ${x} - w_um / 2.0
    y_off = ${y} - h_um / 2.0
img.trans = pya.DCplxTrans(ps, 0, False, pya.DVector(x_off, y_off))
view.insert_image(img)
view.zoom_fit()
result = {"status": "ok", "id": img.id(), "file": filepath, "pixels": [img.width(), img.height()], "pixel_size": ps, "position": [x_off, y_off]}
`.trim();
      },
    ),

    makeTool(
      "list_images",
      "List all background images currently loaded in KLayout.",
      {},
      [],
      () => {
        return `
view = _layout_view
images = []
for img in view.each_image():
    images.append({"id": img.id(), "filename": img.filename, "visible": img.visible, "width": img.width(), "height": img.height()})
result = {"status": "ok", "images": images, "count": len(images)}
`.trim();
      },
    ),

    makeTool(
      "remove_image",
      "Remove a background image from KLayout by its ID.",
      {
        image_id: { type: "integer", description: "Image ID to remove" },
      },
      ["image_id"],
      (args) => {
        return `
view = _layout_view
target_id = ${args.image_id}
found = False
for img in view.each_image():
    if img.id() == target_id:
        view.erase_image(img.id())
        found = True
        break
if not found:
    raise ValueError(f"Image with id {target_id} not found")
result = {"status": "ok", "removed_id": target_id}
`.trim();
      },
    ),
  ];
}
