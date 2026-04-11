#!/usr/bin/env python
"""Phase 4 Overseer tests: Documentation + Integration + Skill Scanning.

These tests validate that:
- 4A: Existing SKILL.md files have been updated with required guidance
- 4B: qlaybot workspace files (TOOLS/RULES) have new content
- 4C: KlayoutClaw docs (tools.md, skills.md, CLAUDE.md) are updated
- 4D: TypeScript source files have required annotations and skill scanning
- 4D2: buildSkillsSection functional tests (separate .ts file, run via npx tsx)

No KLayout instance is needed. All tests read actual files and assert on content.
"""

import os
import re
import subprocess

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_DIR = os.path.join(PROJECT_ROOT, "agent")
SKILLS_DIR = os.path.join(PROJECT_ROOT, "skills")

# File paths under test
DOCS_TOOLS = os.path.join(PROJECT_ROOT, "docs", "tools.md")
DOCS_SKILLS = os.path.join(PROJECT_ROOT, "docs", "skills.md")
CLAUDE_MD = os.path.join(PROJECT_ROOT, "CLAUDE.md")
WS_TOOLS = os.path.join(AGENT_DIR, "workspace", "TOOLS.md")
WS_RULES = os.path.join(AGENT_DIR, "workspace", "RULES.md")
GDSALIGN_SKILL = os.path.join(SKILLS_DIR, "nanodevice_gdsalign", "SKILL.md")
ROUTING_SKILL = os.path.join(SKILLS_DIR, "nanodevice_routing", "SKILL.md")
ANNOTATIONS_TS = os.path.join(AGENT_DIR, "src", "tools", "annotations.ts")
BACKGROUND_TS = os.path.join(AGENT_DIR, "src", "background", "index.ts")
SKILLS_TS = os.path.join(AGENT_DIR, "src", "prompts", "sections", "skills.ts")
PROMPTS_INDEX_TS = os.path.join(AGENT_DIR, "src", "prompts", "index.ts")
AGENT_TS = os.path.join(AGENT_DIR, "src", "agent.ts")

# Functional TypeScript test file
SKILLS_FUNC_TEST = os.path.join(PROJECT_ROOT, "tests", "test_phase4_skills_func.ts")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read(path):
    """Read a file and return its contents. Asserts the file exists."""
    assert os.path.isfile(path), f"File not found: {path}"
    with open(path, "r") as f:
        return f.read()


# ===========================================================================
# 4A: Update existing SKILL.md files
# ===========================================================================

class TestGdsalignSkillUpdate:
    """nanodevice_gdsalign/SKILL.md must contain pixel_size validation guidance."""

    def test_mentions_pixel_size(self):
        content = _read(GDSALIGN_SKILL)
        assert "pixel_size" in content.lower() or "pixel size" in content.lower(), (
            "SKILL.md must mention pixel_size validation"
        )

    def test_common_pixel_size_005(self):
        content = _read(GDSALIGN_SKILL)
        assert "0.05" in content, "Must list 0.05 um/px as common pixel_size value"

    def test_common_pixel_size_0087(self):
        content = _read(GDSALIGN_SKILL)
        assert "0.087" in content, "Must list 0.087 um/px as common pixel_size value"

    def test_common_pixel_size_01(self):
        content = _read(GDSALIGN_SKILL)
        assert "0.1" in content, "Must list 0.1 um/px as common pixel_size value"

    def test_common_pixel_size_025(self):
        content = _read(GDSALIGN_SKILL)
        assert "0.25" in content, "Must list 0.25 um/px as common pixel_size value"

    def test_common_pixel_size_05(self):
        content = _read(GDSALIGN_SKILL)
        assert "0.5" in content, "Must list 0.5 um/px as common pixel_size value"


class TestRoutingSkillUpdate:
    """nanodevice_routing/SKILL.md must clarify layer format."""

    def test_mentions_ld_format(self):
        content = _read(ROUTING_SKILL)
        # Must explicitly mention the "L/D" string format
        assert re.search(r'["\']?\d+/\d+["\']?', content), (
            "SKILL.md must show layer format as 'L/D' string (e.g. '1/0')"
        )

    def test_layer_format_is_string(self):
        content = _read(ROUTING_SKILL)
        lower = content.lower()
        assert "string" in lower and ("l/d" in lower or "layer/datatype" in lower), (
            "SKILL.md must explicitly state layer format is a string, not an array"
        )


# ===========================================================================
# 4B: Update qlaybot workspace files
# ===========================================================================

