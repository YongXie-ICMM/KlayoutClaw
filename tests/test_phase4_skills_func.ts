/**
 * Functional tests for buildSkillsSection.
 *
 * Run with: npx tsx tests/test_phase4_skills_func.ts
 * (from the agent/ directory so relative imports resolve)
 *
 * Prints PASS/FAIL lines that the Python test harness parses.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildSkillsSection } from "../agent/src/prompts/sections/skills.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Non-empty string when scanning real KlayoutClaw/skills/
// ---------------------------------------------------------------------------
{
  // PROJECT_ROOT/skills/ has real SKILL.md files with YAML frontmatter
  const projectRoot = join(import.meta.dirname!, "..");
  const skillsDir = join(projectRoot, "skills");
  const result = buildSkillsSection([skillsDir]);
  assert(
    typeof result === "string" && result.length > 0,
    "non-empty for real skills",
  );
}

// ---------------------------------------------------------------------------
// Test 2: Empty string for empty/nonexistent directory
// ---------------------------------------------------------------------------
{
  const emptyDir = mkdtempSync(join(tmpdir(), "skills-empty-"));
  try {
    const result = buildSkillsSection([emptyDir]);
    assert(result === "", "empty for empty dir");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 3: Deduplicates by name — first found wins
// ---------------------------------------------------------------------------
{
  const dir1 = mkdtempSync(join(tmpdir(), "skills-dup1-"));
  const dir2 = mkdtempSync(join(tmpdir(), "skills-dup2-"));
  try {
    // Create skill "test_skill" in both dirs with different descriptions
    const skill1Dir = join(dir1, "test_skill");
    const skill2Dir = join(dir2, "test_skill");
    mkdirSync(skill1Dir);
    mkdirSync(skill2Dir);

    writeFileSync(
      join(skill1Dir, "SKILL.md"),
      "---\nname: test_skill\ndescription: FIRST description\n---\n# Test\n",
    );
    writeFileSync(
      join(skill2Dir, "SKILL.md"),
      "---\nname: test_skill\ndescription: SECOND description\n---\n# Test\n",
    );

    const result = buildSkillsSection([dir1, dir2]);
    assert(
      result.includes("FIRST description") && !result.includes("SECOND description"),
      "deduplicates by name",
    );
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 4: Malformed YAML frontmatter (missing --- delimiters) should be
//         gracefully skipped, not crash
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "skills-malformed-"));
  try {
    const skillDir = join(dir, "bad_yaml_skill");
    mkdirSync(skillDir);
    // Write a SKILL.md with NO --- delimiters — just raw text
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "name: bad_yaml_skill\ndescription: This has no frontmatter delimiters\n# Body\nSome content.\n",
    );
    // Must not throw — should silently skip the malformed file
    const result = buildSkillsSection([dir]);
    assert(
      typeof result === "string",
      "malformed frontmatter gracefully skipped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 5: SKILL.md with missing name field should be handled gracefully
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "skills-noname-"));
  try {
    const skillDir = join(dir, "nameless_skill");
    mkdirSync(skillDir);
    // Valid frontmatter delimiters but no "name" field
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\ndescription: A skill with no name field\n---\n# Nameless\nBody text.\n",
    );
    // Must not throw
    const result = buildSkillsSection([dir]);
    assert(
      typeof result === "string",
      "missing name field handled",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 6: Output format verification — result should contain the skill name
//         from the frontmatter
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "skills-format-"));
  try {
    const skillDir = join(dir, "format_check_skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: format_check_skill\ndescription: Verify output format\n---\n# Format\nBody.\n",
    );
    const result = buildSkillsSection([dir]);
    assert(
      result.includes("format_check_skill"),
      "output contains skill name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 7: Nonexistent directory path should return empty string, not crash
// ---------------------------------------------------------------------------
{
  const nonexistentPath = join(tmpdir(), "this-directory-does-not-exist-" + Date.now());
  const result = buildSkillsSection([nonexistentPath]);
  assert(
    result === "",
    "nonexistent dir returns empty",
  );
}

// ---------------------------------------------------------------------------
// Test 8: Integration — buildSystemPrompt includes skill scanning output
//         when skillsDirs is provided
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "skills-integration-"));
  try {
    const skillDir = join(dir, "integration_probe_skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: integration_probe_skill\ndescription: Probe for integration wiring\n---\n# Integration Probe\nThis skill exists only to verify buildSystemPrompt wiring.\n",
    );

    // Import buildSystemPrompt and PromptMode from the prompts index
    const { buildSystemPrompt, PromptMode } = await import(
      "../agent/src/prompts/index.js"
    );

    const prompt = buildSystemPrompt({
      mode: PromptMode.Full,
      workspaceDir: dir, // use temp dir as workspace (context section will be empty)
      toolNames: [],
      connectedServers: [],
      skillsDirs: [dir],
    });

    assert(
      typeof prompt === "string" && prompt.includes("integration_probe_skill"),
      "integration",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Exit with failure code if any test failed
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll functional tests passed.");
}
