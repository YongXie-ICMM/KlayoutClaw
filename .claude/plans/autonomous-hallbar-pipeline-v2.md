# Autonomous Hall Bar Pipeline — Implementation Plan v2

## Goal

Make the E2E device design pipeline **fully autonomous after user query** (zero interventions post-query, target score >0.80).

## Pipeline

```
1. QUERY    → Ask user: device type, shape, scale, pin count, topgate?, backgate?, pixel_size
1b. VALIDATE → validate_pixel_size MCP tool (cross-check with Template.gds)
2. DETECT   → nanodevice_flakedetect (5 subagents, existing)
3. ALIGN    → nanodevice_gdsalign (4 scripts, existing)
4. CONTOUR  → nanodevice_flakedetect_commit (existing)
5. HALLBAR  → nanodevice_hallbar (NEW pure-text skill)
6. PINS     → place pin markers (part of hallbar skill text)
7. DRC      → evaluate_design MCP tool in DRC mode (NEW)
8. EVALUATE → evaluate_design MCP tool in score mode (NEW)
9. ITERATE  → re-run failing steps based on per-metric feedback
10. SAVE    → save_layout + result.json
```

---

## User Feedback Incorporated

| Original proposal | User feedback | Resolution |
|---|---|---|
| Bug1 (parse_layer) | Don't add parser, fix tool exposure + SKILL.md | Better SKILL.md docs for layer format |
| Bug2 (stray text) | Not valid | Dropped (already reverted) |
| Tool1 (query_geometry) | Overdesign | Dropped — use enhanced get_layout_info instead |
| Tool2 (evaluate_design) | Good, learn from KLayout_Harbour | Subprocess MCP tool with per-metric breakdown |
| Hallbar skill | Pure text, no scripts | SKILL.md-only with execute_script recipes |
| Rob1 (inner markers) | Doesn't make sense | Dropped |
| Rob2 (obstacle_layers) | Better tool exposure, not adapting to random formats | Update SKILL.md + TOOLS.md docs |
| Rob3 (pixel_size validation) | Necessary, must be first in pipeline | Part of QUERY step |
| Rob4 (footprint CLI) | Unclear | Dropped |
| Tool3 (DRC) | Similar to Tool2, DRC based on evaluator metrics | Merged into evaluate_design with `mode: "drc"` |
| Enh1 (get_layout_info) | Return ALL information | Per-layer shapes, bbox, area |
| Doc1 (pipeline doc) | Valid | New orchestrator SKILL.md |
| Doc2 | Confusing | Dropped |
| P2 (screenshot etc.) | Don't change, pixel_size guide needed | Pixel size guide in SKILL.md |
| Pipeline start | QUERY = ask user, not just get_layout_info | Full user query step |

---

## Review Fixes Applied (from Round 1: subagent CONDITIONAL PASS)

1. **XML escaping**: All new Python code in `.lym` must escape `<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`. Called out explicitly in Phase 0 and Phase 1.
2. **Worker file deployment**: Follow existing pattern (hardcoded search paths in .lym handler), NOT install.py. Matches `_tool_auto_route` which searches `~/Documents/GitHub/KlayoutClaw/tools/` and `~/.klayout/pymacros/`.
3. **DRC mode weight normalization**: When checks 1-2 are skipped in DRC mode, remaining 6 checks are **normalized to 1.0** (divide by 0.70). A perfect DRC scores 1.0, making it directly comparable to score mode.
4. **Subprocess timeout**: `evaluate_worker.py` uses `timeout=60` (1 minute). Complex flake contours may be slow but should not exceed this; if they do, the error message suggests simplifying geometry.
5. **Conda env deps verification**: `gdstk`, `shapely`, `numpy` must be in the env. Add a pre-flight check in `evaluate_worker.py` that imports all three and exits with clear error if missing.
6. **Test fixtures from agenthle-base**: Real benchmark data at `/Users/andrewwayne/agenthle-base/tasks/chip_design/e2e_device_design/datasets/{ml04,ml08,ml09,ml11,ml14}/`. Each has `reference/Aligned_Stack.gds` (ground truth) and `output_test_neg/result.gds` (failing example). `output_test_pos/` directories are empty — positive fixtures must be generated in test setup using KLayout_Harbour's `fixtures.generate_e2e_device()`.

### Review Fixes Applied (from Round 2: Codex reviewer FAIL → fixed)