class TestWorkspaceTools:
    """agent/workspace/TOOLS.md must mention new tools."""

    def test_mentions_evaluate_design(self):
        content = _read(WS_TOOLS)
        assert "evaluate_design" in content, (
            "TOOLS.md must mention evaluate_design tool"
        )

    def test_mentions_validate_pixel_size(self):
        content = _read(WS_TOOLS)
        assert "validate_pixel_size" in content, (
            "TOOLS.md must mention validate_pixel_size tool"
        )

    def test_mentions_get_layout_info_per_layer(self):
        content = _read(WS_TOOLS)
        lower = content.lower()
        # Must document that get_layout_info returns per-layer information
        assert "per-layer" in lower or "per_layer" in lower or ("layer" in lower and "count" in lower), (
            "TOOLS.md must document get_layout_info per-layer output"
        )


class TestWorkspaceRules:
    """agent/workspace/RULES.md must have pixel_size and hallbar geometry constraints."""

    def test_pixel_size_validation_rule(self):
        content = _read(WS_RULES)
        lower = content.lower()
        assert "pixel_size" in lower or "pixel size" in lower, (
            "RULES.md must have pixel_size validation rule"
        )

    def test_solidity_constraint(self):
        content = _read(WS_RULES)
        lower = content.lower()
        assert "solidity" in lower, (
            "RULES.md must mention solidity constraint"
        )

    def test_solidity_threshold(self):
        content = _read(WS_RULES)
        lower = content.lower()
        # Must mention solidity AND 0.5 in the same context (not just any 0.5)
        assert re.search(r'solidity.*0\.5|0\.5.*solidity', lower), (
            "RULES.md must specify solidity < 0.5 threshold in proximity"
        )

    def test_contacts_single_material(self):
        content = _read(WS_RULES)
        lower = content.lower()
        assert "contact" in lower and ("single" in lower or "material" in lower), (
            "RULES.md must require contacts in single-material regions"
        )

    def test_topgate_isolation(self):
        content = _read(WS_RULES)
        lower = content.lower()
        # Must mention topgate/top gate AND isolation together (not just layer table)
        assert re.search(
            r'(topgate|top.?gate).{0,80}isolat|isolat.{0,80}(topgate|top.?gate)',
            lower,
        ), (
            "RULES.md must mention topgate isolation constraint (not just layer listing)"
        )


# ===========================================================================
# 4C: Update KlayoutClaw docs
# ===========================================================================

class TestDocsTools:
    """docs/tools.md must mention new tools (#7 and #8)."""

    def test_mentions_evaluate_design(self):
        content = _read(DOCS_TOOLS)
        assert "evaluate_design" in content, (
            "docs/tools.md must mention evaluate_design tool"
        )

    def test_mentions_validate_pixel_size(self):
        content = _read(DOCS_TOOLS)
        assert "validate_pixel_size" in content, (
            "docs/tools.md must mention validate_pixel_size tool"
        )

    def test_tool_count_9(self):
        content = _read(DOCS_TOOLS)
        # The tool summary line should say 9 tools
        assert re.search(r'9\s*tools', content, re.IGNORECASE), (
            "docs/tools.md must indicate 9 tools total"
        )


class TestDocsSkills:
    """docs/skills.md must mention new skills."""

    def test_mentions_nanodevice_e2e_design(self):
        content = _read(DOCS_SKILLS)
        assert "nanodevice_e2e_design" in content, (
            "docs/skills.md must mention nanodevice_e2e_design"
        )

    def test_mentions_klayout_gds_import(self):
        content = _read(DOCS_SKILLS)
        assert "klayout_gds_import" in content, (
            "docs/skills.md must mention klayout_gds_import"
        )


class TestClaudeMd:
    """CLAUDE.md must have updated tool count, new skills, and evaluate_worker."""

    def test_tool_count_9(self):
        content = _read(CLAUDE_MD)
        # Must say "9 total" somewhere in the MCP Tools section
        assert re.search(r'MCP\s+Tools\s*\(\s*9\s+total\s*\)', content, re.IGNORECASE), (
            "CLAUDE.md must have 'MCP Tools (9 total)' header"
        )

    def test_mentions_evaluate_worker(self):
        content = _read(CLAUDE_MD)
        assert "evaluate_worker.py" in content, (
            "CLAUDE.md must list evaluate_worker.py in tools/ directory"
        )

    def test_mentions_close_layout_view(self):
        content = _read(CLAUDE_MD)
        assert "close_layout_view" in content, (
            "CLAUDE.md must list close_layout_view in MCP Tools table"
        )

    def test_mentions_nanodevice_e2e_design_in_structure(self):
        content = _read(CLAUDE_MD)
        assert "nanodevice_e2e_design" in content, (
            "CLAUDE.md must mention nanodevice_e2e_design in directory structure"
        )

    def test_mentions_evaluate_design_tool(self):
        content = _read(CLAUDE_MD)
        assert "evaluate_design" in content, (
            "CLAUDE.md must mention evaluate_design in tool table"
        )

    def test_mentions_validate_pixel_size_tool(self):
        content = _read(CLAUDE_MD)
        assert "validate_pixel_size" in content, (
            "CLAUDE.md must mention validate_pixel_size in tool table"
        )


