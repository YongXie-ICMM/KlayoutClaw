# qlaybot TODO

## v0.1.0: MVP (complete)

### Core Agent
- [x] Pi-Agent SDK wrapper with direct Agent + AgentSession construction
- [x] `createDesignSession()` factory with config loading
- [x] `baseToolsOverride` for read, bash, edit, write
- [x] `transformContext` hook for auto-recall memory injection
- [x] Context usage tracking via `getContextUsage()`

### MCP Layer
- [x] Custom KLayout HTTP JSON-RPC client (`klayout-client.ts`)
- [x] MCPManager with tool routing (dot-parse → underscore-based names)
- [x] KLayout auto-launch with platform detection (macOS/Linux/Windows)
- [x] Exponential backoff connection polling (1s → 2s → 4s → 8s)
- [x] Health check via `get_layout_info`
- [x] Lazy-load non-KLayout MCP servers on first tool call
- [x] 6 native KLayout tools registered

### Domain Tools (15 total)
- [x] geometry: add_rect, add_polygon, add_path, create_cell, add_instance (5)
- [x] display: toggle_layer, show_only (2)
- [x] image: add_image, list_images, remove_image (3)
- [x] visual: capture (1)
- [x] nanodevice: flakedetect_detect_stack, gdsalign_align_to_gds, routing_place_pads, routing_route_leads (4)
- [x] All domain tools generate real pya code executed via `execute_script`

### Memory System
- [x] SQLite FTS5 search via better-sqlite3 (porter unicode61 tokenizer)
- [x] Fallback to simple text matching for special-character queries
- [x] 4 categories: knowledge, procedures, preferences, log (date-based)
- [x] Auto-recall via transformContext hook (`<recalled-memories>` injection)
- [x] Memory budget enforcement (max entries per category + max file size)
- [x] Budget configurable via settings.json
- [x] memory_save + memory_search custom tools

### System Prompt
- [x] Modular assembly: tooling + mcp + memory + workspace context
- [x] Workspace files: SOUL.md, WORKFLOW.md, TOOLS.md, RULES.md (all substantive)
- [x] Knowledge placeholder dirs: core/, recipes/, learned/
- [x] PromptMode (Full vs Sub) for future subagent support

### CLI & Entry Points
- [x] 4 commands: run, onboard, uninstall, help
- [x] 3 modes: interactive (TUI), json (single-shot), rpc (stdin/stdout)
- [x] Flags: --mode, --message/-m, --model, --thinking, --cwd, --plain
- [x] Onboard creates ~/.qlaybot/ with config + workspace templates

### RPC Server
- [x] Methods: initialize, prompt, get_session_info, dispose, shutdown
- [x] Events: ready, prompt_start, content_delta, thinking, tool_use, tool_result, usage_update, error

### TUI
- [x] Ink/React terminal UI with 4 components (App, MessageList, InputBox, StatusBar)
- [x] useReducer state machine with 14 action types
- [x] Streaming text + thinking display + tool execution tracking

### Interaction History
- [x] Auto-save to ~/.qlaybot/history/YYYY-MM-DD/{sessionId}/ (fixed from /tmp/KLayoutClaw_History/)
- [x] transcript.jsonl, tool_calls/NNN_*.json, metadata.json
- [x] `latest` symlink to most recent session

### Config
- [x] ~/.qlaybot/config/ with model.json, mcp.json, settings.json
- [x] ANTHROPIC_API_KEY env var override for all providers
- [x] model.json: defaultModel, thinkingLevel, providers with per-model costs

### Testing
- [x] Unit: config, prompt building, tool schemas, pya code gen, FTS5 search, entry parsing, routing, naming
- [x] E2E 3a-3g: basic loop, MCP, memory, domain tools, auto-launch, error recovery, multi-turn
- [x] 40/40 tests passing

---

## v0.2.0: Commands, Planning, Background Tasks (complete)

### Command System
- [x] CommandRegistry class with register/execute/has/list/get
- [x] parseCommand() parser for `/command args` syntax
- [x] 9 command handlers: model, mcp, config, context, memory, plan, tasks, help, exit
- [x] Dual-mode: shell (`qlaybot model`) + TUI (`/model`) + RPC (`/model` in prompt)
- [x] Shell command routing in cli.ts (detect command names as first positional arg)
- [x] TUI command routing in App.tsx (intercept `/` prefix)
- [x] RPC command routing in rpc.ts (detect `/` prefix before session.prompt)
- [x] COMMAND_RESULT reducer action with stateChange support