7. **evaluate_worker output contract**: Worker must return per-check `{name, score, weight, detail}` objects, not just one float. Copy + refactor from KLayout_Harbour composite_evaluator.py.
8. **Hallbar recipes deferred to TRD**: SKILL.md specifies constraints and rules, not concrete pya code. TRD Overseer writes geometry tests, Executor writes the code. More robust than hardcoded recipes.
9. **get_layout_info recursive**: Use `RecursiveShapeIterator` to include child-cell shapes. Handle empty-layer bbox as `null`, text objects counted but area=0.
10. **DRC score normalized**: Divide by 0.70 so perfect DRC = 1.0.
11. **Error handling in handler**: Explicit handling for 7 failure modes (see 1G).
12. **Conda env**: evaluate_worker defaults to `base` env (has gdstk, shapely, numpy), NOT `instrMCPdev` (lacks shapely).

---

## Build Items

### Phase 0: Enhanced get_layout_info (45 min)

**File**: `plugin/klayoutclaw_server.lym`

**IMPORTANT**: All Python code in this XML file must have `<` `>` `&` escaped as `&lt;` `&gt;` `&amp;`.

Extend `_tool_get_layout_info()` to return per-layer detail:

```json
{
  "status": "ok",
  "dbu": 0.001,
  "num_cells": 2,
  "cells": ["TOP", "MARKERS"],
  "num_layers": 5,
  "layers": {
    "1/0": {"shapes": 7, "area_um2": 2500.0, "bbox_um": [-50, -32.5, 50, 32.5]},
    "2/0": {"shapes": 102, "area_um2": 816000.0, "bbox_um": [-900, -900, 900, 900]},
    "5/0": {"shapes": 104, "area_um2": 520.0, "bbox_um": [-400, -400, 400, 400]},
    "11/0": {"shapes": 3, "area_um2": 4500.0, "bbox_um": [100, 200, 350, 450]},
    "13/0": {"shapes": 2, "area_um2": 8200.0, "bbox_um": [80, 180, 400, 500]}
  }
}
```

Implementation: iterate `_layout.layer_indices()`, for each layer use `pya.RecursiveShapeIterator` (recursive across all cells) to collect shapes, then `pya.Region` to compute area + bbox. Handle edge cases:
- Empty layers: emit `null` for bbox, `0.0` for area
- Text objects: counted in `shapes` but excluded from Region (area=0 is correct)
- Use `_top_cell.begin_shapes_rec(layer_idx)` for recursive iteration

**Also update tool annotations** in `agent/src/tools/annotations.ts` — `get_layout_info` stays readonly.

**Also update** `agent/workspace/TOOLS.md` to document the new per-layer fields.

---

### Phase 0.5: validate_pixel_size MCP Tool (1 hr)

**New native MCP tool** — lightweight, runs on main thread (no subprocess).

Validates pixel_size against expected ranges and optionally cross-checks with Template.gds marker spacing.

**Tool schema**:
```python
{
    "name": "validate_pixel_size",
    "description": "Validate pixel size (um/px) for microscope images. Checks against expected ranges and optionally cross-references Template.gds marker spacing to detect mismatches.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "pixel_size": {"type": "number", "description": "Pixel size in um/px"},
            "template_gds": {"type": "string", "description": "Optional path to Template.gds. If provided, compares expected marker spacing against image-derived spacing to validate pixel_size."},
            "image_path": {"type": "string", "description": "Optional path to microscope image. Used with template_gds for cross-validation."}
        },
        "required": ["pixel_size"]
    }
}
```

**Implementation** (native pya, no subprocess):
- Check pixel_size is in valid range [0.01, 2.0] um/px
- Map to likely objective: 0.05→100x, 0.087→100x, 0.1→50x, 0.25→20x, 0.5→10x
- If `template_gds` provided: load GDS via pya, find L5/0 marker polygons, compute marker pair spacing in um. Return `marker_spacing_um` so the agent can later cross-check against detected marker pixel distances (marker_spacing_um / pixel_size should match detected pixel distance). The tool does NOT do image analysis — it provides the GDS-side reference value.
- Return: `{status, valid, pixel_size, likely_objective, warnings, marker_spacing_um}`

**Why**: Pixel size errors cascade through the entire pipeline (wrong template rendering, wrong contour scaling). Catching it at step 0 saves 30+ minutes of wasted alignment.

---

### Phase 1: evaluate_design MCP Tool (3-4 hrs)

**New MCP tool** — subprocess pattern (same as `auto_route`).

#### 1A. Tool schema in `klayoutclaw_server.lym`

