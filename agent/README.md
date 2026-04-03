# qlaybot — Device Design Agent

Standalone TypeScript agent wrapping Pi-Agent SDK for quantum device design, orchestrating KLayout via MCP.

## Features

- **Physicist-thinking design**: reasons about device physics before drawing geometry
- **KLayout MCP integration**: 6 native tools + 15 domain tools for layout creation, geometry, display, imaging, and nanodevice operations
- **Dual-mode commands**: 10 slash commands work in shell (`qlaybot model`), TUI (`/model`), and RPC
- **Planning mode**: modal sandbox restricts tools to read-only while reasoning, then unlocks for execution
- **Background tasks**: long-running operations (auto-route, flake detection, GDS save) run asynchronously with cancel support
- **Context compaction**: automatic tool result pruning + manual `/compact` for long sessions, with KLayout state preservation
- **SQLite FTS5 memory**: categorized persistent memory (knowledge, procedures, preferences, daily log) with auto-recall
- **Polished Ink TUI**: markdown rendering with syntax-highlighted code, decomposed message components (UserMessage, AssistantMessage with ToolPanel/ThinkingIndicator), interactive panels (WorkspaceBar, BackgroundBar), StreamingBar with live metrics
- **RPC mode**: JSON-RPC on stdin/stdout with 8 event types for E2E testing and integration
- **Auto-launch**: detects and starts KLayout automatically (macOS, Linux, Windows)

## Quick Start

```bash
npm install
npm run build
export ANTHROPIC_API_KEY=your_key_here
npm start
```

### Global CLI (optional)

```bash
npm link
qlaybot              # works from any directory
```

## Modes

```bash
npm start                         # Interactive TUI (default)
npm start -- -m "add a rect"      # Single-shot JSON mode
npm start -- --mode rpc           # RPC mode for E2E testing
npm start -- --plain              # Plain readline (no Ink)
```

## CLI

```bash
qlaybot                               # Interactive TUI
qlaybot -m "add a rectangle"          # Single-shot JSON mode
qlaybot --mode rpc                    # RPC mode (stdin/stdout JSON-RPC)
qlaybot --plain                       # Plain readline

# Commands (shell mode — also available as /command in TUI)
qlaybot model [show|set|list]         # Model management
qlaybot mcp [status|tools|reconnect]  # MCP server management
qlaybot config [show|set|reset]       # Config management
qlaybot context                       # Workspace context info
qlaybot memory [show|search|clear]    # Memory management
qlaybot compact [instructions]        # Context compaction
qlaybot tasks                         # Background task status
qlaybot onboard                       # First-time setup (~/.qlaybot/)
qlaybot uninstall                     # Remove ~/.qlaybot/
qlaybot help [<command>]              # Help

# Options
--model <provider/modelId>            # Override default model
--thinking <level>                    # off|minimal|low|medium|high|xhigh
--cwd <path>                          # Working directory
```

## TUI Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+T` | Toggle tool detail + thinking expansion |
| `Ctrl+W` | Toggle workspace panel |
| `Ctrl+G` | Toggle background task panel |
| `Ctrl+A` | Cursor to start of line |
| `Ctrl+E` | Cursor to end of line |
| `Ctrl+D` | Delete forward |
| `↑/↓` | Command history / panel navigation |
| `Tab` | Cycle command completion |
| `Escape` | Abort agent / close panel |

## Commands

| Command | Subcommands | Description |
|---------|------------|-------------|
| `/model` | `show`, `set <provider/id>`, `list` | Show/switch active model, persist to config |
| `/mcp` | `status`, `tools [server]`, `reconnect [server]` | MCP server management |
| `/config` | `show`, `set <key> <value>`, `reset` | Runtime + persisted config |
| `/context` | — | Workspace file listing with sizes and context usage |
| `/memory` | `show [category]`, `search <query>`, `clear <category>` | Memory inspection and deletion |
| `/plan` | `enter` (default), `exit`, `status` | Planning mode control (sandbox) |
| `/compact` | `[instructions]` | Trigger context compaction with optional custom instructions |
| `/tasks` | — | Background task status |
| `/help` | `[command]` | Command help |
| `/exit` | — | Graceful shutdown (TUI-only) |

