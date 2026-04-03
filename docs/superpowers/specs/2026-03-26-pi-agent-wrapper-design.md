# Pi-Agent Wrapper for Device Design — Design Spec

> Standalone TypeScript agent wrapping Pi-Agent SDK for quantum device design, orchestrating KLayout MCP server.

**Date:** 2026-03-26
**Location:** `KlayoutClaw/agent/`
**Approach:** Build from scratch, referencing qdevbot patterns

---

## 1. Core Agent Loop

Direct `Agent` + `AgentSession` construction (bypassing `piCreateAgentSession`) for full control over tools and prompt.

```
createDesignSession()
  ├── loadConfig()                → config from ~/.qlaybot/
  ├── MCPManager.connectAll()        → connect KLayout MCP, register native + domain tools
  ├── assembleTools()             → base tools + KLayout tools + custom tools
  ├── buildSystemPrompt()         → SOUL.md + WORKFLOW.md + TOOLS.md + tool descriptions
  └── new Agent + AgentSession
        ├── transformContext hook (auto-recall memory)
        └── agentLoop: outer (follow-ups) x inner (tool calls)
```

**Base tools override:** `read`, `bash`, `edit`, `write`.

**Custom tools:** `memory_save`, `memory_search`.

**KLayout tools:** 6 native MCP tools + domain tools (refactored from existing skills into typed tool schemas defined in agent codebase). All MCP tools are exposed directly (not proxied through a generic tool). KLayout tools are fully loaded into the system prompt at startup; other MCP servers are registered but lazy-loaded — their tools are discovered and added to the tool registry on first call to that server (see §2).

**Tool naming convention** (3-level): `{server}.{group}.{tool}` — e.g., `klayout.geometry.add_rect`, `klayout.native.execute_script`. Native MCP tools use `klayout.native.*`; domain tools use `klayout.{group}.*`. Other MCP servers use `{server_key}.{tool_name}` (2-level).

---

## 2. MCP Connection Management

Config-driven MCP connections managed by `MCPManager`. Two client types:

### Custom KLayout Client

The KLayout MCP server uses HTTP JSON-RPC (no SSE/stdio), requiring a custom transport. The custom client registers both native MCP tools and **domain tools** — typed tool schemas refactored from existing KlayoutClaw skills, defined in the agent codebase.

```
KLayoutMCPClient
  ├── connect(url)                → HTTP JSON-RPC transport
  ├── discoverNativeTools()       → native MCP tools (6)
  ├── registerDomainTools()       → load typed tool schemas from src/tools/klayout/
  ├── callTool(name, args)        → route to execute_script or native tool
  └── healthCheck()               → verify KLayout is responsive
```

**Domain Tools** (refactored from existing skills):

Each existing skill script becomes a typed tool with explicit JSON schema, defined in `src/tools/klayout/`. The implementation generates pya code and executes it via `execute_script`.

Example — `klayout.geometry.add_rect`:

```json
{
  "name": "klayout.geometry.add_rect",
  "description": "Add a rectangle to a cell",
  "inputSchema": {
    "type": "object",
    "properties": {
      "cell": { "type": "string" },
      "layer": { "type": "integer" },
      "datatype": { "type": "integer" },
      "x1": { "type": "number" },
      "y1": { "type": "number" },
      "x2": { "type": "number" },
      "y2": { "type": "number" }
    },
    "required": ["cell", "layer", "datatype", "x1", "y1", "x2", "y2"]
  }
}
```

Domain tool groups (from existing skills): `geometry`, `display`, `image`, `visual`, `nanodevice_flakedetect`, `nanodevice_gdsalign`, `nanodevice_routing`.

> **Note:** `e2e_judge` remains a Claude Code skill under `.claude/skills/` — it is not an agent tool.

### Standard MCP Client

All other MCP servers use the standard MCP client SDK (SSE/stdio transports). Tools are namespaced as `{server_key}.{tool_name}`.

### MCPManager

```
MCPManager
  ├── servers: Map<server_key, MCPConnection>
  ├── callTool("klayout.geometry.add_rect", args)
  │   → route to KLayoutMCPClient or standard client
  ├── allTools() → flat list with namespaced names
  └── connectAll() → connect klayout (required); other servers registered but lazy-loaded
```

