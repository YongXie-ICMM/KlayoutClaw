# qlaybot v0.4.0 TRD Prompts v2 — Integration-First

10 groups (Phase 0 + 9 implementation groups, Group 2 split into 2a/2b). Key changes from v1:
- **Phase 0 (contracts)** runs first, not as TRD
- **Two-tier test gates** — fast iteration + full exit gate (see below)
- **Spec Compliance Checklists (SCC)** — explicit behavior lists the Overseer MUST test
- **TUI testing patterns** — concrete ink-testing-library + reducer patterns
- **Integration seam verification** — import/export checks at group boundaries

---

## Two-Tier Test Gate Protocol

Every group uses two tiers of testing:

**Tier 1 — ITERATION GATE (run during every TRD cycle):**
```
cd agent && npm run build && npx vitest run tests/<own-test-file>.ts
```
- Fast: build + own tests only
- `npm run build` catches type mismatches, missing imports, broken contracts
- Own tests verify current group's behavior
- Run this on EVERY Overseer→Executor iteration

**Tier 2 — EXIT GATE (run ONCE when declaring the group DONE):**
```
cd agent && npm run build && npx vitest run tests/test-contracts.ts [all prior test files] tests/<own-test-file>.ts
```
- Full accumulative: all prior group tests + own
- Catches runtime regressions in prior groups
- Run this ONLY when the group is ready to declare done
- If exit gate fails, fix regressions before declaring done

**Rule:** You MUST pass the exit gate before declaring done. But during TRD iterations, use the fast iteration gate to keep velocity.

---

## Group 0: Phase 0 — Contract Foundation (NOT TRD)

This is a single-agent task, not a TRD group. Run it before any TRD group starts.

```
Implement qlaybot v0.4.0 Phase 0: Contract Foundation.

This is NOT TRD. You are writing shared types, test utilities, and contract tests that ALL subsequent groups will import.

READ FIRST:
- Spec 1: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec1-config-tui-design.md (sections 2.1-2.3 for config types, section 7 for focus states)
- Spec 2: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec2-subagents-design.md (section 2 for RoleConfig, section 3 for SubagentResult, section 5 for SubagentTUIEntry)
- Spec 3: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec3-search-retrieval-design.md (sections 3, 6 for Embedder, SearchMode)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Current source: agent/src/config.ts (existing QlayBotConfig), agent/src/tui/types.ts (existing TUI types)

TASK — Create these files:

1. agent/src/types/v04-contracts.ts — ALL cross-boundary interfaces and types:
   - KLayoutConfig { url, required, autoLaunch, disabledTools }
   - ToolAnnotation { name, readonly?: boolean, readwrite?: boolean, backgroundable?: boolean }
   - FocusState = "input"|"completion"|"bar-select"|"config-panel"|"workspace-bar"|"background-bar"|"subagent-summary"|"subagent-inspect"|"subagent-inject"
   - ConfigPanelTab = "settings"|"models"|"mcp"
   - SubagentConfig { enabled, logDir, maxLogFiles, roles }
   - RoleConfig { label, promptFile, workspaceFiles, baseTools, customTools, mcpAccess, maxTurns, maxTokens, model?, thinkingLevel? }
   - SubagentResult { role, task, status, findings, warnings, dataPaths, tokenUsage, transcriptPath, errorMessage? }
   - SubagentRunOptions { role, task, context? } (parentMemory passed via SubagentRunnerDeps constructor, NOT per-call)
   - SubagentTUIEntry { id, toolCallId, role, task, status, startTime, endTime?, tokenUsage, segments, currentTool?, findings?, warnings?, errorMessage? }
   - SubagentSegment = ThinkingSegment | TextSegment | ToolCallSegment | InjectedSegment
   - SearchMode = "fts5"|"fts5+rerank"|"fts5+vector+rerank"|"vector+rerank"
   - SearchConfig { mode, minRerank, rerankMinScore, rerankMaxTokens }
   - EmbeddingConfig { api, baseUrl, apiKey, model, dimensions, similarityThreshold }
   - Embedder interface { embed(text): Promise<Float32Array>, embedBatch(texts): Promise<Float32Array[]>, dimensions: number }
   - RerankResult { entryHash, score }
   (GhostTextResult removed — getGhostSuffix() returns plain string per spec §4.3, ↑ indicator embedded in string)
   - ConfigPanelState { open, tab, editing, editValue, cursors: { settings, models, mcp }, mcpDrilldown: { level: "servers"|"tools", selectedServer: string|null, toolIndex: number } }
   - CommandResultStateChange (extended with configPanel?: { open: boolean; tab: ConfigPanelTab })
   - RunnerEventPayloads: StartedEvent { subagentId, toolCallId, role, task }, ThinkingEvent { subagentId, text }, TextEvent { subagentId, text }, ToolStartEvent { subagentId, toolName, args }, ToolEndEvent { subagentId, toolName, result }
   IMPORTANT: Every field name, every type, every default must match the specs exactly. Read each spec section referenced above.

2. agent/tests/helpers/config-builder.ts — Shared config factories:
   - makeConfig(overrides?) → full QlayBotConfig with sensible defaults
   - makeKLayoutConfig(overrides?) → KLayoutConfig
   - makeSubagentConfig(overrides?) → SubagentConfig
   - makeSearchConfig(overrides?) → SearchConfig
   - makeTmpDir() → creates temp dir, returns path, auto-cleans in afterEach
   - writeConfigFiles(tmpDir, config) → writes model.json + klayout.json + mcp.json + settings.json

3. agent/tests/helpers/ink-helpers.ts — Shared ink test utilities:
   - stripAnsi(str) → removes ANSI escape codes
   - pressKey(stdin, key) → maps named keys ("ctrl-s", "tab", "up", "down", "escape", "enter") to correct escape sequences
   - waitForFrame(render, ms?) → waits for next frame render
   - renderWithReducer(Component, initialState) → returns { frames, stdin, dispatch }

4. agent/tests/helpers/test-factories.ts — Shared test instance factories:
   - createTestConfig(overrides?) → full QlayBotConfig with real API credentials from ~/.keys/api_settings.md
   - createTestMcpManager() → real MCPManager (connects to KLayout at :8765 if available)
   - createTestMemoryManager(tmpDir) → real MemoryManager with disk-based SQLite in tmpDir
   - createTestSubagentRunner(config) → real SubagentRunner with EventEmitter
   NOTE: All tests use REAL APIs. Credentials loaded from ~/.keys/api_settings.md at test startup. No mocks.

5. agent/tests/test-contracts.ts — Contract verification (~20 tests):
   - Import every type/interface from v04-contracts.ts and verify it exists
   - Create instances of each interface with required fields → verify no TS errors
   - Verify FocusState has exactly 9 values
   - Verify SearchMode has exactly 4 values
   - Verify ConfigPanelTab has exactly 3 values
   - Verify SubagentSegment is a 4-member union
   - Verify all helper factories return correct shapes

Build gate: cd agent && npm run build && npx vitest run tests/test-contracts.ts
All 20 contract tests must pass.
```

---

## Group 1: Phases A+B — Config Primitives + TUI Foundation (Spec 1)