```python
{
    "name": "evaluate_design",
    "description": "Evaluate device design against reference flake boundaries. Returns per-metric scores (0-1) and overall score. Supports two modes: 'score' (full evaluation) and 'drc' (design rule check only, no reference needed for some checks).",
    "inputSchema": {
        "type": "object",
        "properties": {
            "reference_gds": {
                "type": "string",
                "description": "Path to Aligned_Stack.gds (reference flake boundaries). Required for score mode."
            },
            "layer_map": {
                "type": "object",
                "description": "Component→layer mapping. Keys: mesa, contact_patch, topgate, contact_route, bonding_pad. Values: arrays of {layer, datatype}. Example: {\"mesa\": [{\"layer\": 20, \"datatype\": 0}], ...}"
            },
            # NOTE: qlaybot's schema converter maps "type: object" to Type.Unknown,
            # so the description must contain enough detail for the LLM to construct
            # the correct JSON. The example in the description serves this purpose.
            "mode": {
                "type": "string",
                "enum": ["score", "drc"],
                "default": "score",
                "description": "'score': full 8-metric evaluation against reference. 'drc': structural checks only (checks 3-8: topgate, contact_isolation, connectivity, route_endpoints, contact_mesa_adjacency, mesa_probes) — no reference GDS needed."
            },
            "python_path": {
                "type": "string",
                "description": "Path to python with gdstk+shapely+numpy (overrides conda_env)"
            },
            "conda_env": {
                "type": "string",
                "description": "Conda env with evaluation deps",
                "default": "base"
            }
        },
        "required": ["layer_map"]
    }
}
```

#### 1B. Handler in `klayoutclaw_server.lym`

**IMPORTANT**: All Python code must be XML-escaped (`<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`).

Mirror `_tool_auto_route` pattern (lines 410-570 of .lym):
1. Save current layout to temp GDS (`tempfile.mkdtemp`, `_layout.write`)
2. Write config JSON (layer_map + mode + reference_gds + output_path)
3. Find worker via candidate paths (include `__file__` dir, `~/Documents/GitHub/KlayoutClaw/tools/`, `~/.klayout/pymacros/`)
4. Support `python_path` param override (bypass conda) AND `conda_env` param (default `base`, NOT `instrMCPdev`). Note: conda activation path `~/miniforge3/etc/profile.d/conda.sh` is hardcoded in auto_route and is fragile (this machine uses `~/anaconda3`). The `python_path` override is the recommended approach — the SKILL.md should instruct the agent to discover the correct python path via execute_script first (same pattern as nanodevice_routing/SKILL.md lines 111-122).
5. Spawn subprocess: `subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=60)`
6. Handle ALL failure paths from auto_route:
   - `subprocess.TimeoutExpired` → ValueError with timeout message
   - Generic `Exception` from subprocess.run → ValueError
   - `proc.returncode != 0` → ValueError with last stderr line + full stderr[:500]
   - Missing output JSON → ValueError with stdout/stderr excerpt
   - Worker returns `status: "error"` → ValueError with error list
   - `mode="score"` without `reference_gds` → ValueError before spawning
   - Malformed `layer_map` (missing required keys) → ValueError before spawning