## Planning Mode

`/plan` enters a modal state where the agent can reason and explore but cannot mutate the layout or filesystem.

**Allowed (read-only):** `read`, `get_layout_info`, `screenshot`, `memory_save`, `memory_search`

**Blocked:** `bash`, `write`, `edit`, `execute_script`, `create_layout`, `save_layout`, `auto_route`, all geometry/display/image/nanodevice tools

Exit with `/plan exit` to resume full tool access.

## Architecture

```
qlaybot v0.3
  ├── Agent Layer
  │   ├── SOUL.md (physicist persona)
  │   ├── WORKFLOW.md (Plan → Design → Interact)
  │   ├── TOOLS.md / RULES.md (tool guide + design constraints)
  │   └── Memory (SQLite FTS5: knowledge, procedures, preferences, log)
  ├── Command Layer
  │   ├── CommandRegistry (10 handlers including /compact)
  │   ├── PlanManager + sandbox + onStateChange observer
  │   └── BackgroundTaskManager (async execution + cancel)
  ├── TUI Layer (Ink/React)
  │   ├── App.tsx (root, keyboard shortcuts, auto-compaction)
  │   ├── Messages: UserMessage, AssistantMessage, SystemMessage
  │   ├── Display: ThinkingIndicator, ToolPanel, MarkdownText
  │   ├── Input: InputBox (cursor + history + tab completion), CompletionList
  │   ├── Bars: StreamingBar, ErrorBanner, StatusBar
  │   ├── Panels: WorkspaceBar, BackgroundBar
  │   └── Foundation: theme.ts, markdown.ts, auto-compact.ts
  ├── Compaction Layer
  │   ├── tool-result-pruner (keep last 3, prune large old results)
  │   ├── state-extractor (XML tags → workspace/compaction/ files)
  │   ├── state-loader (inject <compaction-state> into context)
  │   └── prompt-loader (COMPACT.md or KLayout-domain fallback)
  ├── Pi-Agent SDK
  │   ├── AgentSession.prompt()
  │   ├── transformContext: pruner → stateLoader → autoRecall
  │   └── agentLoop (outer × inner)
  ├── Tool Layer
  │   ├── Base: read, bash, edit, write (sandbox-wrapped)
  │   ├── KLayout native: klayout_native_* (6 tools)
  │   ├── KLayout domain: klayout_{group}_* (15 tools)
  │   └── Custom: memory_save, memory_search, background_status, background_result
  └── MCP Connections
      ├── KLayout MCP :8765 [required, auto-launched]
      └── (additional servers lazy-loaded via mcp.json)
```

## Config

Runtime configuration at `~/.qlaybot/`:

| File | Purpose |
|------|---------|
| `config/model.json` | Model selection, thinking level, provider config |
| `config/mcp.json` | MCP server URLs and required flags |
| `config/settings.json` | Memory, compaction, MCP timeouts, TUI settings |
| `workspace/` | Domain knowledge (copied from agent/workspace/ on onboard) |
| `workspace/compaction/COMPACT.md` | Compaction instruction template |
| `memory/` | Persistent categorized memory |
| `sessions/` | JSONL session history |

## Testing

```bash
npm test                              # All tests (auto-skips E2E if env unavailable)
npm run test:unit                     # Unit tests only (588 tests)
npm run test:integration              # Integration tests (95 tests)
npm run test:e2e                      # E2E tests (needs KLayout + API key)
npm test -- --reporter=verbose        # Verbose output
QLAYBOT_NIGHTLY=1 npm test            # Include 5g long session test
QLAYBOT_E2E=0 npm test                # Skip E2E tests only
```

**697 tests across 16 files** — split into unit (588), integration (95), and E2E (14) tiers. See `agent/CLAUDE.md` for the full breakdown.

## License

Part of [KlayoutClaw](https://github.com/caidish/KlayoutClaw).