```
/trd Implement qlaybot v0.4.0 Phases A+B: Core Config Primitives + TUI Foundation.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec1-config-tui-design.md (sections 2.1-2.7 for Phase A, sections 4, 7 for Phase B, section 10 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts (import ALL types from here, do NOT redefine)
- Test helpers: agent/tests/helpers/ (use makeConfig, makeTmpDir, etc.)
- Current source: agent/src/config.ts, agent/src/agent.ts, agent/src/tools/index.ts, agent/src/commands/index.ts, agent/src/tui/components/InputBox.tsx, agent/src/tui/components/App.tsx, agent/src/tui/reducer.ts, agent/src/tui/types.ts, agent/src/tui/commands.ts, agent/src/tui/hooks/useCommandHistory.ts

IMPORTANT — Integration rules:
- Import ALL types from agent/src/types/v04-contracts.ts. Do NOT create duplicate type definitions.
- Use test helpers from agent/tests/helpers/. Do NOT create local helper functions that duplicate them.
- QlayBotConfig must extend from contracts — add the v0.4 fields (klayout, subagent, search, embedding) alongside existing v0.3 fields.

Phase A scope (9 items):
1. Add klayout.json as 4th config file with KLayoutConfig interface (from contracts)
2. Update QlayBotConfig with all v0.4 fields — use SubagentConfig, SearchConfig, EmbeddingConfig from contracts
3. Config save functions: saveModelConfig, saveKLayoutConfig, saveMCPConfig, saveSettingsConfig
4. Config migration: klayout_mcp extraction from mcp.json + bare model ID rewrite to provider/model format
5. Multi-provider 5-step model resolver: resolveModel()
6. OpenAI-compatible provider runtime (api: "openai-chat" support)
7. Tool annotations: agent/src/tools/annotations.ts — use ToolAnnotation from contracts + getToolIcon()
8. disabledTools filtering in assembleTools() — scoped to KLayout + generic MCP tools only, never base tools
9. CommandResult.stateChange.configPanel type extension (use ConfigPanelTab from contracts)

Phase B scope (6 items):
1. Focus state machine in tui/types.ts — import FocusState from contracts (all 9 states)
2. Replace local useState panel booleans in App.tsx with reducer focusState
3. Inline ghost text hints in InputBox (single match suffix, multi-match most-recent with ↑ indicator)
4. Command recency tracking persisted in ~/.qlaybot/history.json (extend useCommandHistory)
5. CompletionList navigation via Up/Down arrows (Tab accepts ghost hint)
6. Bar navigation: Down-arrow from empty input enters bar-select mode

=== SPEC COMPLIANCE CHECKLIST (Overseer: write a test for EACH item) ===

Config (from Spec 1 §2):
□ SCC-A1: loadConfig() reads klayout.json as 4th file and merges into QlayBotConfig.klayout
□ SCC-A2: saveKLayoutConfig() writes ONLY klayout fields to klayout.json (not other config)
□ SCC-A2a: Config save array-replace behavior: save disabledTools=["a","b"], then save disabledTools=["c"] → disk has ["c"] exactly (replace, not append ["a","b","c"]) — per spec §8
□ SCC-A3: Migration is idempotent — running loadConfig() twice doesn't corrupt files
□ SCC-A4: Migration extracts klayout_mcp from mcp.json → klayout.json, preserves other MCP entries
□ SCC-A5: Bare model ID "claude-sonnet-4-6" rewrites to "custom-anthropic/claude-sonnet-4-6"
□ SCC-A6: resolveModel() 5-step fallback: (1) exact provider/modelId match → (2) any-provider scan → (3) prefix match → (4) first model fallback → (5) error
□ SCC-A7: OpenAI provider with api:"openai-chat" resolves model correctly
□ SCC-A8: disabledTools filters klayout_geometry_add_rect but NOT "read" (base tool)
□ SCC-A9: disabledTools from klayout.json AND per-server mcp.json both applied
□ SCC-A10: getToolIcon() returns 👀 for readonly, 🖊️ for readwrite, ⚡ for backgroundable

API Reference (from Spec 1 §2.7):
□ SCC-A11: API keys and base URLs stored in model.json provider entries (not env vars by default)
□ SCC-A12: ANTHROPIC_API_KEY env var overrides provider apiKey at config load time (separate from resolver — §2.7 override, not a resolver step)

Focus Exclusivity (from Spec 1 §5.1, §7 — CRITICAL, applies to ALL panels):
□ SCC-B0a: When focusState is "config-panel", InputBox useInput has isActive:false — Enter/Up/Down/Escape do NOT reach InputBox
□ SCC-B0b: When focusState is "subagent-summary" or "subagent-inspect", InputBox is inert
□ SCC-B0c: When focusState is "workspace-bar" or "background-bar" or "bar-select", InputBox is inert
□ SCC-B0d: Only when focusState is "input" or "completion" does InputBox process keyboard events
□ SCC-B0e: Each panel component receives isFocused prop derived from state.focusState and uses useInput({isActive: isFocused})

Focus & Ghost Text (from Spec 1 §4, §7):
□ SCC-B1: focusState starts as "input"
□ SCC-B2: Up in "input" with completions open → "completion" (not history)
□ SCC-B3: Down from "input" with empty text → "bar-select"
□ SCC-B4: Down from "input" with non-empty text → stays "input" (history nav)
□ SCC-B5: Escape from "config-panel" → "input"
□ SCC-B6: Escape from "bar-select" → "input"
□ SCC-B7: Ghost text for "/mo" shows "del" suffix (completing "/model")
□ SCC-B8: Ghost text for "/co" with recency {"/config":100, "/compact":200} shows "mpact↑"
□ SCC-B9: Tab accepts ghost hint (appends suffix to input)
□ SCC-B10: Up/Down in CompletionList cycles through matches
□ SCC-B11: Command recency persists to history.json on command execution
□ SCC-B12: Command recency loads from history.json on startup
□ SCC-B13: Subcommand ghost hint: "/model " with trailing space shows "[show|set|list]" in gray (§4.5)
□ SCC-B14: SLASH_COMMANDS entries have subcommands field (e.g., model: ["show","set","list"])
□ SCC-B15: In bar-select mode, focused bar gets highlight/inverse label; other bars dim (§7.8)
□ SCC-B16: [UC-6] History migration: old history.json (plain array format) auto-migrates to {entries, recency} object on load; ghost text works correctly after migration + restart
□ SCC-B17: [UC-S15] Multi-session recency evolution: Session A runs /compact → restart → Session B runs /config → restart → Session C types "/co" → ghost picks /config (most recent), Tab accepts it
□ SCC-B18: Ghost text → CompletionList → selection full flow: type "/co" → ghost shows "mpact↑" (multiple matches: /compact, /config, /context) → press Up → CompletionList dropdown opens with candidates → Up/Down navigates highlighted candidate → Tab selects highlighted candidate (e.g., /config) → input becomes "/config " with trailing space → CompletionList closes → ghost shows subcommand hint "[show|set|setup]"

Tests: agent/tests/test-config-tui.ts (~35 tests including all SCC items above).
Use helpers from agent/tests/helpers/config-builder.ts for tmpDir and config factories.

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-config-tui.ts

EXIT GATE (once, when declaring group DONE):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts

Both test files must pass at exit. If test-contracts.ts breaks, you modified a contract type — fix it.
```

---

## Group 2a: Phase C1 — ConfigPanel Settings + Models Tabs (Spec 1)