**Startup behavior:**
1. Try to connect KLayout MCP via custom client.
2. If unavailable, auto-launch KLayout with platform detection:
   - macOS: `open /Applications/klayout.app`
   - Linux: `klayout &` (assumes `klayout` is on PATH)
   - Windows: `start klayout`
3. Poll with exponential backoff (1s → 2s → 4s, max 30s total), then reconnect.
4. If still unreachable after timeout, fail with actionable error message.
5. Register native MCP tools + domain tools.
6. Other MCP servers are registered but lazy-loaded — their tools are discovered on first call, not included in the initial system prompt.

**Extensibility:** Adding a new MCP server = one config entry. All its tools appear under `newserver.tool_name` automatically. No code changes.

### Config (mcp.json)

Config keys map to runtime namespace prefixes: the key (minus any `_mcp` suffix) becomes the tool prefix. For example, `klayout_mcp` → `klayout.*`, `notebook_mcp` → `notebook.*`.

```json
{
  "klayout_mcp": { "url": "http://127.0.0.1:8765/mcp", "required": true }
}
```

---

## 3. System Prompt & Domain Knowledge

### Prompt Assembly

```
buildSystemPrompt()
  ├── sections/tooling.md        → registered tool list + descriptions
  ├── sections/mcp.md            → MCP server topology
  ├── workspace/SOUL.md          → physicist persona
  ├── workspace/WORKFLOW.md      → design protocol
  ├── workspace/TOOLS.md         → tool usage guide
  ├── workspace/RULES.md         → design rules + constraints
  └── sections/memory.md         → memory instructions
```

### SOUL.md (Physicist Persona)

- Think like a condensed matter physicist
- Reason about device physics before drawing geometry
- Validate designs against physical constraints, not just geometric ones
- Explain design choices in terms of device function

### WORKFLOW.md (Design Protocol)

```
Phase 1: Plan      → understand device, scout layout, validate constraints
Phase 2: Design    → create geometry, place markers, define pins
Phase 3: Interact  → place pads, route leads, save GDS
```

Each phase has entry criteria, exit criteria, and tool usage patterns.

### Domain Knowledge (Deferred)

Three-tier knowledge system (core physics / lab recipes / agent-learned) is deferred until ai-scientist inputs are available. For now, create placeholder directory structure:

```
workspace/knowledge/
├── core/           # Tier 1: Physics fundamentals (placeholder)
├── recipes/        # Tier 2: Lab-specific (placeholder)
└── learned/        # Tier 3: Agent-accumulated (placeholder)
```

> **GH Issue:** Define and populate three-tier domain knowledge with ai-scientist collaboration.

---

## 4. Memory System

Categorized markdown files with SQLite FTS5 search (sufficient for MVP):

```
MemoryManager
  ├── save(category, content, tags)     → append timestamped entry
  ├── search(query, limit)              → FTS5 full-text search
  ├── reindex()                         → rebuild SQLite index
  └── reindexIfStale(maxAgeMs)          → throttled rebuild (5s min)
```

**Categories** (at `~/.qlaybot/memory/`):
- `knowledge.md` — device params, design results, configs
- `procedures.md` — design workflows, recipes that worked
- `preferences.md` — user conventions, layer schemes, naming
- `log/YYYY-MM-DD.md` — daily session observations

**Auto-recall** via Pi-Agent's `transformContext` hook:
- Fires before each LLM call if last message is from user
- FTS5 search across all categories
- Injects `<recalled-memories>` block into context
- Throttled reindex (5s min) to avoid redundant work

> **GH Issue:** Upgrade memory search to hybrid (FTS5 + embedding) with LLM rerank.

**Entry format:**
```markdown
## 2026-03-26T14:30:00 | hallbar, routing, fan-out
Dense fan-out with 48 pins needed path_safe_distance=8 to avoid overlaps.
Default of 5 caused crossing routes near the inner window boundary.
```

---

## 5. Project Structure

### Source Layout (`KlayoutClaw/agent/`)