### Planning Mode
- [x] PlanManager with enter/exit/isActive state machine
- [x] KLayout-aware sandbox: read-only allowlist (read, get_layout_info, screenshot, memory_save, memory_search)
- [x] wrapToolWithSandbox() wraps all base + custom tools
- [x] Blocked tools return structured error message (not crash)
- [x] Plan-mode system prompt injection via transformContext
- [x] /plan command handler (enter/exit/status)

### Background Tasks
- [x] BackgroundTaskManager with run/status/list/result methods
- [x] Deterministic allowlist: flakedetect_detect_stack, auto_route, save_layout
- [x] background_status + background_result custom tools
- [x] Subscribe/notify for task state changes
- [x] BackgroundBar TUI component (active task count)
- [x] BACKGROUND_UPDATE reducer action
- [x] backgroundTasks in get_session_info RPC response

### Thinking Toggle
- [x] showThinking state in TUI (default: false)
- [x] TOGGLE_THINKING_VIEW reducer action
- [x] Ctrl+T keybinding in InputBox
- [x] MessageList conditionally renders thinking blocks
- [x] [T] indicator in StatusBar when thinking visible
- [x] Compact `[thinking...]` indicator when hidden and streaming

### QlayBotSession Expansion
- [x] memoryManager, commandRegistry, planManager, backgroundTaskManager on interface
- [x] MemoryManager.clear(category) — deletes file, returns entry count
- [x] planMode + backgroundTasks in get_session_info

### CLI Polish
- [x] Global CLI via npm link (qlaybot at /opt/homebrew/bin/)
- [x] Full v0.2 CLI surface in help text
- [x] npm link guidance in onboard output
- [x] Shebang preserved in dist/cli.js

### MCPManager Extensions
- [x] getServerKeys(), getToolCount(), reconnect(), reconnectAll()

### Testing
- [x] Unit: commands (parseCommand, registry, all 9 handlers), planning (state, sandbox allow/block), background (lifecycle, subscribe, allowlist), memory.clear
- [x] E2E 4a: Slash commands via RPC (help, model, mcp, memory, unknown, bad args)
- [x] E2E 4b: Planning mode state (enter, mutating blocked, read-only allowed, exit)
- [x] E2E 4c: Sandbox enforcement (execute_script, create_layout, screenshot, unblocked after exit)
- [x] E2E 4d: Background tasks (status tool, get_session_info array)
- [x] E2E 4e: Agent autonomy (multi-layer structure from natural language)
- [x] E2E 4f: Multi-feature integration (model + create + plan + execute)
- [x] E2E 4g: Memory auto-recall (save session 1, recall session 2)
- [x] 82/82 tests passing (56 unit + 26 E2E)

---

## v0.3.0: TUI Overhaul + Context Compaction (complete)

### TUI Foundation
- [x] Theme system — centralized chalk-based color definitions (`src/tui/theme.ts`)
- [x] Markdown rendering — pi-tui Markdown class + cli-highlight for code blocks (`src/tui/markdown.ts`)
- [x] MarkdownText component — width-aware wrapper preventing Ink re-wrapping

### Input System
- [x] useInputBuffer hook — reducer-based text buffer with cursor position tracking
- [x] useCommandHistory hook — ↑/↓ navigation with draft save/restore, persistent to `~/.qlaybot/history.json`
- [x] Tab completion for `/` commands with CompletionList dropdown
- [x] InputBox rewrite — cursor rendering, Ctrl+A/E/D, history, completion

### Message Components
- [x] UserMessage — standalone component with cyan `>` prefix
- [x] AssistantMessage — segment-based rendering (ThinkingIndicator, MarkdownText, ToolPanel)
- [x] SystemMessage — markdown rendering for command output with optional structured sections
- [x] ThinkingIndicator — spinner while active, truncate to last ~10 lines, line count indicator
- [x] ToolPanel — compact mode (tool name + key arg + duration + summary) + expanded mode (full args + result)
- [x] MessageList rewrite — delegate to sub-components