```
/trd Implement qlaybot v0.4.0 Phase C1: ConfigPanel Settings + Models Tabs.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec1-config-tui-design.md (sections 5.1-5.4, 5.6, section 10 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts (ConfigPanelTab, ConfigPanelState, FocusState)
- Test helpers: agent/tests/helpers/ (use ink-helpers.ts for rendering, config-builder.ts for state)
- Current source: agent/src/tui/components/App.tsx, agent/src/tui/reducer.ts, agent/src/tui/types.ts, agent/src/commands/config.ts, agent/src/commands/model.ts
- Prerequisite code: Phases A+B complete (focusState, config save, tool annotations, disabledTools)

IMPORTANT — Integration rules:
- Import ConfigPanelTab, ConfigPanelState, FocusState from contracts
- Use ink-helpers.ts for stripAnsi(), pressKey()
- ConfigPanel receives state from App.tsx reducer — do NOT create internal component state that duplicates reducer state
- Commands return stateChange.configPanel — App.tsx dispatches CONFIG_PANEL_OPEN with tab field (per spec §5.6)

Scope (5 items):
1. New ConfigPanel.tsx component — 3-tab navigator shell (Settings, Models, MCP stub)
2. Settings tab: browsable SETTABLE_KEYS list, inline edit mode with Enter/Escape
3. Models tab: interactive picker with provider grouping, context window/cost display, Enter sets default
4. /config (bare) opens ConfigPanel Settings tab via stateChange.configPanel
5. /model (bare) opens ConfigPanel Models tab

=== SPEC COMPLIANCE CHECKLIST ===

ConfigPanel structure + Settings tab (from Spec 1 §5.1-5.3):
□ SCC-C1: Renders 3 tabs; active tab is bracketed [Settings], inactive are unbracketed
□ SCC-C2: Left/Right arrows switch active tab
□ SCC-C3: Settings tab lists all SETTABLE_KEYS with current values
□ SCC-C4: Enter on a Settings key enters edit mode (cursor in value field)
□ SCC-C5: Escape in edit mode cancels edit (value unchanged)
□ SCC-C6: Enter in edit mode saves value (calls saveSettingsConfig)

Models tab (from Spec 1 §5.4):
□ SCC-C7: Models tab groups models by provider with provider headers
□ SCC-C8: Models tab shows context window and cost per model
□ SCC-C9: Enter on a model sets it as default — updates BOTH in-memory config (current session) AND persists to model.json (same pattern as /model set)

Reducer State (from Spec 1 §5.6):
□ SCC-C14a: Reducer has CONFIG_PANEL_OPEN/CLOSE/TAB_CHANGE/NAVIGATE/SELECT actions
□ SCC-C14b: Reducer has CONFIG_PANEL_EDIT_START/EDIT_CONFIRM/EDIT_CANCEL actions
□ SCC-C14d: configPanelCursors per-tab cursor memory restored when switching tabs
□ SCC-C14e: Ctrl+N opens ConfigPanel (keyboard shortcut from §5/§9)

Commands:
□ SCC-C15: `/config` (bare, no args) returns stateChange.configPanel = { open: true, tab: "settings" }
□ SCC-C16: `/model` (bare) returns stateChange.configPanel = { open: true, tab: "models" }

Cross-layer + focus exclusivity:
□ SCC-C21: ConfigPanel Settings edit → Enter → read file from disk → value persisted (not just reducer)
□ SCC-C22: ConfigPanel Models tab → Enter on model → read model.json from disk → defaultModel changed
□ SCC-C27: ConfigPanel cursor persistence rendered: nav to item 3 → switch to Models tab → switch back → item 3 still highlighted
□ SCC-C28: CRITICAL — Enter in Models tab selects model, does NOT send InputBox message
□ SCC-C29: CRITICAL — Up/Down in ConfigPanel navigates panel items, does NOT trigger InputBox history
□ SCC-C30: CRITICAL — Escape from ConfigPanel returns focus to InputBox, does NOT abort agent

Worktime use cases:
□ SCC-C33: [UC-3] Reject invalid search mode from ConfigPanel Settings
□ SCC-C34: [UC-13] Space details in Models tab is read-only (no model change unless Enter)
□ SCC-C35: [UC-14] Invalid numeric setting rejected

State lifecycle:
□ SCC-C41: [UC-S12] Focus stays on ConfigPanel when agent turn ends
□ SCC-C42: [UC-S14] /compact blocked while ConfigPanel open

TUI Testing Patterns (MANDATORY):
- Use ink-testing-library render() for ALL ConfigPanel tests
- Use pressKey(stdin, "left/right/enter/escape") for navigation
- Use stripAnsi(lastFrame()!) for content assertions
- Test reducer state transitions separately from rendering

Tests: agent/tests/test-config-tui-components.ts (~25 tests).

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-config-tui-components.ts

EXIT GATE (once, when declaring group DONE):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts tests/test-config-tui-components.ts
```

---

## Group 2b: Phase C2 — ConfigPanel MCP Tab + Commands (Spec 1)

```
/trd Implement qlaybot v0.4.0 Phase C2: ConfigPanel MCP Tab + Tool Commands.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec1-config-tui-design.md (sections 5.5, 6, section 10 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts (ConfigPanelTab, ToolAnnotation, ConfigPanelState)
- Test helpers: agent/tests/helpers/
- Current source: agent/src/tui/components/ConfigPanel.tsx (from Group 2a), agent/src/tui/reducer.ts, agent/src/commands/mcp.ts
- Prerequisite code: Group 2a complete (ConfigPanel with Settings + Models tabs, reducer actions, Ctrl+N shortcut)

IMPORTANT — Integration rules:
- Import ToolAnnotation (boolean flags: readonly?, readwrite?, backgroundable?) from contracts
- MCP tab is a NEW tab added to existing ConfigPanel from Group 2a — do NOT rewrite ConfigPanel
- Commands return stateChange.configPanel — same pattern as /config and /model from Group 2a
- Two persistence targets: klayout tools → klayout.json, generic MCP tools → mcp.json per-server

Scope (4 items):
1. MCP tab: server list → tool list drill-down, ✓/✗ enable/disable with Space, annotation icons
2. /mcp (bare) opens ConfigPanel MCP tab
3. /mcp enable <tool> and /mcp disable <tool> subcommands
4. Full bar navigation integration (Down from empty input → bar-select)

=== SPEC COMPLIANCE CHECKLIST ===

MCP tab — two MCP client types (from Spec 1 §5.5, §6):
□ SCC-C10: MCP tab server list shows BOTH klayout and generic MCP servers as separate entries
□ SCC-C10a: Server list shows connection status: ● green=connected, ○ red=disconnected
□ SCC-C10b: Server list shows tool count per server
□ SCC-C10c: KLayout server display name is "klayout" (not "klayout_mcp")
□ SCC-C11: Enter on server → drills into that server's tool list
□ SCC-C11a: Tool list header shows "← serverName (N tools)" with back indicator
□ SCC-C11b: Tool list populated from MCPManager.getTools(serverKey) — live tools
□ SCC-C11c: Space on klayout tool toggles ✓/✗ AND persists to klayout.json → disabledTools[]
□ SCC-C11d: Space on generic MCP tool toggles ✓/✗ AND persists to mcp.json → <server>.disabledTools[]
□ SCC-C11e: Different persistence targets: klayout tool → only klayout.json; generic → only mcp.json
□ SCC-C12: Tool annotation icons (👀 readonly, 🖊️ readwrite, ⚡ backgroundable, 🔒 disabled)
□ SCC-C13: Escape: tool list → server list → close panel
□ SCC-C13a: Drill-down state preserved (toolIndex restored on re-drill)
□ SCC-C14c: Reducer has CONFIG_PANEL_MCP_DRILLDOWN/MCP_BACK actions
□ SCC-C14f: MCP tab: [r] key triggers server reconnect

Commands:
□ SCC-C17: `/mcp` (bare) returns stateChange.configPanel = { open: true, tab: "mcp" }
□ SCC-C18: `/mcp disable auto_route` adds to disabledTools in klayout.json
□ SCC-C19: `/mcp enable auto_route` removes from disabledTools
□ SCC-C20: `/mcp disable read` returns error — base tools cannot be disabled

Cross-layer integration:
□ SCC-C23: MCP tab → Space disable → read klayout.json → disabledTools updated
□ SCC-C24: Bar navigation rendered: empty input → Down → bar-select → cycle → Escape
□ SCC-C25: Focus priority rendered: type "/co" → completions → Up navigates completion
□ SCC-C26: Ghost text recency cycle: execute /compact → type "/co" → ghost "mpact↑"
□ SCC-C31: MCP drill-down full cycle rendered (open → drill → toggle → verify disk → escape chain)

Worktime use cases:
□ SCC-C32: [UC-2] Re-enable tool then use next turn without restart
□ SCC-C36: [UC-15] Repeated toggle → correct disabledTools set

Error/edge paths:
□ SCC-C37: [UC-E4] klayout.json missing during toggle → file recreated
□ SCC-C38: [UC-E5] Disconnected server with 0 tools → safe empty list
□ SCC-C39: [UC-E6] MCP reconnect retry (fail then recover)

State lifecycle:
□ SCC-C40: [UC-S10] ConfigPanel cursor/drilldown survives close/reopen

Tests: agent/tests/test-config-tui-components.ts (add ~20 tests to existing file from Group 2a).

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-config-tui-components.ts

EXIT GATE (once, when declaring group DONE — Spec 1 Phases A-C complete):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts tests/test-config-tui-components.ts
```

