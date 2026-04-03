# Qlaybot Enhancement Report (Detailed)

**Source**: 7-reviewer analysis
- Reviewer 0: Claude Opus deep codebase exploration
- Reviewers 1-3: Codex comparative reviews (Claude Code vs qlaybot)
- Reviewers 4-6: Codex issue-focused reviews (qlaybot internals)

**Date**: 2026-04-01
**Scope**: Claude Code (open-source, `/Users/andrewwayne/testFolder/claude_code/start-claude-code`) vs qlaybot (`/Users/andrewwayne/testFolder/KLayoutClaw/agent`)

---

## Table of Contents

1. [Architecture Comparison](#1-architecture-comparison)
2. [P0: Prompt Cache Engineering](#2-p0-prompt-cache-engineering)
3. [P0: Error Recovery — prompt_too_long](#3-p0-error-recovery--prompt_too_long)
4. [P0: Non-KLayout MCP Tool Discovery Bug](#4-p0-non-klayout-mcp-tool-discovery-bug)
5. [P0: Subagent MCP Tool Naming Bug](#5-p0-subagent-mcp-tool-naming-bug)
6. [P1: Subagent Session/Listener Leaks](#6-p1-subagent-sessionlistener-leaks)
7. [P1: Subagent Token Accounting](#7-p1-subagent-token-accounting)
8. [P1: Transform Pipeline Order Bug](#8-p1-transform-pipeline-order-bug)
9. [P1: Subagent MCP Schema Degradation](#9-p1-subagent-mcp-schema-degradation)
10. [P1: MCP ensureConnected Race Condition](#10-p1-mcp-ensureconnected-race-condition)
11. [P1: Tool Execution Orchestration](#11-p1-tool-execution-orchestration)
12. [P2: Medium Issues](#12-p2-medium-issues)
13. [Claude Code Features Worth Adopting](#13-claude-code-features-worth-adopting)
14. [Qlaybot Strengths to Preserve](#14-qlaybot-strengths-to-preserve)
15. [Recommended Implementation Order](#15-recommended-implementation-order)
16. [Previously Missed Items (Added After Audit)](#16-previously-missed-items-added-after-cross-reference-audit)

---

## 1. Architecture Comparison

| Aspect | Claude Code | qlaybot |
|--------|------------|---------|
| Codebase | 380K+ LoC TypeScript | 79 files TypeScript |
| Runtime | Bun | Node.js |
| TUI | Custom React renderer (not Ink) | Ink 6.0 |
| API Layer | Direct @anthropic-ai/sdk with full control | Pi-Agent SDK wrapping @anthropic-ai/sdk |
| Core Loop | Own async generator (`query.ts`) | Pi-Agent's AgentSession loop |
| State | React AppState + session persistence | Pi-Agent session + filesystem |
| Tool Dispatch | Own orchestrator with concurrency | Delegated to Pi-Agent |
| Cache Control | Explicit cache_control placement | None (delegated to SDK) |
| Compaction | Multi-strategy (micro, snip, session-memory, auto) | Tool-result pruning + state extraction |

**Key architectural difference**: Claude Code owns its entire runtime loop and can control every aspect of API request construction, caching, error recovery, and tool dispatch. qlaybot delegates the core loop to Pi-Agent, which means many critical behaviors are opaque and uncontrollable from the harness layer.

*Reviewers 1-3 all independently identified this as the root cause of most gaps.*

---

## 2. P0: Prompt Cache Engineering

### The Gap

**Reviewer consensus: 7/7** — Every reviewer identified this as the highest-impact gap.

**Claude Code's implementation:**

- Splits system prompt at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker
  - Static prefix (persona, tool schemas, base instructions) → `cacheScope: 'global'` — cached across ALL users/orgs
  - Dynamic suffix (session context, memory, MCP status) → `cacheScope: null` — never cached
- Tool schemas support ephemeral caching with TTL (5min, 1hr)
- Fork subagents use **identical prefixes** with placeholder tool results to maximize cache hits
- `promptCacheBreakDetection.ts` hashes system prompt + tool schemas + model + betas to detect and log cache breaks
- `microCompact.ts` uses `cache_reference` to maintain cache stability during compaction
- `forkedAgent.ts` preserves cache-critical params (model, thinking config) across forks

**Key Claude Code files:**
- `src/services/api/claude.ts:588` — cache_control placement on system prompt blocks
- `src/services/api/claude.ts:3063` — cache_reference for tool results
- `src/services/api/promptCacheBreakDetection.ts:28` — cache break detection + hashing
- `src/constants/prompts.ts:491` — SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker
- `src/constants/prompts.ts:573` — global cache boundary insertion
- `src/context.ts:116` — memoized context sections
- `src/utils/forkedAgent.ts:47` — cache-safe fork params

**qlaybot's implementation:**

- `buildSystemPrompt()` concatenates all sections into one flat string
- No `cache_control` headers set anywhere in harness code
- No distinction between static and dynamic prompt content
- No cache-break detection or diagnostics
- Subagents build entirely fresh system prompts — no prefix sharing
- Workspace files (`SOUL.md`, `WORKFLOW.md`, `TOOLS.md`, `RULES.md`) inlined every session

**Key qlaybot files:**
- `src/prompts/index.ts:28` — flat prompt concatenation
- `src/prompts/sections/context.ts:8` — workspace file inlining
- `src/prompts/sections/tooling.ts:5` — tool name listing
- `src/agent.ts:259` — prompt passed to Agent constructor

### Impact

- **Cost**: Without cache_control markers, every turn re-processes the full system prompt. Claude Code achieves ~80% cache hit on multi-turn sessions. qlaybot gets 0% harness-controlled cache hits.
- **Latency**: Cached prompt processing is ~10x faster at the API level.
- **Subagent cost**: Each subagent delegation pays full prompt processing cost instead of sharing parent's cache.

### Recommended Fix

1. Split `buildSystemPrompt()` into `buildStaticPrefix()` and `buildDynamicSuffix()`
2. Pass system prompt as an array of blocks to the Anthropic SDK:
   ```typescript
   system: [
     { type: "text", text: staticPrefix, cache_control: { type: "ephemeral" } },
     { type: "text", text: dynamicSuffix }
   ]
   ```
3. Ensure `transformContext` never modifies the system prompt prefix — only inject into messages or the dynamic suffix
4. For subagents, reuse the parent's static prefix bytes exactly
5. Add a cache-break logger that hashes the static prefix and alerts on unexpected changes

---

## 3. P0: Error Recovery — prompt_too_long

### The Gap

**Reviewer consensus: 5/7**

**Claude Code's implementation:**

- `query.ts:152` — catches `prompt_too_long` API errors
- Triggers auto-compaction via `compact.ts:218`
- After compaction, retries the API call
- Also handles `max_output_tokens` errors — increases budget and retries up to 3x
- `reactiveCompact.ts` handles mid-turn compaction if prompt grows too large during tool execution
- Rate limit errors get exponential backoff with jitter

**qlaybot's implementation:**

- No `prompt_too_long` error handler in harness code
- No `max_output_tokens` recovery
- Auto-compaction only triggers post-turn in TUI (`src/tui/auto-compact.ts:23`) based on `contextPercent >= autoThreshold`
- The SDK's built-in auto-compaction is explicitly disabled (`src/agent.ts:345`)
- No reactive mid-turn compaction

### Impact

- Long sessions will eventually hit context limits and crash with no recovery
- The only protection is the TUI-side threshold check, which runs after the turn completes — too late if the turn itself exceeds limits
- `max_output_tokens` truncation silently loses response content

### Recommended Fix

1. Wrap Pi-Agent's prompt call in a try/catch that detects `prompt_too_long` errors
2. On detection: run `compact()`, then retry the prompt
3. Add `max_output_tokens` detection: if response is truncated, increase budget and retry (up to 3x)
4. Consider enabling Pi-Agent's built-in auto-compaction as a fallback, or implement a pre-turn token estimate check

---

## 4. P0: Non-KLayout MCP Tool Discovery Bug

### The Bug

**Reviewer consensus: 6/6 codex reviewers independently found this**

**Root cause chain:**
1. `connectAll()` only eagerly connects KLayout; other servers are registered but left disconnected (`src/mcp/manager.ts:57, :88`)
2. `allTools()` only returns tools for connected servers (`src/mcp/manager.ts:177-185`)
3. `assembleTools()` builds tool wrappers from `allTools()` at session startup (`src/tools/index.ts:191`)
4. The agent never sees tools for lazy servers
5. `ensureConnected()` exists but nothing routes tool calls to trigger it

**Code path:**
```
connectAll() → only connects KLayout
allTools() → returns only KLayout tools
assembleTools() → builds wrappers for only KLayout tools
Agent constructed → no generic MCP tools available
User asks to use generic MCP tool → model doesn't know it exists
```

### Impact

Any non-KLayout MCP server configured in `mcp.json` is effectively dead — the agent cannot discover or call its tools.

### Recommended Fix

Either:
- **Option A**: Eagerly connect all servers in `connectAll()` (simpler, slightly slower startup)
- **Option B**: Build placeholder tool wrappers for lazy servers using their declared tool schemas, then connect on first call (preserves lazy loading)

---

## 5. P0: Subagent MCP Tool Naming Bug

### The Bug

**Reviewer consensus: 3/6 codex reviewers**

**Root cause:**
- `tool-factory.ts:176` — Subagent MCP tools are exposed using annotation names (e.g., `screenshot`, `get_layout_info`)
- `MCPManager.callTool()` requires namespaced names containing underscore (e.g., `klayout_native_screenshot`) at `manager.ts:216`
- The name mismatch causes `callTool()` to reject the call

**Additionally:**
- Disabled tool filtering at `tool-factory.ts:177` compares against unnamespaced annotation names, so config-disabled namespaced tools can leak into subagents

### Impact

Subagent MCP calls fail silently at runtime. The model gets an error string back but doesn't understand why.

### Recommended Fix

Use the full namespaced tool name (`tool.name`) when registering subagent MCP tools, not the annotation name. Also match disabled tool names against the namespaced versions.

---

## 6. P1: Subagent Session/Listener Leaks

### The Bug

**Reviewer consensus: 6/6 codex reviewers**

**Root cause:**
- `runner.ts:192` — `subscribeToSession()` returns an unsubscribe function that is never stored
- `runner.ts:235, :309, :341` — No `session.dispose()` on success, error, or kill paths
- `agent.ts:398` — Parent `dispose()` tears down main session, memory, MCP — but not active subagent sessions

**Code evidence:**
```typescript
// runner.ts:192 — unsubscribe return value discarded
subscribeToSession(session, { onTextDelta, onThinkingDelta, ... });
// Should be:
const unsub = subscribeToSession(session, { ... });
// Then call unsub() + session.dispose() on all exit paths
```

### Impact

Each subagent delegation leaks a session + event listeners. Over many delegations in a long session, this accumulates memory and callback state.

### Recommended Fix

1. Store the unsubscribe function returned by `subscribeToSession()`
2. Call `unsub()` + `session.dispose()` on all exit paths (success, error, budget, kill)
3. In parent `dispose()`, iterate active subagents and kill/dispose them

---

## 7. P1: Subagent Token Accounting

### The Bug

**Reviewer consensus: 5/6 codex reviewers**

**Root cause (runner.ts:253-373):**
- Reports `session.getContextUsage().tokens` as `inputTokens` — but this is cumulative context size, not per-run API token consumption
- Hardcodes `outputTokens: 0` always
- Budget check runs only before each turn — a single large turn can overshoot `maxTokens` substantially
- Error paths report all-zero usage even after turns have already consumed tokens

### Impact

- Cost attribution is materially wrong
- Budget enforcement is loose — can overshoot by one full turn's worth of tokens
- Impossible to accurately track subagent spend for optimization

### Recommended Fix

1. Track actual API usage via the `usage` field in API responses (input_tokens, output_tokens)
2. Accumulate per-turn usage instead of reading context size
3. Check budget after each turn completes (not just before)

---

## 8. P1: Transform Pipeline Order Bug

### The Bug

**Reviewer consensus: 6/6 codex reviewers**

**Root cause (agent.ts:297-301):**
```typescript
// Current order:
transformContext = compose(
  toolResultPruner,    // Phase 1: prune old results
  stateLoader,         // Phase 2: inject <compaction-state> into last user message
  autoRecall,          // Phase 3: search memory using last user message text
  planModeInjection    // Phase 4: plan mode prompt
)
```

**The problem:** `stateLoader` (`state-loader.ts:54-61`) prepends `<compaction-state>` XML into the last user message. Then `autoRecall` (`auto-recall.ts:35`) extracts the last user message text to use as a memory search query. The search query now contains compaction state text instead of just the user's actual question.

### Impact

- Memory recall returns results matching compaction state instead of the user's intent
- This is both a relevance bug and a prompt-size inefficiency (recalled memories may be irrelevant)
- Gets worse as compaction state grows

### Recommended Fix

Swap the order — run auto-recall before state-loader:
```typescript
transformContext = compose(
  toolResultPruner,
  autoRecall,          // Search with clean user message
  stateLoader,         // Then inject compaction state
  planModeInjection
)
```

---

## 9. P1: Subagent MCP Schema Degradation

### The Bug

**Reviewer consensus: 6/6 codex reviewers**

**Root cause (tool-factory.ts:190-195):**
```typescript
// Every MCP proxy tool in subagent gets:
inputSchema: Type.Object({})  // Empty schema — no parameter info
```

Meanwhile, the main agent path preserves real input schemas from MCP servers (`tools/index.ts:95`).

### Impact

- Subagent model has no information about MCP tool parameters
- Must guess argument structure → high failure rate
- Error messages from wrong arguments are generic text, not structured errors

### Recommended Fix

Pass the real MCP tool schemas through to subagent tool registration. The schemas are already available from `mcpManager.allTools()` — just forward them.

---

## 10. P1: MCP ensureConnected Race Condition

### The Bug

**Reviewer consensus: 4/6 codex reviewers**

**Root cause (manager.ts:144-155):**
- `ensureConnected()` has no lock or in-flight promise memoization
- Two concurrent first calls to the same lazy server will both:
  1. Initialize separate sessions
  2. Race on writing `conn.sessionId`
  3. Leave orphan sessions

**Additionally (klayout-client.ts:119, :145):**
- KLayout client has the same shared mutable `sessionId` pattern
- Parallel tool calls can attach to wrong MCP session

### Impact

Under parallel tool execution (if implemented), MCP calls can fail with stale session errors. Currently mitigated by serial execution, but becomes critical if P1:parallel-tools is implemented.

### Recommended Fix

Add a connection promise cache:
```typescript
private connectingPromises = new Map<string, Promise<void>>();

async ensureConnected(serverKey: string) {
  if (this.connections.get(serverKey)?.connected) return;
  if (!this.connectingPromises.has(serverKey)) {
    this.connectingPromises.set(serverKey, this._doConnect(serverKey));
  }
  await this.connectingPromises.get(serverKey);
}
```

---

## 11. P1: Tool Execution Orchestration

### The Gap

**Reviewer consensus: 4/7 reviewers**

**Claude Code's implementation (toolOrchestration.ts):**
- Partitions tool calls by `isConcurrencySafe()` flag
- Batches consecutive read-only tools together
- Runs read-only batches in parallel (max 10 concurrent)
- Runs non-read-only tools serially
- `StreamingToolExecutor.ts` handles ordered result emission, sibling cancellation, streaming fallback, interrupt behavior
- Tools can return `contextModifier` functions that transform subsequent context

**qlaybot's implementation:**
- All tool execution delegated to Pi-Agent's loop (serial)
- Subagent tools use synchronous `readFileSync`, `writeFileSync`, `execSync` (`tool-factory.ts:50`)
- No concurrency classification
- No streaming tool results
- No cancellation semantics

### Impact

- Multi-file reads serialized unnecessarily
- Subagent `execSync` blocks the event loop
- No way to cancel a tool mid-execution
- No streaming progress for long-running tools

### Recommended Fix

1. Add `isConcurrencySafe` metadata to tools
2. Implement a tool orchestrator that batches read-only tools for parallel execution
3. Replace `execSync` in subagent tools with async `exec` + timeout
4. Consider streaming tool results for long-running KLayout operations

---

## 12. P2: Medium Issues

### 12.1 Required MCP Failure Silently Downgraded

**Files:** `agent.ts:149-151`, `mcp/manager.ts:77`

`connectAll()` correctly throws when a required server fails, but `createDesignSession()` catches it, prints to stderr, and continues. The session runs without KLayout and no error is surfaced to the caller.

**Fix:** Re-throw or return an error status so callers can decide whether to proceed.

### 12.2 Config Loading Swallows All Errors

**Files:** `config.ts:254, :293, :356`

The entire load/merge/migration sequence is wrapped in bare `try/catch` that silently falls back to defaults. A malformed config can change models, disable tools, or reset settings with no user signal.

**Fix:** Log warnings for parse errors. Only catch specific expected errors (file-not-found), not all exceptions.

### 12.3 `/mcp enable/disable` Broken

**Files:** `commands/mcp.ts:119`, `agent.ts:63, :417`

The command expects `session.configDir` which doesn't exist on `QlayBotSession`. Always returns "No config directory available".

**Fix:** Add `configDir` to the session object, pointing to `~/.qlaybot/config/`.

### 12.4 Background Task System Half-Wired

**Files:** `agent.ts:189, :245`, `background/index.ts:21, :92`

`BackgroundTaskManager` exists with `isBackgroundable()` and `run()`, but no tool wrapper ever calls them. The `cancel()` method only flips status locally — the underlying promise continues and can overwrite the task to `completed`.

**Fix:** Wire `isBackgroundable()` into the tool execution path. Use `AbortController` for real cancellation.

### 12.5 RPC Mode Double-Records Responses

**Files:** `agent.ts:365`, `rpc.ts:155-156`

The session subscriber records the final assistant message on `agent_end`, and RPC mode records the same response again after `session.prompt()`.

**Fix:** Skip history recording in the session subscriber when running in RPC mode, or deduplicate in `InteractionHistory`.

### 12.6 Setup Validation Uses Wrong Protocol

**Files:** `setup.ts:10, :83, :141`

`validateApiKey()` and `detectKLayout()` use Node's `http` module even for `https://` URLs.

**Fix:** Use `https` module when URL scheme is HTTPS, or use `fetch()`.

### 12.7 `validateRoles()` Never Called

**Files:** `subagent/role-resolver.ts:37`, `config.ts:339`

The validation function exists but is never invoked. Config shallow-merges roles, so a partial user override can destroy required defaults (dropping `promptFile`, `baseTools`, etc.).

**Fix:** Call `validateRoles()` in `loadConfig()` after merge. Use deep merge for role objects.

### 12.8 `autoLaunch` Config Ignored

**Files:** `config.ts:79, :496`, `mcp/manager.ts:72`

Config carries `klayout.autoLaunch` but `getAllMCPServers()` drops it and `connectAll()` auto-launches unconditionally on first failure.

**Fix:** Check the `autoLaunch` flag before attempting auto-launch in `connectAll()`.

### 12.9 MCP Schema Lossy for Complex Types

**Files:** `tools/index.ts:56`, `mcp/types.ts:6`

`buildToolSchema()` ignores `enum`, nested object structure, and array item types. Arrays become `Type.Array(Type.Unknown())`, nested objects become `Type.Unknown()`.

**Fix:** Recursively convert JSON Schema types. Handle `enum`, `object` with nested properties, and typed arrays.

### 12.10 Subagent Doesn't Stop After submit_result

**Files:** `runner.ts:235`, `tool-factory.ts:221`

`submit_result` populates the result box, but the main loop continues calling `session.prompt()` until `maxTurns`, kill, or budget exhaustion. The subagent can keep making tool calls after it has finalized its answer.

**Fix:** Set a flag when `submit_result` is called and break the loop on the next iteration.

---

## 13. Claude Code Features Worth Adopting

### 13.1 Compaction Stack

**Claude Code has 5 compaction strategies:**
1. **Micro-compact** (`microCompact.ts:253`) — Lightweight in-place compression of individual messages, cache-aware
2. **Snip compact** — Remove middle messages, keep head and tail
3. **Session-memory compact** (`sessionMemoryCompact.ts:188`) — Background extraction of working memory from conversation, used during compaction
4. **Auto-compact** (`autoCompact.ts:27`) — Token-estimate-based triggering with circuit breakers
5. **Post-compact restoration** (`compact.ts:520, :1415`) — Restores up to 5 most-relevant files (50K token budget), active skills (25K), plan state, deferred tools

**qlaybot has 1:**
- Tool result pruning + optional manual compaction with state extraction

**Recommendation:** The domain-specific state extraction is excellent — keep it. Layer on top:
- Pre-turn token estimation to trigger compaction proactively
- Post-compaction file restoration (re-read recently accessed files)
- Consider a lighter micro-compact for individual large tool results

### 13.2 Session Memory

**Claude Code:** Background forked agent continuously distills the conversation into a maintained "session memory" artifact (`SessionMemory/sessionMemory.ts:315`). This is used during compaction to preserve important context that would otherwise be lost.

**qlaybot:** Has persistent memory (SQLite) but no equivalent "live conversation distillation" mechanism.

**Recommendation:** Add a background session-memory extraction step that runs periodically or before compaction. Store key decisions, design choices, and layout state changes.

### 13.3 Permission System

**Claude Code:** Three-tier system — pattern-based rules → hooks (external validators) → auto-classifier (LLM-based). Denial tracking after 3 denials forces interactive mode.

**qlaybot:** Binary plan-mode sandbox only.

**Recommendation:** Not urgent for a domain tool, but if expanding bash/write capabilities for autonomous operation, add a simple allowlist/blocklist pattern matcher.

### 13.4 Hook System

**Claude Code:** Lifecycle hooks (`pre_tool_use`, `post_tool_use`, `session_start`, `session_end`, `pre_compact`, `post_compact`) supporting shell commands, HTTP endpoints, and agent calls.

**qlaybot:** Event subscription (read-only observation) + slash commands. No intercepting hooks.

**Recommendation:** Add `pre_tool_use` / `post_tool_use` hooks that can modify inputs or block execution. Useful for safety checks on KLayout operations.

### 13.5 File State Cache

**Claude Code:** LRU cache of file reads (`fileStateCache.ts`), cloned into forks. Preserves edit validity across compaction and subagent context.

**qlaybot:** No file state cache. Subagent file tools are plain `readFileSync`/`writeFileSync`.

**Recommendation:** Add an LRU file cache to avoid redundant I/O, especially for subagents reading the same design files.

### 13.6 Context Attachment System

**Claude Code:** Rich attachment system (`attachments.ts`, `context.ts:113`) injects CLAUDE.md, git status, plans, tasks, memory files, MCP deltas, agent listings, diagnostics — each as a separate message with cache scope control.

**qlaybot:** Simple prompt + transform model.

**Recommendation:** Consider separating context injections into distinct messages/blocks rather than concatenating into the system prompt. This enables finer cache control.

---

## 14. Qlaybot Strengths to Preserve

These are areas where qlaybot is better or more specialized than Claude Code. Do not regress on these during enhancement work.

### 14.1 Domain-Specific Compaction State

**Files:** `src/compaction/state-extractor.ts:11`, `src/compaction/state-loader.ts:12`

Extracts and reloads `layout-state`, `design-rules`, and `workspace-state` as structured XML-tagged files. This is more targeted and useful for KLayout workflows than Claude Code's generic summarization.

### 14.2 SQLite FTS5 + Embeddings + Reranking Memory

**Files:** `src/memory/index.ts:78, :93, :229`, `src/memory/reranker.ts:11`

More sophisticated local search stack than Claude Code's file-based memory. The weakness is the injection policy (auto-recall contamination, P1 bug), not the storage/search backend.

### 14.3 KLayout MCP Integration

**Files:** `src/mcp/manager.ts:53, :102`, `src/mcp/klayout-client.ts:61`

Opinionated and production-practical: eager connect, auto-launch with retry timings, tool namespacing, session management.

### 14.4 Role-Based Subagent System

**Files:** `src/subagent/runner.ts`, `src/subagent/role-resolver.ts`, `src/subagent/tool-factory.ts`

Explicit roles (scout, designer, analyst, planner) with scoped tool access and budget enforcement. The design is sound — implementation needs the fixes outlined in P0/P1 sections.

### 14.5 Multi-Mode Interface

CLI supports interactive TUI, JSON single-shot, JSON-RPC, and plain readline modes. This enables automation, testing, and integration that Claude Code handles differently.

---

## 15. Recommended Implementation Order

### Phase 1: Fix Broken Things (1-2 days)

These are bugs that cause runtime failures or silent incorrect behavior:

1. **Fix subagent MCP tool naming** — Use namespaced names in `tool-factory.ts:176`
2. **Fix non-KLayout MCP tool discovery** — Eagerly connect all servers or build placeholder wrappers
3. **Fix transform pipeline order** — Swap auto-recall before state-loader in `agent.ts:297`
4. **Fix subagent submit_result continuation** — Break loop after result submission
5. **Fix `/mcp enable/disable`** — Add `configDir` to session
6. **Fix setup.ts protocol** — Use `https` for HTTPS URLs

### Phase 2: Fix Resource Leaks (1 day)

7. **Add subagent session cleanup** — Store unsubscribe, call dispose on all exit paths
8. **Fix subagent token accounting** — Track actual API usage, not context size
9. **Add MCP connection lock** — Promise memoization in `ensureConnected()`

### Phase 3: Add Cache Engineering (2-3 days)

10. **Split system prompt** — Static prefix + dynamic suffix with `cache_control` markers
11. **Add cache-break detection** — Hash static prefix, log changes
12. **Subagent prefix sharing** — Reuse parent's static prefix bytes
13. **Propagate real MCP schemas to subagents** — Forward actual input schemas

### Phase 4: Add Error Recovery (1-2 days)

14. **Add `prompt_too_long` recovery** — Catch, compact, retry
15. **Add `max_output_tokens` recovery** — Detect truncation, increase budget, retry
16. **Add config validation** — Parse errors surfaced to user, not silently defaulted

### Phase 5: Enhance Performance (2-3 days)

17. **Add parallel tool execution** — Concurrency classification + batching
18. **Replace subagent execSync** — Async exec with timeout
19. **Add post-compaction file restoration** — Re-read recently accessed files
20. **Wire background task system** — Connect `isBackgroundable()` to tool execution, real cancellation

### Phase 6: Advanced Features (3-5 days)

21. **Add session memory extraction** — Background distillation of conversation state
22. **Add pre/post tool hooks** — Intercepting hooks for safety/logging
23. **Add file state cache** — LRU cache shared with subagents
24. **Enhanced compaction** — Pre-turn token estimation, micro-compact for large results

---

## 16. Previously Missed Items (Added After Cross-Reference Audit)

These items were reported by reviewers but initially omitted or under-represented in the report.

### 16.1 MCP Timeout Not Passed Through During Connection Setup (P2)

**Source:** Issue Review 1 (Reviewer 4)
**Files:** `src/mcp/klayout-client.ts:49`, `src/mcp/transport.ts:73`

`KLayoutMCPClient.connect()` calls `initializeSession()` and `listTools()` without passing the configured timeout. Both fall back to the transport default of 5 seconds, even when the manager was instantiated with a larger timeout budget (e.g., `mcpTimeouts.requestMs: 10000`). This makes connection setup more failure-prone than the config implies.

**Fix:** Pass the configured timeout through to `initializeSession()` and `listTools()` calls.

### 16.2 Session Resume/Replay Capability (P3 Feature Gap)

**Source:** Reviewer 0 (Claude Opus) + Comparative Review 1 (Reviewer 1)
**Claude Code files:** `src/QueryEngine.ts`

Claude Code's `QueryEngine` owns message persistence, compact boundaries, SDK system/init events, and replay behavior. Sessions can be resumed from disk. qlaybot records transcripts to `~/.qlaybot/history/` but has no session resume capability — each session starts fresh.

**Recommendation:** Add session resume by reloading transcript JSONL and reconstructing Pi-Agent session state. Useful for long design sessions interrupted by crashes or restarts.

### 16.3 Model Price Tables Not Used for Runtime Budget Enforcement (P3)

**Source:** Comparative Review 1 (Reviewer 1)
**Files:** `src/config.ts:158`

qlaybot hardcodes model cost tables (input/output/cacheRead/cacheWrite per million tokens) in config, but repo-owned code only uses them for display/reporting, not for runtime budget enforcement or cost alerts.

**Recommendation:** Use price tables to calculate actual dollar cost per session/subagent. Add cost alerts or budget caps based on these numbers.

### 16.4 Reranker Cache Only In-Memory (P3)

**Source:** Comparative Review 1 (Reviewer 1)
**Files:** `src/memory/reranker.ts:9`

The reranker cache is an in-memory `Map` that helps avoid duplicate API calls within a single process. However, it doesn't persist across restarts or sessions, so the same reranking work is repeated in every new session.

**Recommendation:** Consider persisting reranker results in SQLite alongside the FTS5 index, keyed by (query_hash, entry_hash).

### 16.5 Dead Config Fields: `command`/`args` for MCP Servers (P2)

**Source:** Issue Review 3 (Reviewer 6)
**Files:** `src/config.ts:61`, `src/mcp/manager.ts:151`

Server config type declares `command` and `args` fields (for stdio-based MCP servers), but `MCPManager` only handles URL-based connections and throws if `url` is absent. The `command`/`args` fields are dead code that misleads users into thinking stdio MCP servers are supported.

**Fix:** Either implement stdio-based MCP server spawning, or remove `command`/`args` from the config type and document that only URL-based servers are supported.

### 16.6 KLayout Shared Mutable `sessionId` Under Parallel Calls (P2)

**Source:** Issue Review 3 (Reviewer 6)
**Files:** `src/mcp/klayout-client.ts:119, :145`

Beyond the generic `ensureConnected()` race condition (section 10), the KLayout client has a shared mutable `sessionId` that gets updated on every tool call response. If parallel tool calls are ever made to KLayout, follow-up calls can attach to the wrong MCP session.

**Fix:** Snapshot `sessionId` per-call or serialize KLayout calls.

### 16.7 Memory Retrieval Selectivity — Model-Based vs. FTS (P2 Feature Gap)

**Source:** Comparative Review 2 (Reviewer 2)
**Claude Code files:** `src/memdir/findRelevantMemories.ts:39, :87`

Claude Code's memory retrieval uses a model call to scan memory file headers and choose only clearly relevant files, with logic to avoid resurfacing docs for tools already in active use. qlaybot just does FTS5 search on the user's text and injects the top N results.

**Recommendation:** Add a lightweight relevance filter after FTS5 search — either a small model call or heuristic rules (e.g., skip memories about tools currently in the prompt).

### 16.8 SDK Skills Explicitly Disabled (P3)

**Source:** Comparative Review 1 (Reviewer 1)
**Files:** `src/agent.ts:271`

qlaybot sets `noSkills: true` in the resource loader, explicitly disabling Pi-Agent SDK's skill system. This may be intentional (to avoid conflicts with domain-specific behavior), but it means qlaybot cannot leverage any skills the SDK provides.

**Note:** This may be an intentional design choice. Document the rationale if so.

### 16.9 Auto-Recall Injects Synthetic User Message — Cache-Hostile (P2)

**Source:** Comparative Review 3 (Reviewer 3)
**Files:** `src/memory/auto-recall.ts:24, :49`

Beyond the transform-order contamination bug (section 8), auto-recall injects recalled memories as a synthetic user message *before* the current user turn. This changes the message array shape on every turn where recall fires, which is inherently cache-hostile — the API sees a different message sequence each time.

Claude Code's session memory is injected via a cache-safe forked agent and used during compaction, not by mutating the message array.

**Recommendation:** Consider injecting recalled memories into the system prompt suffix (dynamic section) rather than as a synthetic user message. This preserves message-array stability for caching.

---

## Appendix: Reviewer Raw Outputs

### Codex Comparative Review 1 (Reviewer 1)
Key unique findings:
- Identified `queryContext.ts` for cache-key discipline
- Noted `promptCacheBreakDetection.ts` as explicit cache-break tracker
- Highlighted that qlaybot disables SDK skills with `noSkills: true`
- Called out session-memory compaction as a distinct Claude Code advantage

### Codex Comparative Review 2 (Reviewer 2)
Key unique findings:
- Identified `microCompact.ts:253` with `cache_reference` for cache-stable compaction
- Found `cache_edits` replay for cached microcompact
- Noted that auto-recall injects a synthetic user message, which is "prompt-shape churn and likely cache-hostile"
- Called out `qlaybot`'s background-task cancellation as "mostly cosmetic"

### Codex Comparative Review 3 (Reviewer 3)
Key unique findings:
- Found that Claude Code's fork subagents disable thinking to reduce output burn for non-fork agents
- Identified `SessionMemory` as a continuously maintained working memory artifact
- Noted that qlaybot's context is "actively weaker than it looks" due to transform order

### Codex Issue Review 1 (Reviewer 4)
Key unique findings:
- First to identify subagent post-`submit_result` continuation bug
- Found MCP timeout not passed through during connection setup
- Identified that background task `cancel()` never aborts the underlying promise

### Codex Issue Review 2 (Reviewer 5)
Key unique findings:
- First to identify MCP `ensureConnected()` race condition explicitly
- Found that required MCP failure is silently downgraded
- Identified RPC double-recording of assistant responses

### Codex Issue Review 3 (Reviewer 6)
Key unique findings:
- First to identify subagent MCP tool naming mismatch (annotation vs namespaced names)
- Found that `validateRoles()` exists but is never called
- Identified that `autoLaunch` config is ignored — auto-launches unconditionally
- Found `config.command`/`args` fields are dead — MCPManager only handles URLs