### Status & Streaming
- [x] StreamingBar — live tokens, elapsed time, thinking badge, keybinding hints (yellow, visible during streaming)
- [x] ErrorBanner — dedicated red error display
- [x] StatusBar rewrite — MCP dot indicator, animated phase, context color thresholds (<70% green, 70-89% yellow, ≥90% red), plan/bg badges

### Interactive Panels
- [x] WorkspaceBar — collapsed integrity dot, expanded file list with Ctrl+W toggle, Up/Down/Enter/Escape
- [x] BackgroundBar rewrite — collapsed summary, expanded list with elapsed timers, k=cancel task

### Keyboard Shortcuts
- [x] Ctrl+T — toggle tool detail + thinking expansion (single shortcut for both)
- [x] ~~Ctrl+E — toggle thinking expansion only~~ (removed — Ctrl+E reserved for cursor end-of-line; Ctrl+T handles both)
- [x] Ctrl+W — toggle workspace panel
- [x] ~~Ctrl+B — move current tool to background~~ (deferred — requires signal/wrapper layer)
- [x] Ctrl+G — toggle background task panel
- [x] Escape — abort agent / close panel

### Context Compaction
- [x] CompactionConfig — thresholds (auto: 90%, warning: 70%), tool result pruning config
- [x] Tool result pruner — keep last 3, prune large old results with `[Pruned: tool — N bytes]` placeholders
- [x] State extractor — parse XML tags from compact summary → workspace/compaction/ files
- [x] State loader — inject `<compaction-state>` block into context via transformContext
- [x] Prompt loader — load COMPACT.md or KLayout-domain fallback instructions
- [x] 3-phase transformContext pipeline: pruner → stateLoader → autoRecall
- [x] `compact()` method on QlayBotSession
- [x] `/compact [instructions]` command
- [x] Auto-compaction on agent_end when context usage ≥ 90% (shouldAutoCompact pure function)

### App.tsx Rewrite
- [x] Global keyboard shortcut handling (always active, even during streaming)
- [x] Bar navigation state machine (workspace, background panels)
- [x] Auto-compaction check after each agent turn
- [x] Component tree: MessageList → ErrorBanner → StreamingBar → InputBox → WorkspaceBar → BackgroundBar → StatusBar