---

## Group 3: Phase D — SETUP Wizard (Spec 1)

```
/trd Implement qlaybot v0.4.0 Phase D: SETUP Wizard.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec1-config-tui-design.md (section 3, section 10 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts
- Test helpers: agent/tests/helpers/ (config-builder.ts for tmpDir, ink-helpers.ts for rendering)
- Current source: agent/src/cli.ts, agent/src/config.ts (initializeUserDir, isInitialized)
- Prerequisite code: Phases A-C complete (config save, ConfigPanel, all config types)

IMPORTANT — Integration rules:
- Wizard uses saveModelConfig, saveKLayoutConfig, saveMCPConfig, saveSettingsConfig from Phase A
- Wizard result feeds into ConfigPanel (user can re-run via /config setup)
- initializeUserDir() must write workspace/subagent/*.md templates for Spec 2

Scope (8 items):
1. setup.ts — wizard logic: 6-step flow (Welcome → API Key → Model → MCP → Vector Search → Confirm)
2. SetupWizard.tsx — Ink component with masked input for API key, step state machine
3. KLayout MCP auto-detect via HTTP health check at :8765
4. Vector search optional step (embedding API URL + key, sets search.mode)
5. cli.ts gate: if !isInitialized(), run wizard in interactive mode or initializeUserDir() in JSON/RPC mode
6. /config setup command re-runs wizard with config backup
7. initializeUserDir() updated to write subagent role defaults + search/embedding defaults to settings.json, copy workspace/subagent/*.md templates
8. CLI entry points: `qlaybot setup` as new CLI command (runs wizard directly), `qlaybot onboard` becomes alias to `qlaybot setup` (backward compat). Both run the interactive wizard. cli.ts commands become: run | onboard | setup | uninstall | help | slash

=== SPEC COMPLIANCE CHECKLIST ===

□ SCC-D1: API key input is masked (shows ******* not plaintext)
□ SCC-D2: Step 1 (Welcome) shows version and intro text
□ SCC-D3: Step 2 (API Key) validates non-empty key before proceeding
□ SCC-D4: Step 3 (Model) offers model list from registry, default pre-selected
□ SCC-D5: Step 4 (MCP) auto-detects KLayout via HTTP GET to :8765, shows ✓ or ✗
□ SCC-D6: Step 5 (Vector Search) is skippable — Enter with empty fields skips
□ SCC-D7: Step 6 (Confirm) shows summary of all choices before writing
□ SCC-D8: Wizard writes all 4 config files (model.json, klayout.json, mcp.json, settings.json)
□ SCC-D9: /config setup backs up existing config before re-running wizard
□ SCC-D10: initializeUserDir writes workspace/subagent/scout.md, designer.md, analyst.md, planner.md
□ SCC-D11: initializeUserDir writes subagent defaults to settings.json
□ SCC-D12: Non-interactive mode (JSON/RPC) calls initializeUserDir() without wizard UI
□ SCC-D13: Wizard → session E2E: run wizard → createDesignSession(tmpDir) → session has correct model from wizard choice
□ SCC-D14: Wizard with embedding creds → settings.json search.mode auto-set to "fts5+vector+rerank" (or appropriate based on Anthropic availability)
□ SCC-D15: `qlaybot setup` CLI command runs the interactive wizard (same as first-run auto-trigger)
□ SCC-D16: `qlaybot onboard` is alias to `qlaybot setup` — both run wizard, backward compatible
□ SCC-D17: `/config setup` inside TUI re-runs wizard with existing config backed up first
□ SCC-D18: [UC-7] Wizard accepts env API key: ANTHROPIC_API_KEY env var set → wizard step 2 shows "[env: ****...****]" → Enter accepts env key → config written with env-provided key path → session starts normally
□ SCC-D19: [UC-9] /config setup on legacy config: old mcp.json has klayout_mcp + other servers → /config setup → backup created → wizard completes → stale klayout_mcp removed from mcp.json → other MCP entries preserved → klayout.json is authoritative
□ SCC-D20: [UC-E1] Invalid API key during SETUP: wizard step 2 → enter non-empty but invalid key → press Enter → wizard shows validation error → stays on step 2 → does NOT proceed to model step → no config files written yet
□ SCC-D21: [UC-E3] /config setup recovery from corrupted config: manually corrupt settings.json → /config setup → backup of corrupt file created → wizard completes → valid config files rewritten → session continues

Tests: add to agent/tests/test-config-tui.ts (~8 tests). Use real HTTP for MCP detection (KLayout at :8765 if running, handle unavailable gracefully).

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-config-tui.ts

EXIT GATE (Spec 1 exit gate — ALL Spec 1 tests):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts tests/test-config-tui-components.ts
```

---

## Group 4: Phases E+F — Subagent Core + Delegation Wiring (Spec 2)

