/**
 * TDD regression tests for image.ts path escaping + bool conversion.
 *
 *   BUG #19: File paths interpolated raw into Python string literals —
 *            quotes and backslashes break the generated code.
 *   BUG #6:  JS boolean (true/false) emitted instead of Python (True/False).
 *
 * Tests verify both structural (helper functions exist) and behavioral
 * (generated code is correct) aspects.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerImageTools } from "../src/tools/klayout/image.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function srcFile(relPath: string): string {
  return readFileSync(join(__dirname, "..", "src", relPath), "utf-8");
}

// ============================================================
// Helper function exports
// ============================================================

describe("image.ts helper functions", () => {
  it("exports pyEscape that escapes backslashes and double quotes", async () => {
    const mod = await import("../src/tools/klayout/image.js");
    const pyEscape = (mod as Record<string, unknown>).pyEscape as (
      s: string,
    ) => string;
    expect(typeof pyEscape).toBe("function");

    // Backslashes doubled
    expect(pyEscape("C:\\Users\\test\\image.png")).toBe(
      "C:\\\\Users\\\\test\\\\image.png",
    );

    // Double quotes escaped
    expect(pyEscape('/tmp/my "file".png')).toBe('/tmp/my \\"file\\".png');

    // Both together
    expect(pyEscape('C:\\path\\"weird"')).toBe('C:\\\\path\\\\\\"weird\\"');

    // Clean path unchanged
    expect(pyEscape("/tmp/normal.png")).toBe("/tmp/normal.png");
  });

  it("exports pyBool that converts JS boolean to Python boolean string", async () => {
    const mod = await import("../src/tools/klayout/image.js");
    const pyBool = (mod as Record<string, unknown>).pyBool as (
      v: boolean,
    ) => string;
    expect(typeof pyBool).toBe("function");

    expect(pyBool(true)).toBe("True");
    expect(pyBool(false)).toBe("False");
  });
});

// ============================================================
// Generated code correctness
// ============================================================

describe("add_image generated code", () => {
  const tools = registerImageTools();
  const addImage = tools.find((t) => t.originalName === "add_image")!;

  it("escapes double quotes in filepath", () => {
    const code = addImage.generateCode({
      filepath: '/tmp/my "file".png',
      pixel_size: 1.0,
      x: 0,
      y: 0,
      center: false,
    });
    // The filepath in the generated Python must have escaped quotes
    expect(code).toContain('filepath = "/tmp/my \\"file\\".png"');
    // Must NOT contain unescaped quotes that would break the string
    expect(code).not.toMatch(/filepath = "\/tmp\/my "file"\.png"/);
  });

  it("escapes backslashes in filepath", () => {
    const code = addImage.generateCode({
      filepath: "C:\\Users\\test\\image.png",
      pixel_size: 1.0,
      x: 0,
      y: 0,
      center: false,
    });
    // Backslashes must be doubled in Python string
    expect(code).toContain(
      'filepath = "C:\\\\Users\\\\test\\\\image.png"',
    );
  });

  it("emits Python True/False for center boolean, not JS true/false", () => {
    const codeTrue = addImage.generateCode({
      filepath: "/tmp/test.png",
      pixel_size: 1.0,
      x: 0,
      y: 0,
      center: true,
    });
    expect(codeTrue).toContain("if True:");
    expect(codeTrue).not.toContain("if true:");

    const codeFalse = addImage.generateCode({
      filepath: "/tmp/test.png",
      pixel_size: 1.0,
      x: 0,
      y: 0,
      center: false,
    });
    expect(codeFalse).toContain("if False:");
    expect(codeFalse).not.toContain("if false:");
  });

  it("handles filepath with both quotes and backslashes", () => {
    const code = addImage.generateCode({
      filepath: 'C:\\my "data"\\img.png',
      pixel_size: 1.0,
      x: 0,
      y: 0,
      center: true,
    });
    expect(code).toContain(
      'filepath = "C:\\\\my \\"data\\"\\\\img.png"',
    );
    expect(code).toContain("if True:");
  });

  it("generated code with clean path produces correct Python", () => {
    const code = addImage.generateCode({
      filepath: "/tmp/clean.png",
      pixel_size: 0.5,
      x: 10,
      y: 20,
      center: false,
    });
    expect(code).toContain('filepath = "/tmp/clean.png"');
    expect(code).toContain("if False:");
    // No JS booleans anywhere in generated code
    expect(code).not.toMatch(/\bif true:/);
    expect(code).not.toMatch(/\bif false:/);
  });
});

// ============================================================
// Structural: generateCode must use pyEscape / pyBool
// ============================================================

describe("image.ts structural: helpers used at interpolation points", () => {
  it("add_image code generator calls pyEscape for filepath interpolation", () => {
    const src = srcFile("tools/klayout/image.ts");
    // The section between "add_image" and the next makeTool (or end) must use pyEscape
    const addImageSection = src.split('"add_image"')[1]?.split("makeTool")[0];
    expect(addImageSection).toBeTruthy();
    expect(addImageSection).toMatch(/pyEscape/);
  });

  it("add_image code generator calls pyBool for center interpolation", () => {
    const src = srcFile("tools/klayout/image.ts");
    const addImageSection = src.split('"add_image"')[1]?.split("makeTool")[0];
    expect(addImageSection).toBeTruthy();
    expect(addImageSection).toMatch(/pyBool/);
  });
});