# ===========================================================================
# 4D: TypeScript source — annotations and background tools
# ===========================================================================

class TestAnnotationsTs:
    """agent/src/tools/annotations.ts must have new tool entries."""

    def test_evaluate_design_entry(self):
        content = _read(ANNOTATIONS_TS)
        # Must have an entry with name "evaluate_design" and readonly: true
        assert "evaluate_design" in content, (
            "annotations.ts must contain evaluate_design entry"
        )
        # Find the object containing evaluate_design
        match = re.search(
            r'\{[^}]*"evaluate_design"[^}]*\}|\{[^}]*evaluate_design[^}]*\}',
            content,
        )
        assert match is not None, "evaluate_design must be in an annotation object"
        obj_text = match.group()
        assert "readonly" in obj_text and "true" in obj_text, (
            "evaluate_design must have readonly: true"
        )

    def test_validate_pixel_size_entry(self):
        content = _read(ANNOTATIONS_TS)
        assert "validate_pixel_size" in content, (
            "annotations.ts must contain validate_pixel_size entry"
        )
        match = re.search(
            r'\{[^}]*"validate_pixel_size"[^}]*\}|\{[^}]*validate_pixel_size[^}]*\}',
            content,
        )
        assert match is not None, "validate_pixel_size must be in an annotation object"
        obj_text = match.group()
        assert "readonly" in obj_text and "true" in obj_text, (
            "validate_pixel_size must have readonly: true"
        )

    def test_evaluate_design_in_tool_annotations_array(self):
        """evaluate_design must appear inside the TOOL_ANNOTATIONS array, not in a comment."""
        content = _read(ANNOTATIONS_TS)
        # Extract the text between TOOL_ANNOTATIONS = [ ... ] (the array body)
        match = re.search(
            r'TOOL_ANNOTATIONS\s*(?::\s*\w+(?:\[\])?\s*)?=\s*\[(.*?)\];',
            content,
            re.DOTALL,
        )
        assert match is not None, (
            "annotations.ts must have a TOOL_ANNOTATIONS = [...] array declaration"
        )
        array_body = match.group(1)
        assert "evaluate_design" in array_body, (
            "evaluate_design must appear inside the TOOL_ANNOTATIONS array body, "
            "not just in a comment or dead code"
        )


class TestBackgroundTs:
    """agent/src/background/index.ts must have evaluate_design in BACKGROUNDABLE_TOOLS."""

    def test_evaluate_design_backgroundable(self):
        content = _read(BACKGROUND_TS)
        assert "klayout_native_evaluate_design" in content, (
            "index.ts must have 'klayout_native_evaluate_design' in BACKGROUNDABLE_TOOLS"
        )


# ===========================================================================
# 4D2: Skill scanning — file existence and exports
# ===========================================================================

class TestSkillsSectionTs:
    """agent/src/prompts/sections/skills.ts must exist and export buildSkillsSection."""

    def test_file_exists(self):
        assert os.path.isfile(SKILLS_TS), (
            f"skills.ts must exist at {SKILLS_TS}"
        )

    def test_exports_build_skills_section(self):
        content = _read(SKILLS_TS)
        assert re.search(r'export\s+function\s+buildSkillsSection', content), (
            "skills.ts must export function buildSkillsSection"
        )

    def test_signature_accepts_skills_dirs(self):
        content = _read(SKILLS_TS)
        # The function signature must accept skillsDirs: string[]
        assert re.search(r'buildSkillsSection\s*\([^)]*string\s*\[\s*\]', content), (
            "buildSkillsSection must accept skillsDirs: string[] parameter"
        )

    def test_returns_string(self):
        content = _read(SKILLS_TS)
        # Return type should be string
        assert re.search(r'buildSkillsSection\s*\([^)]*\)\s*:\s*string', content), (
            "buildSkillsSection must return string"
        )

    def test_reads_skill_md_files(self):
        content = _read(SKILLS_TS)
        assert "SKILL.md" in content, (
            "skills.ts must reference SKILL.md files"
        )

    def test_parses_yaml_frontmatter(self):
        content = _read(SKILLS_TS)
        lower = content.lower()
        # Must parse YAML frontmatter (look for --- delimiter parsing or yaml references)
        assert "---" in content or "frontmatter" in lower or "yaml" in lower, (
            "skills.ts must parse YAML frontmatter from SKILL.md files"
        )

    def test_no_nonexistent_dir_crash(self):
        """buildSkillsSection must not crash when given a nonexistent directory path.

        This is validated by the TS functional test (Test 7) which passes a
        path that does not exist and asserts a clean empty-string return.
        We verify the TS functional test file contains the test case.
        """
        content = _read(SKILLS_FUNC_TEST)
        assert "nonexistent" in content.lower(), (
            "test_phase4_skills_func.ts must include a nonexistent-directory test case"
        )