```
/trd Implement qlaybot v0.4.0 Phases E+F: Subagent Core + Delegation Wiring.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec2-subagents-design.md (sections 2-4, 7, section 9 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts (RoleConfig, SubagentResult, SubagentRunOptions, SubagentTUIEntry, SubagentSegment)
- Test helpers: agent/tests/helpers/ (test-factories.ts for real API instances)
- Current source: agent/src/agent.ts, agent/src/tools/index.ts, agent/src/planning/index.ts, agent/src/config.ts, agent/src/tools/annotations.ts
- Prerequisite code: Spec 1 complete (config has SubagentConfig, tool annotations exist, focusState has all 9 states)

IMPORTANT — Integration rules:
- Import ALL subagent types from contracts (RoleConfig, SubagentResult, etc.). Do NOT redefine.
- SubagentRunner must emit events matching SubagentTUIEntry/SubagentSegment shapes from contracts (Group 5 TUI will consume these)
- delegate tool must NOT appear in subagent tool lists (no nesting)
- memory_search in subagent tools MUST use `await` (forward-compat for Spec 3)
- Tool annotations from Phase A determine read-only proxy behavior — import and use them

Phase E scope (8 items):
1. subagent/types.ts — re-export from contracts, add internal-only types (SubagentSession internal state)
2. subagent/role-resolver.ts — resolveRole(), listRoles(), validateRoles() — pure config lookup
3. subagent/tool-factory.ts — createSubagentTools() with read-only MCP proxy using annotations from Phase A
4. subagent/tool-factory.ts — submit_result tool with first-wins callback, delegate filtered
5. subagent/prompt-builder.ts — buildSubagentPrompt(), buildTaskMessage()
6. subagent/transcript.ts — TranscriptLogger with markdown format + log rotation
7. subagent/runner.ts — SubagentRunner with 14-step pipeline, EventEmitter, multi-session management
8. subagent/runner.ts — pause/resume/inject/kill per subagent ID, budget enforcement

Phase F scope (5 items):
1. tools/delegate.ts — createDelegateTool() with role validation
2. agent.ts wiring: create SubagentRunner, add delegate tool, add "delegate" to plan mode ALLOWED_TOOLS
3. Dynamic delegation section in system prompt (generated from config roles)
4. workspace/subagent/ template prompt files: scout.md, designer.md, analyst.md, planner.md
5. Subagent memory_search uses parent's MemoryManager (write as `await` from the start)

=== SPEC COMPLIANCE CHECKLIST ===

Role System (from Spec 2 §2):
□ SCC-E1: resolveRole("scout") returns scout config from settings.json
□ SCC-E2: resolveRole("unknown_role") returns null (not throw)
□ SCC-E3: listRoles() returns all configured roles with labels
□ SCC-E4: validateRoles() rejects config with missing required fields (label, promptFile, baseTools, maxTurns, maxTokens)
□ SCC-E5: Roles are fully config-driven — no hardcoded role names in code

Tool Factory (from Spec 2 §2.4, §4):
□ SCC-E6: Read-only MCP proxy blocks tools with access:"readwrite", allows access:"readonly"
□ SCC-E7: submit_result tool available to subagents
□ SCC-E8: submit_result first-wins: second call returns error, first result used
□ SCC-E9: delegate tool NOT in subagent tool list (no nesting)
□ SCC-E10: Subagent gets base tools from role config (not all base tools)

Runner (from Spec 2 §3):
□ SCC-E11: Runner emits "started" event with { subagentId, toolCallId }
□ SCC-E12: Runner emits "thinking", "text", "tool_start", "tool_end" events during execution
□ SCC-E13: Budget enforcement: exceeding maxTurns stops agent, returns partial result
□ SCC-E14: Budget enforcement: exceeding maxTokens stops agent, returns partial result
□ SCC-E15: pause(id) halts subagent, resume(id) continues
□ SCC-E16: inject(id, message) inserts user message into subagent conversation
□ SCC-E17: kill(id) aborts session, returns SubagentResult with status:"partial" and errorMessage:"Killed by user"
□ SCC-E18: TranscriptLogger writes markdown file with tool calls and results

Delegation (from Spec 2 §4):
□ SCC-F1: createDelegateTool() returns tool with parameters: role, task, context
□ SCC-F2: Calling delegate with unknown role returns error listing available roles
□ SCC-F3: delegate tool wired into agent.ts tool list
□ SCC-F4: delegate in plan mode ALLOWED_TOOLS list
□ SCC-F5: System prompt includes dynamic delegation section with role descriptions

Tests: agent/tests/test-subagent.ts (~55 tests including all SCC items).
Use REAL APIs — credentials in ~/.keys/api_settings.md. No mocks for Agent SDK or MCP calls.

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-subagent.ts

EXIT GATE (once, when declaring group DONE):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts tests/test-config-tui-components.ts tests/test-subagent.ts
```

---

## Group 5: Phase G — Subagent TUI (Spec 2)

```
/trd Implement qlaybot v0.4.0 Phase G: Subagent TUI.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec2-subagents-design.md (sections 5-6, section 9 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts (SubagentTUIEntry, SubagentSegment, FocusState)
- Test helpers: agent/tests/helpers/ (ink-helpers.ts for rendering, pressKey, stripAnsi)
- Current source: agent/src/tui/components/App.tsx, agent/src/tui/reducer.ts, agent/src/tui/types.ts, agent/src/tui/components/StatusBar.tsx
- Prerequisite code: Group 4 complete — SubagentRunner with EventEmitter, delegate tool, all subagent core

IMPORTANT — Integration rules:
- SubagentTUIEntry and SubagentSegment come from contracts — import, do not redefine
- SubagentRunner events (from Group 4) are the data source — subscribe to runner.on() in App.tsx
- Focus states "subagent-summary", "subagent-inspect", "subagent-inject" already declared in contracts
- Two-phase ID mapping: toolCallId from tool_execution_start → subagentId from runner "started" event

Scope (6 items):
1. SubagentPanel.tsx — two-level panel: summary bar + inspect window
2. Summary bar: Up/Down navigate entries, Enter inspects, i injects, k kills, Escape closes
3. Inspect window: segment rendering (thinking/text/tool_call/injected), Left/Right switch subagent, Up/Down scroll
4. Inject mode: inline input field, Enter sends to runner, Escape cancels. Focus: i→subagent-inject, Enter/Escape→back
5. StatusBar: magenta "N sub" badge derived from subagents.filter(running).length
6. App.tsx: Ctrl+S shortcut, runner event subscription, two-phase ID mapping

=== SPEC COMPLIANCE CHECKLIST ===

SubagentPanel rendering (from Spec 2 §5):
□ SCC-G1: Summary bar shows status icon per subagent: ● running, ✓ completed, ✗ error, ◐ partial
□ SCC-G2: Summary bar shows role name, truncated task, elapsed time, token count
□ SCC-G3: Up/Down selects different entries in summary (highlighted row)
□ SCC-G4: Enter on selected entry opens inspect window (focus → subagent-inspect)
□ SCC-G5: Inspect window shows segments in order: thinking, text, tool_call, injected
□ SCC-G6: Left/Right in inspect switches between subagents
□ SCC-G7: Up/Down in inspect scrolls segment content
□ SCC-G7a: Ctrl+T in inspect toggles expanded/collapsed — collapsed: last ~5 lines thinking + summary tool results; expanded: full thinking text + full tool results
□ SCC-G8: Escape from inspect returns to summary (focus → subagent-summary)
□ SCC-G9: Escape from summary closes panel (focus → input)

Inject/Kill (from Spec 2 §6):
□ SCC-G10: i key on running subagent opens inline input field (focus → subagent-inject)
□ SCC-G11: Enter in inject mode sends message via runner.inject() + runner.resume()
□ SCC-G12: Escape in inject mode cancels without sending (focus → back to panel)
□ SCC-G13: k key on running subagent calls runner.kill(), entry shows status "partial" with "Killed by user"
□ SCC-G14: i/k only work on running subagents (no-op on completed/error)
□ SCC-G14a: Injection happens between turns — if tool is executing, inject waits for tool completion (§6.4)
□ SCC-G14b: Kill mid-tool: tool runs to completion, then session stops (no forceful mid-tool termination)

StatusBar & Shortcuts (from Spec 2 §5.2):
□ SCC-G15: StatusBar shows magenta "N sub" when N>0 running subagents
□ SCC-G16: StatusBar shows nothing when 0 running subagents
□ SCC-G17: Ctrl+S toggles SubagentPanel open/closed

Focus Exclusivity in SubagentPanel (CRITICAL — same pattern as ConfigPanel):
□ SCC-G20a: Enter in SubagentPanel inspect view does NOT send InputBox message
□ SCC-G20b: Up/Down in SubagentPanel does NOT trigger InputBox history navigation
□ SCC-G20c: Typing 'i' for inject does NOT insert character into InputBox
□ SCC-G20d: Escape from SubagentPanel returns to input focus, does NOT abort running agent
□ SCC-G20e: [UC-10] Panel-to-panel switch: SubagentPanel open (Ctrl+S) → press Ctrl+N → ConfigPanel takes sole focus, SubagentPanel keyboard stops, InputBox remains inert → Escape from ConfigPanel → focus returns to input (not SubagentPanel)
□ SCC-G20f: [UC-11] ConfigPanel edit interrupted by Ctrl+S: user is editing a Settings value in ConfigPanel → Ctrl+S → edit exits cleanly without committing partial value → focus moves to subagent-summary → Settings value unchanged on disk

State lifecycle:
□ SCC-G20g: [UC-S5] Completed subagent result survives panel close/reopen: delegate scout → completes with ✓ → inspect segments → close panel → reopen → same entry with ✓ status, same segments, same token count
□ SCC-G20h: [UC-S6] Runner events accumulate while panel is closed: delegate subagent → immediately close panel → subagent runs (thinking/text/tool events fire) → reopen panel → ALL segments present in correct order
□ SCC-G20i: [UC-S11] Subagent inspect scroll/selection survives close/reopen: inspect subagent → scroll to middle → close panel → reopen → inspect same subagent → scroll offset and selection preserved

ID Mapping (from Spec 2 §5.7):
□ SCC-G18: delegate tool_execution_start creates placeholder entry with toolCallId
□ SCC-G19: runner "started" event updates entry id from toolCallId to subagentId
□ SCC-G20: Subsequent runner events use subagentId to target correct entry

TUI Testing Patterns (MANDATORY):
- Use ink-testing-library render() for SubagentPanel with real runner entries
- Use pressKey(stdin, "up/down/enter/escape/i/k") for keyboard events
- Test reducer SUBAGENT_* actions separately: SUBAGENT_START, SUBAGENT_THINKING, SUBAGENT_TEXT, SUBAGENT_TOOL_START, SUBAGENT_TOOL_END, SUBAGENT_INJECT, SUBAGENT_END
- Verify rendered output contains specific icons and text via stripAnsi()

Tests: agent/tests/test-subagent-components.ts (~18 tests including all SCC items).

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-subagent-components.ts

EXIT GATE (once, when declaring group DONE):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts tests/test-config-tui-components.ts tests/test-subagent.ts tests/test-subagent-components.ts
```