```
agent/
├── src/
│   ├── cli.ts                  # Entry point (interactive/JSON modes)
│   ├── rpc.ts                  # JSON-RPC entry point (stdin/stdout, for E2E tests)
│   ├── agent.ts                # createDesignSession(), baseToolsOverride
│   ├── index.ts                # Public API exports
│   ├── config.ts               # Config loading + defaults
│   ├── context.ts              # Workspace markdown loaders
│   ├── tools/
│   │   ├── index.ts            # assembleTools()
│   │   ├── read.ts, bash.ts, edit.ts, write.ts  # Base tools
│   │   ├── memory.ts           # memory_save + memory_search
│   │   └── klayout/            # Domain tools (refactored from skills)
│   │       ├── index.ts        # Register all domain tool groups
│   │       ├── geometry.ts     # add_rect, add_polygon, add_path, create_cell, add_instance
│   │       ├── display.ts      # toggle_layer, show_only
│   │       ├── image.ts        # add_image, list_images, remove_image
│   │       ├── visual.ts       # capture
│   │       └── nanodevice.ts   # flakedetect, gdsalign, routing tools
│   ├── mcp/
│   │   ├── manager.ts          # MCPManager
│   │   ├── klayout-client.ts   # Custom KLayout HTTP client
│   │   ├── transport.ts        # HTTP JSON-RPC transport
│   │   └── types.ts            # MCPConnection, ToolSchema
│   ├── memory/
│   │   ├── index.ts            # MemoryManager
│   │   ├── auto-recall.ts      # transformContext hook
│   │   └── parser.ts           # Entry parser
│   ├── prompts/
│   │   ├── index.ts            # buildSystemPrompt()
│   │   └── sections/           # Modular prompt sections
│   └── tui/
│       ├── render.ts           # Ink render entry point
│       ├── reducer.ts          # useReducer state machine
│       └── components/         # React terminal components
├── workspace/                  # Domain knowledge
│   ├── SOUL.md, WORKFLOW.md, TOOLS.md, RULES.md
│   └── knowledge/              # Placeholder (core/recipes/learned)
├── tests/
│   ├── test-agent.ts           # Session creation, prompt building
│   ├── test-mcp.ts             # MCP connection + routing
│   ├── test-tools.ts           # Tool dispatch + domain tool schemas
│   ├── test-memory.ts          # FTS5 search, auto-recall
│   └── test-e2e.ts             # RPC mode E2E
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

### Runtime Config (`~/.qlaybot/`)

```
~/.qlaybot/
├── config/
│   ├── model.json              # defaultModel, thinkingLevel
│   ├── mcp.json                # MCP server URLs + required flags
│   └── settings.json            # Memory budgets
├── workspace/                  # Copied from agent/workspace/ on first run
├── memory/                     # Persistent memory categories
├── sessions/                   # JSONL session history
└── logs/                       # Agent logs
```

**Not included in initial build** (add later if needed): compaction, background task manager, planning mode.

---

## 6. Interaction History Auto-Save

All agent interactions are automatically persisted to `/tmp/KLayoutClaw_History/` for debugging, replay, and audit:

```
/tmp/KLayoutClaw_History/
├── sessions/
│   └── {session_id}/
│       ├── transcript.jsonl    # Full conversation: prompts, tool calls, results
│       ├── tool_calls/         # Individual tool call logs
│       │   ├── 001_klayout.native.execute_script.json
│       │   ├── 002_klayout.native.screenshot.json
│       │   └── ...
│       └── metadata.json       # Session start time, model, config snapshot
└── latest -> sessions/{most_recent_session_id}
```

**What gets saved:**
- Every user prompt and agent response
- Every MCP tool call: tool name, arguments, result, duration
- Errors and retries

**Auto-save is continuous** — each turn is appended to `transcript.jsonl` immediately, so partial sessions are recoverable after crashes.

---

## 7. E2E Testing via RPC

The agent exposes JSON-RPC on stdin/stdout for programmatic testing.

### RPC Entry Point (`agent/src/rpc.ts`)

Methods: `initialize`, `prompt`, `shutdown`. Ephemeral sessions per test.

### Test Tiers

**Tier 1: Unit tests** (no servers, mocked MCPManager)
- Tool routing: `klayout.native.execute_script` → klayout server
- Domain tool schemas: all tool groups register with valid inputSchema
- Memory: FTS5 search, entry parsing

**Tier 2: Integration tests** (require servers running)
- MCP connection and tool discovery
- Domain tool execution (geometry, display, visual) against live KLayout
- Graceful degradation without optional servers

**Tier 3: E2E tests** (full agent loop via RPC)

These are the most important tests — they validate the complete agent pipeline.

**Test 3a — Basic agent loop:**
1. Send "echo Hello World" → verify echoed output
2. Send "Calculate 1+1" → use LLM-judge to verify correct answer

**Test 3b — MCP connection and tool routing:**
1. Send "Connect to KLayout and create a new layout" → verify correct tool calls in MCP server log (enable file logging in MCP server if not already present)

**Test 3c — Session memory:**
1. Send "Remember this password: i_hate_calculus"
2. Start a new session, send "What is the password? State directly `<pwd>content</pwd>`"
3. Parse `<pwd>` tag in response and verify content matches

**Test 3d — Domain tool execution:**
1. Create a layout first
2. Send "Add a 100x25 um rectangle at origin on layer 1/0"
3. Verify via `execute_script` (read-back pya code querying `cell.shapes()`) that the rectangle exists with correct bbox dimensions — `get_layout_info` returns summary metadata only, not per-shape geometry

**Test 3e — Auto-launch KLayout:**
1. Ensure KLayout is not running (`pkill -x klayout`)
2. Start the agent — it should auto-launch KLayout and connect after polling
3. Send "Create a new layout" → verify it succeeds (layout created)

**Test 3f — Error recovery (KLayout unreachable):**
1. Stop KLayout MCP server and block auto-launch (e.g., temporarily rename klayout.app)
2. Start the agent → verify it fails with actionable error message after timeout, not a crash

**Test 3g — Multi-turn conversation:**
1. Send "Create a new layout called test"
2. Send "Add a cell called main"
3. Send "What cells exist?" → verify "main" appears in response

---

## 8. Key Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Pi-Agent SDK |
| `@mariozechner/pi-agent-core` | Core agent loop |
| `@anthropic-ai/sdk` | Anthropic API |
| `better-sqlite3` | SQLite FTS5 for memory |
| `ink` + `@inkjs/ui` | Terminal UI framework |
| `chalk` | Terminal colors |
| `vitest` | Test runner |
| `typescript` | Language |

---

## 9. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Build approach | From scratch | Cleaner than forking qdevbot; only write what's needed |
| Location | `KlayoutClaw/agent/` subdirectory | Keeps everything together, shares docs/tests/skills |
| KLayout MCP client | Custom (HTTP JSON-RPC) | KLayout uses non-standard transport |
| Other MCP servers | Standard MCP SDK (lazy) | SSE/stdio transports; connected on first tool call, not in system prompt |
| Domain tools | Refactored from skills into typed schemas | Defined in `src/tools/klayout/`; existing skill scripts become pya code generators |
| Prompt tool inventory | KLayout tools only | Other MCP tools discovered on-demand, not in initial prompt |
| Tool naming | Dot-namespaced (`server.group.tool`) | Extensible, collision-free, config-driven |
| Tool exposure | Direct (not proxied) | More ergonomic for LLM than generic proxy; lazy-loaded servers add tools on first call |
| Memory | FTS5 + auto-recall | Proven in qdevbot, fits domain needs |
| E2E testing | RPC mode | Programmatic, CI-friendly, proven in qdevbot |
| MVP scope | Single agent, full pipeline | All phases thin but complete; subagents deferred |

---

## 10. Out of Scope (Initial Build)

- Context compaction (add when long sessions become an issue)
- Background task manager (add when long-running operations need it)
- Planning mode with approval gates (add when workflows become complex)
- Subagent system with role-based delegation (scout/designer/fabricator — add when single agent hits limits)
- Three-tier domain knowledge content (deferred for ai-scientist collaboration)
- Hybrid memory search with LLM rerank (FTS5 sufficient for MVP)
- Agentic *workflow* E2E tests — full Plan→Design→Interact chains (define after core is stable; §7 Tier 3 tests cover individual capabilities, not multi-phase workflows)
- Dynamic skill system for external/user-defined skills (existing skills are refactored into native typed tools; a plugin-style skill system can be added later)
- Shared core library with qdevbot (premature abstraction)

---

## 11. GitHub Issues to File

1. **Three-tier domain knowledge** — Define and populate `workspace/knowledge/` tiers with ai-scientist inputs
2. **Hybrid memory search** — Upgrade from FTS5 to hybrid (embedding + FTS5) with LLM rerank
3. **Subagent system** — Role-based delegation (scout/designer/fabricator) with namespace-scoped tool access
4. **Dynamic skill system** — Plugin-style system for external/user-defined skills (auto-discovery, SKILL.md parsing, runtime registration)
