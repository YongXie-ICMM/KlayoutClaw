/**
 * Adversarial regression test for qb-opus48 feedback issue #16:
 * the nanodevice planner emitted `command` strings whose arg shapes did not
 * match the target scripts' argparse (image passed positionally instead of
 * --image; footprint missing --source/--target/--bottom; transform using a
 * nonexistent --detect-dir and missing --detections/--image/--pixel-size).
 *
 * Data-driven, NOT keyword-matching: for every emitted command we parse the
 * REAL argparse signature out of the target .py file and assert
 *   (a) every required=True flag appears in the command, and
 *   (b) no --flag in the command is absent from the script's argparse.
 * Either side drifting fails the test — so it cannot be satisfied by a
 * trivial or hardcoded template.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerNanodeviceTools } from "../src/tools/klayout/nanodevice.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function extractCommands(code: string): string[] {
  const re = /"command":\s*"((?:[^"\\]|\\.)*)"/g;
  const cmds: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) cmds.push(JSON.parse('"' + m[1] + '"'));
  return cmds;
}

function scriptSig(pyRelPath: string): { required: Set<string>; all: Set<string> } {
  const src = readFileSync(join(ROOT, pyRelPath), "utf8");
  const all = new Set<string>();
  const required = new Set<string>();
  const re = /add_argument\(\s*['"](--[a-z0-9-]+)['"]([^)]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    all.add(m[1]);
    if (/required\s*=\s*True/.test(m[2])) required.add(m[1]);
  }
  return { required, all };
}

function flagsInCommand(cmd: string): string[] {
  return (cmd.match(/--[a-z0-9-]+/g) ?? []);
}

function scriptPathInCommand(cmd: string): string | null {
  const m = cmd.match(/(skills\/\S+?\.py)/);
  return m ? m[1] : null;
}

describe("nanodevice planner command templates match script argparse (issue #16)", () => {
  const tools = registerNanodeviceTools();
  const planners = tools.filter((t) =>
    ["align", "detect", "combine"].some((g) => t.name.includes(`flakedetect_${g}`)),
  );

  it("collects planner commands from align/detect/combine", () => {
    expect(planners.length).toBe(3);
  });

  for (const tool of (["align", "detect", "combine"] as const)) {
    it(`every ${tool} command satisfies its script's required+allowed flags`, () => {
      const t = planners.find((p) => p.name.includes(`flakedetect_${tool}`))!;
      const code = t.generateCode({});
      const cmds = extractCommands(code);
      expect(cmds.length).toBeGreaterThan(0);

      let validated = 0;
      for (const cmd of cmds) {
        const py = scriptPathInCommand(cmd);
        if (!py) continue; // not a python-script command
        const abs = join(ROOT, py);
        if (!existsSync(abs)) continue; // script not present in this checkout
        const sig = scriptSig(py);
        if (sig.all.size === 0) continue; // script uses positionals only
        // guard: a broken scriptSig regex would make (a) vacuous.
        expect(sig.required.size, `no required flags parsed for ${py}`).toBeGreaterThan(0);
        validated++;

        const used = flagsInCommand(cmd);

        // (a) all required flags present
        for (const req of sig.required) {
          expect(used, `command for ${py} is missing required ${req}: ${cmd}`)
            .toContain(req);
        }
        // (b) no flag the script does not define (catches --detect-dir)
        for (const f of used) {
          expect(sig.all.has(f), `command for ${py} passes unknown flag ${f}: ${cmd}`)
            .toBe(true);
        }
      }
      // a renamed/missing script must not silently zero out coverage.
      expect(validated, `no script-bearing commands validated for ${tool}`)
        .toBeGreaterThanOrEqual(2);
    });
  }

  it("detect graphene --mirror branch emits a known --mirror flag", () => {
    const t = planners.find((p) => p.name.includes("flakedetect_detect"))!;
    const code = t.generateCode({ mirror: true });
    const cmds = extractCommands(code);
    const graphene = cmds.find((c) => c.includes("graphene.py"))!;
    expect(graphene).toBeDefined();
    expect(graphene).toContain("--mirror");
    // and --mirror must be a real flag of graphene.py
    const sig = scriptSig("skills/nanodevice_flakedetect_detect/scripts/graphene.py");
    expect(sig.all.has("--mirror")).toBe(true);
  });
});