---

## Group 6: Phase H — Subagent E2E + Verification (Spec 2)

```
/trd Implement qlaybot v0.4.0 Phase H: Subagent E2E Tests + Full Verification.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec2-subagents-design.md (section 9 E2E tests)
- All source from Groups 0-5
- Existing test suites: agent/tests/test-unit.ts (106), test-components.ts (51), test-compaction.ts (15), test-e2e.ts (14)

IMPORTANT — This group's primary job is VERIFICATION, not new features.

Scope (5 items):
1. agent/tests/test-subagent-e2e.ts — full delegation pipeline with REAL Agent SDK + API (scout gets read-only, designer gets full, structured results)
2. Concurrent subagent test: spawn scout + designer, kill scout, verify designer continues, check both transcripts
3. Budget enforcement E2E: low maxTurns budget, verify partial result with correct status
4. TUI integration E2E: delegate → SubagentPanel shows entry → keyboard nav → inject → kill → verify panel updates (this is the CROSS-LAYER test that verifies runner events flow through to TUI rendering)
5. FULL REGRESSION: npm run build && npm test (ALL test files — 186 existing + all new Spec 1/2 tests)

=== SPEC COMPLIANCE CHECKLIST ===

Runner-level (backend):
□ SCC-H1: Scout subagent cannot call readwrite MCP tools (verify via tool list inspection or real delegation test)
□ SCC-H2: Designer subagent CAN call readwrite MCP tools
□ SCC-H3: Both subagents produce transcript files in logDir
□ SCC-H4: Killing one subagent does not affect another running concurrently
□ SCC-H5: Budget enforcement produces SubagentResult with status:"partial"

Backend cross-layer (flows crossing config → subagent → disk):
□ SCC-H5a: Workspace files in prompt: role config has workspaceFiles:["SOUL.md"] → subagent system prompt contains SOUL.md content
□ SCC-H5b: Transcript rotation: run maxLogFiles+1 subagents → oldest transcript deleted, newest preserved
□ SCC-H5c: Disabled tool + subagent: disable klayout_geometry_add_rect in config → delegate designer → designer tool list excludes add_rect
□ SCC-H5d: Per-server MCP disabled tools: disable tool in mcp.json per-server → subagent with "full" MCP access still can't use it
□ SCC-H5e: [UC-1] Disable tool then delegate immediately: /mcp disable auto_route → same session, no restart → delegate designer → designer tool list does NOT contain auto_route (runtime tool assembly refreshed)
□ SCC-H5f: [UC-16] Delegate in plan mode + TUI: enter plan mode → agent calls delegate(scout) → delegate allowed (in ALLOWED_TOOLS) → SubagentPanel shows scout running → subagent completes → panel shows ✓
□ SCC-H5g: [UC-17] Kill targets correct subagent after Left/Right: two subagents running → inspect first → Left/Right to switch to second → press k → ONLY second is killed → first continues running → verify by ID
□ SCC-H5h: [UC-18] Large tool result in subagent: subagent tool returns very large JSON → inspect window shows truncated segment (responsive, not frozen) → Ctrl+T expands full result → transcript file stores FULL result (not truncated)

Error/boundary paths:
□ SCC-H5i: [UC-E2] Running subagent isolation from config change: start designer subagent → disable auto_route in MCP tab → start second designer → first subagent KEEPS auto_route (already assembled) → second subagent does NOT have auto_route
□ SCC-H5j: [UC-E13] Token budget exhausted during streaming: subagent streams long output → token limit hit at streaming checkpoint → runner aborts → entry transitions to ◐ partial in TUI immediately (not stuck as ● running)
□ SCC-H5k: [UC-E14] Inject + maxTurns boundary: pause subagent via i → inject message → Enter → injected segment recorded → but next turn is maxTurns → budget blocks → exits partial with inject recorded in transcript
□ SCC-H5l: [UC-E15] No submit_result before forced stop: subagent killed or budget-stopped before calling submit_result → runner synthesizes partial result → delegate tool returns structured output (not hang or undefined) → transcript written

State lifecycle:
□ SCC-H5m: [UC-S13] Auto-compaction doesn't affect running subagent: parent hits 90% context → auto-compact fires → subagent continues running normally (ephemeral session, no compaction) → subagent completes → result returned to parent

TUI integration (cross-layer — the test Group 5 can't do alone):
□ SCC-H9: Delegate tool fires → SubagentPanel summary shows new entry with ● running icon
□ SCC-H10: Runner "thinking" event → inspect window shows thinking segment in real time
□ SCC-H11: Runner "text" event → inspect window shows text segment
□ SCC-H12: Runner "tool_start"/"tool_end" events → inspect window shows tool_call segment with name + result
□ SCC-H13: Up/Down in summary bar selects between 2+ concurrent subagent entries (highlight moves)
□ SCC-H14: Enter on selected entry → inspect window opens showing that subagent's segments
□ SCC-H15: Up/Down in inspect window scrolls through the subagent's conversation history (thinking→text→tool segments)
□ SCC-H15a: Left/Right in inspect window switches to previous/next subagent (header updates with new role/task/time)
□ SCC-H16: Press i on running entry → inject input appears → type message → Enter → runner.inject() called → "injected" segment appears in inspect
□ SCC-H17: Press k on running entry → runner.kill() called → entry status changes to ◐ partial → "Killed by user" shown
□ SCC-H18: StatusBar badge updates: "2 sub" → kill one → "1 sub" → complete → badge disappears
□ SCC-H19: Ctrl+S opens panel with entries, Escape closes, Ctrl+S reopens with state preserved

Regression:
□ SCC-H6: ALL 186 existing v0.3 tests still pass (no regressions)
□ SCC-H7: ALL new Spec 1 tests (config + components) still pass
□ SCC-H8: ALL new Spec 2 tests (subagent + components) still pass

TUI integration test pattern (MANDATORY for SCC-H9 through H19):
Use ink-testing-library to render App with a REAL SubagentRunner + real API.
Wire runner events to TUI reducer via the same EventEmitter bridge App.tsx uses.
This tests the full chain: delegate tool → runner → events → reducer → render → keyboard → runner method.
Credentials: load from ~/.keys/api_settings.md via test-factories.ts.

```typescript
// Example: TUI integration test skeleton
it("delegate → panel shows entry → inject → kill flow", async () => {
  const config = createTestConfig(); // real API creds from ~/.keys/api_settings.md
  const runner = new SubagentRunner(config);
  const { stdin, lastFrame } = render(<App runner={runner} {...props} />);

  // 1. Trigger delegate (real API call)
  await runner.run({ role: "scout", task: "explore layout" });

  // 2. Open panel
  pressKey(stdin, "ctrl-s");
  expect(stripAnsi(lastFrame()!)).toContain("● scout");
  expect(stripAnsi(lastFrame()!)).toContain("explore layout");

  // 3. Navigate and inspect
  pressKey(stdin, "enter");
  expect(stripAnsi(lastFrame()!)).toContain("thinking"); // or segments

  // 4. Inject
  pressKey(stdin, "i");
  stdin.write("check layer 3 too");
  pressKey(stdin, "enter");
  // Verify injected segment appears

  // 5. Kill
  pressKey(stdin, "escape"); // back to summary
  pressKey(stdin, "k");
  expect(stripAnsi(lastFrame()!)).toContain("◐"); // partial status
});
```

Tests: agent/tests/test-subagent-e2e.ts (~19 tests: 5 runner-level + 11 TUI integration + 3 regression checks. QLAYBOT_E2E=1 for real API tests).

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-subagent-e2e.ts

EXIT GATE (FULL SUITE — Spec 2 verification):
cd agent && npm run build && npm test
ALL test files must pass: 186 existing + all new Spec 1/2 tests.

If ANY test fails, fix the regression before declaring done.
```