7. Read output JSON with per-metric breakdown
8. Return results as JSON string
9. Cleanup temp files in `finally` block (matches auto_route's try/except cleanup)

#### 1C. New file: `tools/evaluate_worker.py`

**Copy + refactor** all 8 check functions from `/Users/andrewwayne/KLayout_Harbour/shared/composite_evaluator.py` (source of truth, NOT agenthle-base). Each check becomes independently callable, returning `{name, score, weight, detail}` dict. The worker produces per-metric breakdown, not just one float. Self-contained — no import dependency on KLayout_Harbour at runtime.

**CLI**: `python evaluate_worker.py config.json`

**Config JSON input**:
```json
{
    "output_gds": "/tmp/klayoutclaw_eval_xxx/input.gds",
    "reference_gds": "/path/to/Aligned_Stack.gds",
    "layer_map": {
        "mesa": [{"layer": 20, "datatype": 0}],
        "contact_patch": [{"layer": 21, "datatype": 0}],
        "topgate": [{"layer": 22, "datatype": 0}],
        "contact_route": [{"layer": 3, "datatype": 0}],
        "bonding_pad": [{"layer": 2, "datatype": 0}]
    },
    "mode": "score",
    "output_path": "/tmp/klayoutclaw_eval_xxx/output.json"
}
```

**Output JSON**:
```json
{
    "status": "ok",
    "overall_score": 0.72,
    "mode": "score",
    "checks": [
        {"name": "mesa_on_overlap", "score": 0.95, "weight": 0.15, "detail": "95% of mesa area within graphene∩graphite overlap"},
        {"name": "contacts_in_regions", "score": 0.80, "weight": 0.15, "detail": "8/10 contacts in valid single-material regions"},
        {"name": "topgate", "score": 0.50, "weight": 0.10, "detail": "coverage=1.0, isolation=0.0 (topgate overlaps routes)"},
        {"name": "contact_isolation", "score": 1.00, "weight": 0.10, "detail": "0/45 route pairs crossing"},
        {"name": "connectivity", "score": 0.60, "weight": 0.10, "detail": "6/10 contacts reach bonding pads via routes"},
        {"name": "route_endpoints", "score": 0.75, "weight": 0.10, "detail": "15/20 endpoints touching device/pad/junction"},
        {"name": "contact_mesa_adjacency", "score": 0.90, "weight": 0.15, "detail": "9/10 patches within 2um of mesa"},
        {"name": "mesa_probes", "score": 0.55, "weight": 0.15, "detail": "solidity=0.45, score=0.55"}
    ]
}
```

**DRC mode** (no reference_gds needed): runs only checks 3-8 (topgate, contact_isolation, connectivity, route_endpoints, contact_mesa_adjacency, mesa_probes). Checks 1-2 require reference and are omitted. The overall_score is **normalized to 1.0** (divide by sum of remaining weights = 0.70), so a perfect DRC = 1.0.

**Dependencies**: `gdstk`, `shapely`, `numpy` — available in conda `base`.

#### 1D. Tool annotation

In `agent/src/tools/annotations.ts`:
```typescript
{ name: "evaluate_design", readwrite: false, readonly: true, backgroundable: true }
```
(readonly because it doesn't modify layout; backgroundable because it can take a few seconds)

#### 1E. Worker file discovery (no install.py change)

Follow the existing `_tool_auto_route` pattern: the handler searches hardcoded candidate paths for `evaluate_worker.py`:
```python
worker_candidates = [
    os.path.expanduser("~/Documents/GitHub/KlayoutClaw/tools/evaluate_worker.py"),
    os.path.expanduser("~/testFolder/KlayoutClaw/tools/evaluate_worker.py"),
    os.path.expanduser("~/.klayout/pymacros/evaluate_worker.py"),
]
# Also try __file__ directory (same as auto_route does):
try:
    worker_candidates.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "evaluate_worker.py"))
except Exception:
    pass
```
This matches `route_worker.py` discovery exactly (including `__file__` fallback). No install.py change needed.

#### 1F. Subprocess timeout

Use `timeout=60` (1 minute). The evaluator runs shapely geometric operations which should complete in seconds for typical Hall bars (10-20 shapes). Error message on timeout: "Evaluation timed out after 60 seconds. The layout may have very complex contours."

#### 1G. Error handling in _tool_evaluate_design handler

Must explicitly handle:
- `mode="score"` without `reference_gds` → raise ValueError with clear message
- Malformed `layer_map` (missing required keys) → raise ValueError listing missing keys
- Worker script not found → raise ValueError with candidate paths
- Subprocess timeout → raise ValueError suggesting geometry simplification
- Subprocess non-zero exit → raise ValueError with stderr
- Missing/invalid output JSON → raise ValueError with stdout/stderr excerpt
- Cleanup temp files in `finally` block on ALL failure paths

#### 1H. Dependency pre-flight in evaluate_worker.py

At the top of `evaluate_worker.py`, add:
```python
try:
    import gdstk, shapely, numpy
    from shapely.validation import make_valid  # used by metric checks
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Required: gdstk, shapely (with shapely.validation), numpy", file=sys.stderr)
    sys.exit(1)
```

#### 1I. XML validation gate

After modifying `klayoutclaw_server.lym`, verify XML validity before testing:
```bash
python -c "import xml.etree.ElementTree as ET; ET.parse('plugin/klayoutclaw_server.lym'); print('XML OK')"
```
Add this as a TRD test in Group A — catches unescaped `<`, `>`, `&` that would silently break KLayout plugin loading.

---

### Phase 2: nanodevice_hallbar Pure-Text Skill (4-6 hrs)

**New skill**: `skills/nanodevice_hallbar/SKILL.md` — pure text, no scripts.

This is the most critical piece. It encodes the domain knowledge that caused 4/6 user interventions in ML14.

#### Structure

```
skills/nanodevice_hallbar/
└── SKILL.md    # Complete agent instructions for Hall bar design
```

#### SKILL.md Contents (key sections)

**1. Query Protocol** — what to ask the user before designing:

```markdown
## Step 0: Query User

Before designing, gather these parameters. Ask the user directly:

| Parameter | Example | Default | Notes |
|-----------|---------|---------|-------|
| Device type | "8-pin Hall bar" | 8-pin Hall bar | 2+6 (current+voltage) is standard |
| Channel dimensions | "100×25 um" | fit to overlap | Channel on graphene∩graphite overlap |
| Number of voltage probes | 6 | 6 | Must be even (3 per side) |
| Topgate? | yes/no | yes | Covers channel, isolated from routes |
| Backgate contacts? | yes/no | yes | 2 contacts in graphite-only region |
| Graphene contacts? | 8 | 8 | In graphene-only region |
| Pixel size | 0.087 um/px | 0.1 um/px | Common: 0.05, 0.1, 0.25, 0.5 |
| Layer assignments | mesa=20/0, contact=21/0... | (documented below) | |
```

**2. Pixel Size Validation** — confirm at pipeline start:

```markdown
## Pixel Size Guide

Pixel size depends on microscope objective:
- 100x → ~0.05 or ~0.087 um/px
- 50x → ~0.1 um/px
- 20x → ~0.25 um/px
- 10x → ~0.5 um/px

Most common: **0.1 um/px**. Ask the user to confirm.
If the user specifies "100x objective", use 0.087 um/px.
```

**3. Design Protocol** — specification + constraints (concrete execute_script code deferred to TRD implementation):

The SKILL.md specifies WHAT to build and the CONSTRAINTS, not the exact pya code. The TRD Overseer writes tests that enforce geometry correctness (solidity, overlap, contact placement), and the TRD Executor writes the execute_script recipes that pass those tests. This is more flexible than hardcoded recipes and produces tested code.

```markdown
## Step 1: Analyze Material Regions
- Use get_layout_info to find material layers (L11/0=graphene, L13/0=graphite)
- Compute overlap region (graphene ∩ graphite) via execute_script using pya.Region
- Record overlap bbox for mesa placement

## Step 2: Design Mesa
PHYSICS RULES (adaptive to actual flake geometry):
- Channel must sit on the graphene∩graphite overlap region
- Channel + probes form a non-convex H-bar shape (solidity < 0.5)
- Probes extend from the channel to provide contact points (can be straight, angled, or curved — whatever fits the flake)
- Size, orientation, and probe count adapt to the overlap region shape and area
- The agent should visually inspect the overlap region (screenshot) and design accordingly
HARD CONSTRAINTS (testable):
- Solidity MUST be < 0.5 (non-rectangular, enforced by evaluator metric 8)
- Mesa area within overlap region (enforced by evaluator metric 1)
- Place on layer specified in query (default 20/0)

## Step 3: Place Contact Patches
PHYSICS RULES:
- Graphene contacts at probe tips / channel ends — in graphene-only region (not overlap)
- Backgate contacts in graphite-only region
- Topgate contact isolated from channel and other contacts
- Contact size and count adapt to device geometry and available material regions
HARD CONSTRAINTS (testable):
- Each contact centroid MUST be in a valid single-material region (enforced by evaluator metric 2)
- Contacts MUST be within 2 um of mesa (enforced by evaluator metric 7)

## Step 4: Place Topgate
PHYSICS RULES:
- Covers the channel area to gate the 2DEG
- Must not short to contact routes
- Size adapts to channel geometry
HARD CONSTRAINTS (testable):
- Topgate intersects mesa (enforced by evaluator metric 3 coverage)
- Topgate does not overlap contact routes (enforced by evaluator metric 3 isolation)

## Step 5: Place Pin Markers
- Pin_A (100/0): at each contact patch centroid (for routing source)
- Pin_B (101/0): at nearest available bonding pad centroid (for routing destination)
- Assignment: greedy nearest-first, each pad used at most once
HARD CONSTRAINT:
- Pin_A count MUST equal Pin_B count

## Step 6: Route
- Use nanodevice_routing skill (auto_route MCP tool)
- Inner: contacts → boundary, fine lines 0.5 um
- Outer: boundary → pads, coarse lines 1.0 um

## Step 7: DRC Check
- Call evaluate_design with mode="drc"
- If any check fails → identify failing component → re-run that step
- Max 2 retries per step

## Step 8: Evaluate
- Call evaluate_design with mode="score" + reference_gds
- If score > 0.80 → proceed to save
- If score < 0.80 → fix lowest-scoring metric, max 2 iterations

## Step 9: Save
- save_layout → result.gds
- Write result.json with layer_map + feedback fields
```

**4. Layer Convention Table**:

```markdown
## Layer Assignments

| Component | Layer | Datatype | Purpose |
|-----------|-------|----------|---------|
| mesa | 20 | 0 | Hall bar channel + probes |
| contact_patch | 21 | 0 | Contact regions |
| topgate | 22 | 0 | Gate electrode |
| contact_route (fine) | 3 | 0 | Inner EBL routes |
| contact_route (coarse) | 4 | 0 | Outer EBL routes |
| boundary_patch | 6 | 0 | EBL window patches |
| bonding_pad | 2 | 0 | Template pads (from Template.gds) |
| markers | 5 | 0 | Alignment markers (from Template.gds, read-only) |
| graphene_ref | 11 | 0 | Graphene contour (from flakedetect) |
| graphite_ref | 13 | 0 | Graphite contour (from flakedetect) |
| pin_contacts | 100 | 0 | Temporary routing pins (source) |
| pin_pads | 101 | 0 | Temporary routing pins (dest) |
```

---

### Phase 3: nanodevice_e2e_design Orchestrator Skill (2 hrs)

**New skill**: `skills/nanodevice_e2e_design/SKILL.md` — top-level orchestrator.

Sequences the full pipeline. Discoverable by both Claude Code and qlaybot (via skill scanning in Phase 4D2). The agent reads the full SKILL.md when it needs to execute the pipeline.

```markdown
# Full Pipeline Steps

1. QUERY — Read this SKILL.md, then invoke nanodevice_hallbar skill Step 0 (query user)
2. DETECT — Dispatch subagent: read nanodevice_flakedetect/SKILL.md
   Gate: traces.json exists with all 4 materials
3. ALIGN — Dispatch subagent: read nanodevice_gdsalign/SKILL.md
   Gate: gds_alignment_report.json, mean_residual < 5 um
4. CONTOUR — Dispatch subagent: read nanodevice_flakedetect_commit/SKILL.md
   Gate: polygons on L10-13 visible in KLayout
5. HALLBAR — Follow nanodevice_hallbar/SKILL.md Steps 1-9
   Gate: evaluate_design score > 0.80 or max iterations reached
6. SAVE — save_layout + write result.json
```

---

### Phase 4: Documentation & Integration (2 hrs)

#### 4A. Update existing SKILL.md files

- `skills/nanodevice_gdsalign/SKILL.md` — add pixel_size validation guidance
- `skills/nanodevice_routing/SKILL.md` — clarify layer format ("L/D" string, e.g. "1/0")

#### 4B. Update qlaybot workspace files (critical for qlaybot integration)

Since qlaybot sets `noSkills: true` and does NOT load `skills/*/SKILL.md`, all hallbar domain knowledge for qlaybot must be mirrored into workspace files:

- `agent/workspace/TOOLS.md` — add evaluate_design tool description, document get_layout_info per-layer output
- `agent/workspace/WORKFLOW.md` — add Phase 0 (Query) before Phase 1 (Plan), add hallbar design constraints summary (from hallbar SKILL.md Steps 1-9), add evaluate → iterate loop
- `agent/workspace/RULES.md` — add pixel_size validation rule, add hallbar geometry constraints (solidity < 0.5, contacts in single-material regions, topgate isolation)

This ensures qlaybot can design Hall bars autonomously even without SKILL.md access.

#### 4C. Update KlayoutClaw docs

- `docs/tools.md` — add evaluate_design (tool #7)
- `docs/skills.md` — add nanodevice_hallbar + nanodevice_e2e_design
- `CLAUDE.md` — update tool count (6→7), add new skills to directory structure

#### 4D. Update tool annotations for qlaybot

- `agent/src/tools/annotations.ts` — add `evaluate_design` (readonly) and `validate_pixel_size` (readonly)
- `agent/src/background/index.ts` — add `"klayout_native_evaluate_design"` to `BACKGROUNDABLE_TOOLS` set. Note: this set controls which tools the `BackgroundTaskManager.isBackgroundable()` check allows. The actual background execution path is already wired in the TUI via `Ctrl+G` / `background_status` / `background_result` tools. Adding the tool name to the set is sufficient.

#### 4D2. Enable skill scanning in qlaybot (minimal change, 2 files)

Currently qlaybot sets `noSkills: true` and only loads 4 workspace files. To surface SKILL.md files:

**New file: `agent/src/prompts/sections/skills.ts`**
```typescript
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Scan one or more directories for skills/*/SKILL.md files.
 * Returns a summary list (name + description) for the system prompt.
 */
export function buildSkillsSection(skillsDirs: string[]): string {
  const seen = new Set<string>();
  const summaries: string[] = [];

  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillMd = join(dir, entry, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, "utf-8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      const fm = match[1];
      const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() || entry;
      if (seen.has(name)) continue; // deduplicate
      seen.add(name);
      const desc = fm.match(/description:\s*(.+)/)?.[1]?.trim() || "";
      summaries.push(`- **${name}**: ${desc}`);
    }
  }
  if (!summaries.length) return "";
  return "## Available Skills\n\n" + summaries.join("\n");
}
```

Scans multiple directories — both the project `skills/` dir and the workspace dir can contain skills. Deduplicates by name (first found wins).

**Modify `PromptBuildContext`** in `agent/src/prompts/index.ts` — add `skillsDirs` field:
```typescript
export interface PromptBuildContext {
  // ... existing fields ...
  skillsDirs: string[];  // e.g. ["KlayoutClaw/skills", "~/.qlaybot/workspace/skills"]
}
```

**Modify `buildSystemPrompt()`** — add after workspace context:
```typescript
import { buildSkillsSection } from "./sections/skills.js";
// ... after context section:
const skills = buildSkillsSection(ctx.skillsDirs);
if (skills) sections.push(skills);
```

**Modify `agent.ts`** — pass skillsDirs when building prompt context:
```typescript
// In createDesignSession(), compute skills dirs:
const projectSkillsDir = resolve(
  getDefaultWorkspaceTemplate(), "..", "..", "skills"
);  // → KlayoutClaw/skills/ (workspace template is at agent/workspace/, so ../../skills/)

skillsDirs: [
  projectSkillsDir,                // bundled: KlayoutClaw/skills/
  join(workspaceDir, "skills"),    // user workspace: ~/.qlaybot/workspace/skills/
  join(process.cwd(), "skills"),   // cwd: project working directory skills/
],
```

Note: `getDefaultWorkspaceTemplate()` returns `agent/workspace/`. Going up 2 levels reaches `KlayoutClaw/`, then into `skills/`. This avoids using `__dirname_resolved` which is local to `getDefaultWorkspaceTemplate()`.

Skills are discovered from whichever workspace qlaybot is running in — bundled project skills, user workspace skills, or skills in the current working directory.

**Why summary-only**: Full SKILL.md content for all 14+ skills would consume ~5K tokens. Summary list is ~500 tokens. Agent reads full SKILL.md via `read` tool on demand.

**No change to `noSkills: true`** — that flag controls Pi-Agent SDK's internal skill loader, separate from our custom prompt injection.

#### 4E. Worker deployment (NO install.py change)

No install.py change needed — `evaluate_worker.py` is discovered via hardcoded search paths in the .lym handler (same pattern as `route_worker.py`).

---

## Implementation Order

```
Phase 0:   Enhanced get_layout_info                    [45 min]
Phase 0.5: validate_pixel_size MCP tool                [1 hr]     (same .lym file as Phase 0)
Phase 1:   evaluate_design MCP tool + worker           [3-4 hrs]  (same .lym file as Phase 0/0.5)
Phase 2:   nanodevice_hallbar SKILL.md (pure text)     [4-6 hrs]
Phase 3:   nanodevice_e2e_design orchestrator SKILL.md [2 hrs]
Phase 4:   Docs + integration + skill scanning         [3 hrs]
```

**Total**: ~14-18 hours

**Dependency order** (strictly sequential where files overlap):
- Phase 0 → Phase 0.5 → Phase 1: all modify `klayoutclaw_server.lym`, MUST be sequential
- Phase 2 depends on Phase 1 (hallbar uses evaluate_design for DRC/score)
- Phase 3 depends on Phase 2 (references hallbar skill)
- Phase 4 depends on all prior (docs, annotations, skill scanning, BACKGROUNDABLE_TOOLS)

---

## TRD Test Strategy

Tests will use qlaybot in JSON-RPC mode, calling tools agentically:

### Group A: get_layout_info + validate_pixel_size + XML validity
- Test: XML parse `plugin/klayoutclaw_server.lym` → no errors (catches unescaped `<` `>` `&`)
- Test: call get_layout_info on a layout with known geometry, verify per-layer shapes/area/bbox
- Test: empty layout returns empty layers dict
- Test: multi-cell layout returns correct recursive shape counts (includes child cells)
- Test: layer with only text objects → shapes > 0 but area_um2 = 0.0, bbox = null
- Test: empty layer (no shapes) → area_um2 = 0.0, bbox = null
- Test: validate_pixel_size 0.087 → status ok, likely_objective "100x"
- Test: validate_pixel_size 0.0 or 5.0 → status error
- Test: validate_pixel_size with template_gds → returns marker_spacing_um

### Group B: evaluate_design tool
Uses benchmark reference GDS + synthetic fixtures:
- Reference GDS from `/Users/andrewwayne/agenthle-base/tasks/chip_design/e2e_device_design/datasets/ml14/reference/Aligned_Stack.gds`
- Negative fixture: `ml14/output_test_neg/result.gds` (exists) → score < 0.30
- Positive fixture: generate synthetic "good" device using KLayout_Harbour's `fixtures.generate_e2e_device()` → score > 0.70
- Note: `output_test_pos/` directories are empty — positive fixtures must be generated in test setup
- Test: DRC mode on positive fixture without reference_gds → returns checks 3-8 only
- Test: missing component in layer_map → MCP tool returns isError=true with descriptive message (ValueError from handler)
- Test: score mode — per-check weights sum to 1.0, overall = weighted sum
- Test: DRC mode — per-check weights are original (sum to 0.70), overall = weighted sum / 0.70 (normalized to 1.0)
- Test: mode="score" without reference_gds → MCP isError=true
- Test: subprocess timeout (mock) → MCP isError=true with clear message
- Test: worker script not found → MCP isError=true listing candidate paths

### Group C: nanodevice_hallbar skill (integration)
- Test: given flake contours already in KLayout, invoke hallbar skill → produces valid geometry
- Test: mesa solidity < 0.5 (non-rectangular shape)
- Test: all contacts in valid material regions
- Test: pin counts match (Pin_A == Pin_B)

### Group D: Skill scanning (buildSkillsSection)
- Test: scan KlayoutClaw/skills/ → returns summary with known skill names (geometry, display, nanodevice_flakedetect, etc.)
- Test: empty directory → returns empty string
- Test: SKILL.md without frontmatter → skipped
- Test: duplicate skill name across dirs → first wins (dedup)
- Test: skill paths resolve correctly from getDefaultWorkspaceTemplate()

### Group E: Full pipeline (E2E)
- Test: with pre-loaded flake data + template, run full pipeline → score > 0.80 (matches goal)

---

## Key Design Decisions

1. **evaluate_design combines DRC + scoring** — one tool, two modes. DRC mode doesn't need reference GDS and runs fast. Score mode needs reference but gives the full 8-metric breakdown.

2. **hallbar is pure text** — no scripts. SKILL.md specifies constraints and geometry rules. Concrete execute_script code is written by TRD Executor and validated by TRD Overseer tests. This ensures tested code, not ad-hoc recipes.

3. **Pixel size validated at query time** — before any CV pipeline runs. Common values documented in skill.

4. **evaluate_worker.py is self-contained** — embeds evaluator logic from KLayout_Harbour. No import dependency.

5. **Auto-surfacing to qlaybot** — adding evaluate_design to the MCP server's TOOLS list makes it auto-discoverable via `tools/list` → appears as `klayout_native_evaluate_design` in qlaybot with zero code changes. BUT: subagents won't see it until added to `TOOL_ANNOTATIONS` in `agent/src/tools/annotations.ts`.

6. **Layer format standardized** — all SKILL.md files and tool docs use "L/D" string format (e.g., "20/0"). Documented in TOOLS.md and RULES.md.

7. **qlaybot skill scanning** — Phase 4D2 adds a minimal `buildSkillsSection()` that scans `skills/*/SKILL.md` frontmatter and injects a summary list into the system prompt. The agent reads full SKILL.md via `read` tool when needed. `noSkills: true` stays (it controls Pi-Agent SDK internals, not our custom injection). Both qlaybot and Claude Code can now discover and use all skills.

8. **Codex finding: domain tools not exposed to subagents** — tool-factory.ts only passes annotation-listed tools to subagents. Current annotations only list native tool names, so `klayout_geometry_*` etc. are NOT available to subagents. This is a known limitation but doesn't affect the pipeline since the hallbar skill runs in the parent agent context.