### Testing
- [x] Unit: markdown pipeline (renderMarkdown ANSI output, bullet replacement, code highlighting, empty input)
- [x] Unit: TUI reducer (new actions: BG_TASK, COMPACTION, PLAN_MODE, TOGGLE_TOOL_DETAIL)
- [x] Unit: compaction (pruner keeps last N, respects minSize/neverPrune; extractor parses XML; state loader injects block)
- [x] Unit: input hooks (buffer insert/delete/cursor, history push/navigate/draft)
- [x] Unit: tui/commands.ts (matchCommands prefix matching, formatHelpText completeness)
- [x] Unit: workspace integrity (missing/empty file detection)
- [x] Unit: /compact command registration (in COMMAND_NAMES + CommandRegistry)
- [x] E2E 5a: Markdown pipeline unit tests (TUI-only, not RPC-testable)
- [x] E2E 5b: Slash command completeness — `/help` lists all 10 commands, `/context` shows workspace, `/compact` callable
- [x] E2E 5c: Context compaction — large tool results, `/compact`, tokens don't increase, agent stays coherent
- [x] E2E 5d: Tool result pruning — deterministic unit tests primary; RPC secondary (context doesn't explode)
- [x] E2E 5e: Compaction state preservation — unit tests for extractTag/loadStateBlock; RPC secondary (state recalled after compact)
- [x] E2E 5f: Workspace integrity — `/context` returns file names, sizes, context usage
- [x] E2E 5g: Long session resilience — 10+ turns, context < 80%, coherent final query (QLAYBOT_NIGHTLY=1)
- [x] All existing 82 tests kept passing (443 total in v0.3)
- [x] Version bump to 0.3.0

---

## v0.4.0: Config + Subagents + Hybrid Search (in progress)

Implementation order: Phase 0 → Spec 1 → Spec 2 → Spec 3
Specs: `docs/superpowers/specs/2026-03-28-qlaybot-v0.4-spec{1,2,3}-*-design.md`
Dependency graph: `docs/superpowers/specs/2026-03-29-qlaybot-v0.4-implementation-order-v2.md`
TRD prompts: `docs/superpowers/trd-prompts-v2.md`

### v2 Design (2026-03-29)
- **10 groups** (Phase 0 + 9 TRD groups; Group 2 split into 2a/2b)
- **~259 SCC items** across all groups (spec compliance + worktime use cases + error paths + state lifecycle)
- **Two-tier test gates**: iteration gate (build + own tests, fast) → exit gate (build + all prior tests, once when done)
- **Real APIs for all tests** — credentials from `~/.keys/api_settings.md`, no mocks
- **Shared test helpers** in `tests/helpers/`: config-builder, ink-helpers, test-factories
- **Post-group audit protocol** for SCC traceability

### Phase 0: Contract Foundation (NOT TRD — single agent task)
- [ ] `src/types/v04-contracts.ts` — ALL cross-boundary interfaces
- [ ] `tests/helpers/config-builder.ts` — makeConfig, makeTmpDir, writeConfigFiles
- [ ] `tests/helpers/ink-helpers.ts` — stripAnsi, pressKey, waitForFrame
- [ ] `tests/helpers/test-factories.ts` — createTestConfig (real API creds), createTestMcpManager, createTestMemoryManager, createTestSubagentRunner
- [ ] `tests/test-contracts.ts` — ~20 contract verification tests
- [ ] Gate: `npm run build && npx vitest run tests/test-contracts.ts`

### Spec 1: Config System + SETUP + TUI Enhancements (Phases A-D)

#### Phases A+B: Config Primitives + TUI Foundation (Group 1, ~36 SCC)
- [ ] 4-file config split, QlayBotConfig, save functions, migration, resolveModel (5-step), OpenAI provider
- [ ] Tool annotations (boolean flags: readonly?, readwrite?, backgroundable?), disabledTools, array-replace save
- [ ] Focus state machine (9 states), focusState reducer, focus exclusivity (InputBox inert when panels open)
- [ ] Ghost text hints, subcommand hints, command recency persistence, CompletionList nav, bar nav
- [ ] History migration (array → {entries, recency}), multi-session recency evolution
- [ ] Iteration: `build + test-config-tui` | Exit: `build + contracts + test-config-tui`

#### Phase C1: ConfigPanel Settings + Models Tabs (Group 2a, ~25 SCC)
- [ ] ConfigPanel.tsx — 3-tab shell, Settings tab (SETTABLE_KEYS, edit mode), Models tab (picker, Enter sets default)
- [ ] Reducer: CONFIG_PANEL_OPEN/CLOSE/TAB_CHANGE/NAVIGATE/SELECT/EDIT_* actions, cursor persistence
- [ ] /config (bare) opens Settings, /model (bare) opens Models, Ctrl+N shortcut
- [ ] Focus exclusivity: Enter/Up/Down/Escape don't leak to InputBox
- [ ] Validation: invalid search mode rejected, invalid numeric rejected, Space details read-only
- [ ] Iteration: `build + test-config-tui-components` | Exit: `build + contracts + config-tui + components`

#### Phase C2: ConfigPanel MCP Tab + Commands (Group 2b, ~31 SCC)
- [ ] MCP tab: two server types (klayout + generic), connection status, tool count, drill-down
- [ ] Tool list: Space toggle, different persistence (klayout.json vs mcp.json per-server), annotation icons
- [ ] /mcp (bare) opens MCP tab, /mcp enable/disable commands
- [ ] Error paths: missing klayout.json, disconnected server 0-tools, reconnect retry
- [ ] State lifecycle: cursor/drilldown survives close/reopen, focus stays during agent turn
- [ ] Iteration: `build + test-config-tui-components` | Exit: `build + contracts + config-tui + components`

#### Phase D: SETUP Wizard (Group 3, ~21 SCC)
- [ ] 6-step wizard, SetupWizard.tsx with masked input, KLayout auto-detect
- [ ] CLI entry: `qlaybot setup` (new) + `qlaybot onboard` (alias), /config setup in TUI
- [ ] Env API key acceptance, embedding creds → search.mode auto-set
- [ ] Error paths: invalid API key validation, /config setup recovery from corrupted config
- [ ] Iteration: `build + test-config-tui` | Exit: `build + contracts + config-tui + components`

### Spec 2: Subagent System + HITL (Phases E-H)

#### Phases E+F: Subagent Core + Delegation (Group 4, ~23 SCC)
- [ ] RoleConfig, SubagentResult from contracts, config-driven roles, role resolver
- [ ] Tool factory: read-only MCP proxy, submit_result (first-wins), delegate filtered
- [ ] SubagentRunner: 14-step pipeline, EventEmitter (StartedEvent includes role+task), pause/resume/inject/kill
- [ ] createDelegateTool, agent.ts wiring, dynamic system prompt, workspace templates
- [ ] Iteration: `build + test-subagent` | Exit: `build + contracts + all Spec 1 + subagent`

#### Phase G: Subagent TUI (Group 5, ~32 SCC)
- [ ] SubagentPanel: summary bar (status icons, nav) + inspect window (segments, scroll, Left/Right switch)
- [ ] Ctrl+T expand/collapse in inspect, Ctrl+S toggle panel, inject mode, kill
- [ ] Focus exclusivity: Enter/Up/Down/i/k don't leak to InputBox
- [ ] State lifecycle: completed results survive close/reopen, events accumulate while panel closed
- [ ] Panel-to-panel switching (Ctrl+S → Ctrl+N), edit interrupted by Ctrl+S
- [ ] Iteration: `build + test-subagent-components` | Exit: `build + contracts + all Spec 1 + subagent + components`

#### Phase H: Subagent E2E (Group 6, ~33 SCC)
- [ ] Full delegation pipeline with REAL APIs, concurrent subagents
- [ ] Budget enforcement (token + turn), inject + maxTurns boundary, no submit_result before stop
- [ ] TUI integration E2E: delegate → panel shows → scroll → switch → inject → kill → badge updates
- [ ] Cross-layer: disable tool then delegate, delegate in plan mode, kill after Left/Right switch
- [ ] Large tool result: truncated in UI (Ctrl+T expands), full in transcript
- [ ] Auto-compaction doesn't affect running subagent, workspace files in prompt
- [ ] Iteration: `build + test-subagent-e2e` | Exit: **`build + npm test` (full suite)**

### Spec 3: Search & Retrieval Enhancement (Phases I-K)

#### Phases I+J: Search Core + Integration (Group 7, ~37 SCC)
- [ ] Embedder (Float32Array) + APIEmbedder, cosineSimilarity, vectorSearch, deduplication
- [ ] Reranker via Haiku (auto-finds Anthropic provider), caching, graceful fallback
- [ ] search() async 4-mode dispatch, disk SQLite, memory_embeddings table, reindexEmbeddings
- [ ] Integration: auto-recall await, /memory search await, config-time validation
- [ ] Error paths: Haiku timeout, malformed JSON, embedding API 5xx, zero results, SQLite unavailable
- [ ] DB lifecycle: FTS-only upgrade, deferred backfill, mode switch on same corpus
- [ ] Real APIs from ~/.keys/api_settings.md, reindex throttle for rapid saves
- [ ] Iteration: `build + test-search` | Exit: `build + contracts + all Spec 1 + all Spec 2 (incl e2e) + search`

#### Phase K: Search E2E + Final v0.4.0 (Group 8, ~21 SCC)
- [ ] Mode-driven integration tests with REAL APIs
- [ ] Cross-restart persistence: model, disabled tools, search mode + embedding config
- [ ] Manual invalid config fallback, subagent uses parent's updated search mode
- [ ] Version bump to 0.4.0, CLAUDE.md + README update
- [ ] Iteration: `build + test-search-integration` | Exit: **`build + npm test` (full suite)**

---

## Out of Scope

- [ ] Dynamic skill system for external/user-defined skills
- [ ] Shell completions (`qlaybot completions` for bash/zsh)
- [ ] Local embedding models (e.g., `@xenova/transformers`) — API-only for now
- [ ] Custom rerank model selection (always Haiku)
- [ ] Subagent-to-subagent delegation (no nesting)
- [ ] Persistent subagent sessions (ephemeral only)
- [ ] Populate 3-tier knowledge (core physics, lab recipes, learned insights)
- [ ] CI pipeline: tier 1 (unit) every push, tier 2 (integration) every push, tier 3 (E2E) nightly