---

## Group 7: Phases I+J — Search Core + Integration (Spec 3)

```
/trd Implement qlaybot v0.4.0 Phases I+J: Search Core + Integration.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec3-search-retrieval-design.md (sections 2-7, section 11 testing)
- Implementation order v2: docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md
- Contracts: agent/src/types/v04-contracts.ts (SearchMode, SearchConfig, EmbeddingConfig, Embedder, RerankResult)
- Test helpers: agent/tests/helpers/ (test-factories.ts for real API instances)
- Current source: agent/src/memory/index.ts, agent/src/memory/auto-recall.ts, agent/src/tools/memory.ts, agent/src/commands/memory.ts, agent/src/agent.ts, agent/src/config.ts
- Prerequisite code: Spec 1 complete (config has SearchConfig + EmbeddingConfig). Spec 2 complete (subagent memory_search already uses await).

IMPORTANT — Integration rules:
- Import SearchMode, Embedder, RerankResult from contracts. Do NOT redefine.
- search() signature change (sync → async) must not break existing callers
- auto-recall.ts, memory command, memory_search tool ALL must await the new async search()
- Subagent tool-factory's memory_search (from Group 4) already uses await — verify it still works

Phase I scope (7 items):
1. memory/embedder.ts — Embedder interface (from contracts) + APIEmbedder (OpenAI-compatible /embeddings)
2. memory/vector-search.ts — cosineSimilarity(), vectorSearch(), deduplicateResults()
3. memory/reranker.ts — rerankResults() via Haiku, caching with SHA-256 key
4. memory/index.ts — search() becomes async with 4-mode dispatch
5. memory/index.ts — disk-based SQLite (~/.qlaybot/memory/index.sqlite) with memory_embeddings table
6. memory/index.ts — reindexEmbeddings() in reindex() — batch API call for new entries
7. Score normalization: FTS5 ranks normalized to 0-1

Phase J scope (5 items):
1. Update auto-recall.ts to await async search()
2. Update /memory search command and memory_search tool handler to await
3. search.mode config-time validation (reject vector without embedding, reject rerank without Anthropic)
4. Add search.* and embedding.* to SETTABLE_KEYS for ConfigPanel
5. agent.ts wiring: create Embedder from config, pass to MemoryManager constructor

=== SPEC COMPLIANCE CHECKLIST ===

Embedder (from Spec 3 §6):
□ SCC-I1: APIEmbedder.embed() calls POST /embeddings with correct model and input
□ SCC-I2: APIEmbedder.embedBatch() sends array of inputs in single call
□ SCC-I3: Embedder factory returns null when embedding config missing (vector modes unavailable)

Vector Search (from Spec 3 §3):
□ SCC-I4: cosineSimilarity(identical, identical) = 1.0
□ SCC-I5: cosineSimilarity(orthogonalA, orthogonalB) = 0.0
□ SCC-I6: vectorSearch returns results above similarityThreshold, sorted by score
□ SCC-I7: deduplicateResults keeps highest-scored duplicate (by content hash)

Reranker (from Spec 3 §4):
□ SCC-I8: Reranker finds Anthropic provider automatically from config
□ SCC-I9: Reranker skips when result count < minRerank
□ SCC-I10: Reranker falls back gracefully on API error (returns unsorted results)
□ SCC-I11: Rerank cache: same query + same entries → cache hit, no second API call
□ SCC-I12: Rerank cache invalidates on reindex

Search Modes (from Spec 3 §5):
□ SCC-I13: "fts5" mode uses only FTS5, no embedding call
□ SCC-I14: "fts5+rerank" mode: FTS5 → rerank (no vector)
□ SCC-I15: "fts5+vector+rerank" mode: FTS5 + vector → deduplicate → rerank
□ SCC-I16: "vector+rerank" mode: vector → rerank (no FTS5)
□ SCC-I17: resolveMode() falls back to "fts5" when vector mode requested without embedding config

Database (from Spec 3 §8):
□ SCC-I18: memory_embeddings table stores entry_hash, content, embedding blob
□ SCC-I19: Embeddings persist on disk (survive process restart)
□ SCC-I20: FTS5 table unchanged (backward compatible)

Integration (from Spec 3 §5.1):
□ SCC-J1: auto-recall.ts awaits async search() (no sync assumption)
□ SCC-J2: /memory search awaits async search()
□ SCC-J3: memory_search tool awaits async search()
□ SCC-J4: Vector mode rejected at config time when embedding not configured
□ SCC-J5: Rerank mode rejected at config time when no Anthropic provider

Worktime use cases (cross-layer, runtime behavior):
□ SCC-J6: [UC-4] Configure embedding + mode then query same session: set embedding.baseUrl + apiKey + model in ConfigPanel → set search.mode=fts5+vector+rerank → close panel → /memory search query → search uses vector+rerank pipeline immediately (no restart)
□ SCC-J7: [UC-5] Switch to OpenAI model, Anthropic rerank still works: select openai/model as default in Models tab → keep search.mode=fts5+rerank → /memory search → reranker finds Anthropic provider from config (not tied to defaultModel provider)
□ SCC-J8: [UC-19] Rapid memory saves respect reindex throttle: call memory_save 5 times quickly → reindexEmbeddings() batched by minReindexMs → embedding API called at most once within throttle window → no burst of API calls

Error/degradation paths:
□ SCC-J9: [UC-E7] Haiku rerank timeout during auto-recall: search.mode=fts5+rerank → send prompt triggering auto-recall → rerank call times out → warning logged → fallback to FTS-ranked results → auto-recall still injects memories → agent turn continues
□ SCC-J10: [UC-E8] Reranker returns malformed JSON: reranker API returns invalid JSON scores → parse error handled as rerank failure → /memory search returns FTS-ranked candidates (not crash)
□ SCC-J11: [UC-E9] Embedding API 5xx during search: mode=fts5+vector+rerank → embedder returns 500 on query embedding → search degrades to FTS5 candidates only → results returned (not crash or empty)
□ SCC-J12: [UC-E10] True zero-result search: /memory search with unrelated query → no FTS hit, no vector hit → empty result set returned cleanly → rerank skipped (below minRerank) → no error
□ SCC-J13: [UC-E11] Disk SQLite unavailable: ~/.qlaybot/memory/ not writable → MemoryManager falls back to :memory: → search/save still work for session (not persisted)
□ SCC-J14: [UC-E12] Pre-v0.4 DB missing embeddings table: old index.sqlite has FTS5 only → v0.4 launch → memory_embeddings table auto-created → FTS5 data still searchable → vector reindex works

State lifecycle / DB persistence:
□ SCC-J15: [UC-S7] FTS-only DB upgrades in-place: existing index.sqlite with FTS5 data → v0.4 startup → embeddings table added if missing → existing FTS5 entries unaffected → hybrid search works
□ SCC-J16: [UC-S8] Deferred embedding backfill: accumulate entries in fts5 mode → later configure embedding + vector mode → reindex batch-embeds ALL old entries → restart → reindex skips already-embedded rows
□ SCC-J17: [UC-S9] Mode switch on same corpus: query in fts5 mode → switch to fts5+vector+rerank → restart → query same corpus → hybrid pipeline deduplicates and returns merged results from both FTS5 and vector

Tests: agent/tests/test-search.ts (~32 tests including all SCC items).
Use REAL APIs for all tests — credentials in ~/.keys/api_settings.md (Anthropic, OpenAI chat, OpenAI embeddings).
No mocks needed for embedding or reranking — hit real endpoints.

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-search.ts

EXIT GATE (includes subagent tests — search() async change affects subagent memory_search):
cd agent && npm run build && npx vitest run tests/test-contracts.ts tests/test-config-tui.ts tests/test-config-tui-components.ts tests/test-subagent.ts tests/test-subagent-components.ts tests/test-subagent-e2e.ts tests/test-search.ts
```