class TestPromptsIndexTs:
    """agent/src/prompts/index.ts must import and use buildSkillsSection."""

    def test_imports_build_skills_section(self):
        content = _read(PROMPTS_INDEX_TS)
        assert "buildSkillsSection" in content, (
            "index.ts must import buildSkillsSection"
        )

    def test_skills_dirs_in_context_interface(self):
        content = _read(PROMPTS_INDEX_TS)
        assert "skillsDirs" in content, (
            "PromptBuildContext must have skillsDirs field"
        )

    def test_calls_build_skills_section(self):
        content = _read(PROMPTS_INDEX_TS)
        # Must actually call the function somewhere in buildSystemPrompt
        assert re.search(r'buildSkillsSection\s*\(', content), (
            "buildSystemPrompt must call buildSkillsSection"
        )

    def test_build_skills_section_in_import(self):
        """buildSkillsSection must appear in an actual import statement, not just a comment."""
        content = _read(PROMPTS_INDEX_TS)
        # Match: import { ... buildSkillsSection ... } from "..."
        # or:   import { buildSkillsSection } from "..."
        assert re.search(
            r'import\s*\{[^}]*buildSkillsSection[^}]*\}\s*from\s*["\']',
            content,
        ), (
            "index.ts must import buildSkillsSection via an import statement, "
            "not just reference it in a comment"
        )


class TestAgentTs:
    """agent/src/agent.ts must compute skillsDirs and pass to prompt context."""

    def test_passes_skills_dirs(self):
        content = _read(AGENT_TS)
        assert "skillsDirs" in content, (
            "agent.ts must pass skillsDirs to buildSystemPrompt context"
        )

    def test_skills_dirs_includes_project_skills(self):
        content = _read(AGENT_TS)
        # Must explicitly construct a skillsDirs array that includes a skills path
        assert re.search(r'skillsDirs\s*[=:]', content), (
            "agent.ts must compute skillsDirs and pass it to buildSystemPrompt"
        )


# ===========================================================================
# 4D2: Functional TypeScript tests (run via npx tsx)
# ===========================================================================

class TestBuildSkillsSectionFunctional:
    """Run the TypeScript functional test file and check results."""

    def test_functional_tests_pass(self):
        """Execute test_phase4_skills_func.ts and verify all assertions pass."""
        assert os.path.isfile(SKILLS_FUNC_TEST), (
            f"Functional test file must exist at {SKILLS_FUNC_TEST}"
        )
        result = subprocess.run(
            ["npx", "tsx", SKILLS_FUNC_TEST],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=AGENT_DIR,
        )
        assert result.returncode == 0, (
            f"Functional TypeScript tests failed.\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
        # Verify all 8 test cases reported PASS
        assert "PASS: non-empty for real skills" in result.stdout, (
            "Must pass: buildSkillsSection returns non-empty for real SKILL.md dirs"
        )
        assert "PASS: empty for empty dir" in result.stdout, (
            "Must pass: buildSkillsSection returns empty string for empty dir"
        )
        assert "PASS: deduplicates by name" in result.stdout, (
            "Must pass: buildSkillsSection deduplicates by name (first found wins)"
        )
        assert "PASS: malformed frontmatter gracefully skipped" in result.stdout, (
            "Must pass: malformed YAML frontmatter (no --- delimiters) is skipped"
        )
        assert "PASS: missing name field handled" in result.stdout, (
            "Must pass: SKILL.md with missing name field is handled gracefully"
        )
        assert "PASS: output contains skill name" in result.stdout, (
            "Must pass: output contains the skill name from frontmatter"
        )
        assert "PASS: nonexistent dir returns empty" in result.stdout, (
            "Must pass: nonexistent directory returns empty string without crashing"
        )
        assert "PASS: integration" in result.stdout, (
            "Must pass: buildSystemPrompt includes skill scanning output when skillsDirs is provided"
        )