---

## Group 8: Phase K — Search Tests + Final v0.4.0 Verification (Spec 3)

```
/trd Implement qlaybot v0.4.0 Phase K: Search Integration Tests + Final v0.4.0 Verification.

READ FIRST:
- Spec: docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec3-search-retrieval-design.md (section 11 testing)
- All source from Groups 0-7
- Existing test suites: agent/tests/test-unit.ts (106), test-components.ts (51), test-compaction.ts (15), test-e2e.ts (14)

Scope (5 items):
1. agent/tests/test-search-integration.ts — mode-driven integration tests (each mode end-to-end with REAL APIs)
2. Persistence tests: embeddings survive restart (write, close DB, reopen, verify)
3. Auto-recall pipeline E2E: save memory → reindex → search via transformContext → verify recalled content
4. Graceful degradation: vector mode without embedding config falls back to fts5, rerank without Anthropic falls back
5. Final v0.4.0: npm run build && npm test (FULL suite). Update agent/CLAUDE.md and agent/README.md. Bump package.json to 0.4.0.

=== SPEC COMPLIANCE CHECKLIST ===

□ SCC-K1: fts5 mode integration: save entry → search → found
□ SCC-K2: fts5+rerank integration: save entry → search → reranked order correct
□ SCC-K3: fts5+vector+rerank integration: save → embed → search → deduplicated + reranked
□ SCC-K4: vector+rerank integration: save → embed → search → found via similarity
□ SCC-K5: Embeddings survive restart (close MemoryManager, create new one, embeddings still there)
□ SCC-K6: Auto-recall: save memory → reindex → agent prompt → recalled content in context
□ SCC-K7: Graceful degradation: vector mode + no embedding → falls back to fts5 (not crash)
□ SCC-K8: Graceful degradation: rerank + no Anthropic → resolveMode() falls back to fts5 equivalent (e.g., "fts5+rerank" → "fts5"), not crash
□ SCC-K8a: Config → search mode E2E: /config set search.mode vector+rerank without embedding → error message returned (not crash, not silent)
□ SCC-K8b: Config → search mode E2E: /config set search.mode fts5+rerank with Anthropic provider → succeeds, subsequent memory_search uses reranking
□ SCC-K8c: [UC-20] Subagent uses parent's updated search mode: change search.mode to fts5+vector+rerank → delegate scout "find similar issues" → scout's memory_search uses parent MemoryManager with updated hybrid mode → results reflect vector+rerank pipeline

Cross-restart persistence (state lifecycle):
□ SCC-K8d: [UC-S1] Model persists across restart + subagent fallback: set openai/model in ConfigPanel → exit → restart → /model show confirms → delegate scout (no role-level model override) → scout resolves to same persisted default
□ SCC-K8e: [UC-S2] Disabled tools survive restart: disable KLayout tool + generic MCP tool → restart → /mcp tools shows both disabled → delegate designer → both tools excluded from subagent
□ SCC-K8f: [UC-S3] Search mode + embedding config survive restart: configure fts5+vector+rerank + embedding creds → exit → restart → first query triggers auto-recall with hybrid mode (no reconfiguration needed)
□ SCC-K8g: [UC-S4] Manual invalid config edit falls back safely: save vector mode → manually clear embedding.apiKey in settings.json → restart → resolveMode() falls back to fts5 (not crash) → search works in degraded mode
□ SCC-K9: ALL 186 existing v0.3 tests still pass
□ SCC-K10: ALL Spec 1 tests pass
□ SCC-K11: ALL Spec 2 tests pass
□ SCC-K12: ALL Spec 3 tests pass
□ SCC-K13: package.json version = "0.4.0"
□ SCC-K14: agent/CLAUDE.md updated with v0.4 commands, shortcuts, config structure

Tests: agent/tests/test-search-integration.ts (~12 tests, QLAYBOT_E2E=1 for real API).

ITERATION GATE (every TRD cycle):
cd agent && npm run build && npx vitest run tests/test-search-integration.ts

EXIT GATE (FULL SUITE — the v0.4.0 release gate):
cd agent && npm run build && npm test
ALL test files must pass. This is the final verification before v0.4.0 release.
```

---

---

## Post-Group Audit Protocol

After each TRD group completes, run a **lightweight independent audit** before proceeding to the next group:

1. **SCC cross-check**: Open the spec section(s) for the completed group. For each SCC item, grep the test file to verify a test exists that references it. Missing SCC coverage = group not done.
2. **Contract integrity**: Run `npx vitest run tests/test-contracts.ts` — if any contract test fails, the group broke a shared interface.
3. **Export verification**: For each new module created, verify its public exports match what downstream groups expect to import.
4. **Regression spot-check**: Pick 2-3 tests from a prior group and verify they still pass (the gate command does this, but spot-checking builds confidence).

This audit takes ~5 minutes and catches the "weak test" problem Codex identified: an agent could write a test named after an SCC item but with a trivial assertion. The audit step catches this by reading the actual test code.

---

## Summary of Changes from v1

| Aspect | v1 (failed) | v2 (this document) |
|--------|-------------|---------------------|
| Contracts | None — each group defined own types | Phase 0 creates shared contracts ALL groups import |
| Test scope | "Only your own test file" | Accumulative: all prior tests + own |
| Spec compliance | Implicit — hope Overseer covers it | Explicit SCC checklist per group (~120 items total) |
| TUI testing | "Use ink-testing-library" (vague) | Concrete patterns: reducer, render, pressKey, stripAnsi |
| Integration | Build check only | Build + accumulative tests + contract tests |
| Verification | Groups 6,8 run full suite | Groups 6,8 run full suite + SCC items verified |
| Test helpers | Each group invented own | Shared helpers in tests/helpers/ |
| Type safety | Each group might redefine types | Single source of truth: v04-contracts.ts |
