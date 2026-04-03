# qlaybot v0.4.1 — Codex Quality Review Report

**Date:** 2026-04-03
**Reviewer:** OpenAI Codex (gpt-5.3-codex, reasoning: high, read-only sandbox)
**Scope:** Full qlaybot agent codebase (`agent/src/`)
**Method:** 5 parallel independent reviews, each covering a distinct layer

## Executive Summary

Five independent Codex reviewers assessed the qlaybot codebase across all layers. The consensus is harsh: **2.8/10 average**, with no layer scoring above 3/10. The codebase compiles cleanly (`tsc --noEmit` passes) and has 697 passing tests, but the reviews expose systemic design-level and runtime defects hidden behind loose typing and broad error suppression.

| # | Layer | Score | Critical | High | Medium | Low | Total |
|---|-------|-------|----------|------|--------|-----|-------|
| 1 | Core Agent | 3/10 | 5 | 9 | 8 | 8 | 30 |
| 2 | MCP + Tools | 3/10 | 5 | 9 | 4 | 3 | 21 |
| 3 | TUI | 2/10 | 4 | 9 | 8 | 4 | 25 |
| 4 | Memory + Compaction | 3/10 | 2 | 6 | 8 | 4 | 20 |
| 5 | Subagent + Planning + Commands | 3/10 | 3 | 8 | 10 | 8 | 29 |
| | **Totals** | **2.8** | **19** | **41** | **38** | **27** | **125** |

---

## 1. Security — Code Injection & Path Traversal

**Severity: CRITICAL**
**Affected layers: MCP+Tools, Core Agent, Memory, Subagent**

### 1.1 Python code injection via string interpolation

All domain tools (geometry, display, image) construct Python source code by interpolating user-controlled arguments directly into string templates. A crafted `cell`, `name`, `filepath`, or `mode` value can break out of the quoted string and execute arbitrary Python in the KLayout process.

| File | Line(s) | Parameter(s) |
|------|---------|--------------|
| `tools/klayout/geometry.ts` | 56, 81, 109, 131, 153 | `cell`, `name`, `parent`, `child` |
| `tools/klayout/display.ts` | 50 | `mode` |
| `tools/klayout/image.ts` | 54, 60, 102 | `filepath`, numeric/bool fields |

**Impact:** Remote code execution inside KLayout. Although the LLM is the immediate caller, prompt injection or malicious MCP relay could exploit this.

**Recommendation:** Use parameterized code generation — pass arguments as a JSON payload and `json.loads()` on the Python side, or use a template engine with proper escaping.

### 1.2 Path traversal via unsanitized identifiers

Multiple filesystem paths are constructed by joining user-influenced strings without normalization or bounds checking:

| File | Line(s) | Parameter | Risk |
|------|---------|-----------|------|
| `history.ts` | 24, 26 | `sessionId` | Escape history directory |
| `history.ts` | 119 | `toolName` | Arbitrary file write via `../` in tool name |
| `memory/index.ts` | 128, 167, 511, 520 | `category` | Escape memory directory |
| `subagent/transcript.ts` | 25, 93, 94 | `role`, `logDir` | Escape log directory |
| `subagent/prompt-builder.ts` | 20, 27 | Role config paths | Read arbitrary files |
| `tools/memory.ts` | 11, 36 | `category` | Propagates to unsafe path construction |

**Recommendation:** Validate all path components against `[a-zA-Z0-9_-]`, resolve with `path.resolve()`, and verify the result starts with the expected base directory.

### 1.3 Command injection in workspace file opener

`workspace.ts:94` uses `` exec(`open "${filePath}"`) `` which allows shell expansion (`$(...)`, backticks) from untrusted file paths.

**Recommendation:** Use `execFile('open', [filePath])` (no shell interpolation).

---

## 2. Security — Sensitive Data Exposure

**Severity: CRITICAL to HIGH**
**Affected layers: Core Agent, Subagent**

### 2.1 Unredacted chain-of-thought and tool data persisted to disk

Session history writes raw thinking tokens, tool arguments, and tool results to `~/.qlaybot/history/` without any redaction. Subagent transcripts do the same.

| File | Line(s) | What is persisted |
|------|---------|-------------------|
| `agent.ts` | 377, 385 | Thinking + response text |
| `history.ts` | 95, 106 | Raw tool args + results |
| `subagent/runner.ts` | 201, 204 | Thinking deltas |
| `subagent/transcript.ts` | 67 | Full thinking content |

**Impact:** API keys, user data, internal reasoning, and potentially sensitive tool outputs accumulate on disk indefinitely. Compliance and security risk.

**Recommendation:** Add a redaction layer before persistence. At minimum, strip known sensitive patterns (API keys, tokens). Consider making history opt-in or adding retention policies.

---

## 3. Security — Sandbox & Permission Enforcement Gaps

**Severity: CRITICAL**
**Affected layers: Subagent, Planning, MCP+Tools**

### 3.1 Plan mode bypassable via delegation

Plan mode sandbox allows the `delegate` tool. Delegated subagents are NOT plan-sandboxed, so they can run mutating tools (`bash`, `write`, `edit`) that the plan sandbox is supposed to block.

- `sandbox.ts:14,29` — `delegate` in allowlist
- `runner.ts:116` — no sandbox propagation
- `tool-factory.ts:111,143,183` — subagent tools created without sandbox

### 3.2 Subagent tools have unsandboxed host access

Subagent `bash` tool runs `execSync` with no cwd restriction or command allowlist. `read/edit/write` tools resolve arbitrary filesystem paths. This means any subagent role can access the entire host filesystem and run arbitrary commands.

- `tool-factory.ts:95,121,155,194`

### 3.3 Disabled tools reappear in subagent runs

`ToolFactoryDeps` supports `disabledTools`, but runner never passes the disabled list to the tool factory. Disabled MCP tools can be called by subagents.

- `tool-factory.ts:27,218` — supports but receives nothing
- `runner.ts:116` — never passes `disabledTools`

### 3.4 "Disabled execute_script" is bypassable by design

All domain tools internally call native `execute_script` via `klayout-client.ts:145`. Disabling `execute_script` at the MCP level does not prevent domain tools from using it.

**Recommendation:** Propagate sandbox constraints to subagent tool construction. Implement a permissions model that cannot be circumvented by indirection.

---

## 4. Type Safety Erosion

**Severity: HIGH to MEDIUM**
**Affected layers: ALL (flagged in every review)**

Extensive use of `as any`, `as unknown as`, and unchecked casts across the entire codebase. TypeScript strict mode is effectively diluted in critical paths.

### Key locations:

| Layer | Files | Examples |
|-------|-------|---------|
| Core Agent | `agent.ts:200,246,429` | SDK method monkey-patch with `as any` |
| MCP+Tools | `tools/index.ts:145,147,172` | Weak overload discrimination |
| TUI | `reducer.ts:379,773,883`, `App.tsx:180` | Undocumented `(s as any).paused` state |
| Memory | `vector-search.ts:23`, `auto-recall.ts:33` | `db: any`, message casts |
| Subagent | `runner.ts:58,163,197,376`, `tool-factory.ts:78` | Event and config casts |

**Impact:** Compile-time guarantees are meaningless when runtime types diverge. Bugs manifest as silent incorrect behavior rather than caught errors.

**Recommendation:** Eliminate `any` casts systematically. Define proper interfaces for SDK interop boundaries. Use discriminated unions for event types.

---

## 5. Error Handling — Silent Swallowing

**Severity: HIGH**
**Affected layers: ALL**

A pervasive pattern of `try/catch` blocks that swallow errors and return defaults, hiding operational failures from users and operators.

### 5.1 Config loading

`config.ts:254,356` — Parse and filesystem errors return defaults or partial state. Config corruption is invisible. Migration side-effects during reads (`config.ts:293,295,305`) can silently fail.

### 5.2 MCP connections

`manager.ts:96,99` — Required server connect failures are swallowed and logged, violating `required` semantics. `agent.ts:151,157` — Required MCP servers are effectively optional at runtime.

### 5.3 Network calls (memory layer)

`embedder.ts:22`, `reranker.ts:30,69`, `memory/index.ts:494` — No `resp.ok` checks, no schema validation, broad catches hide failures. Search degrades silently to empty results.

### 5.4 Config persistence (commands)

`config.ts:187,191`, `model.ts:56,61` — Write failures swallowed while reporting success to user. `mcp.ts:145,147,183,185` — Parse failures overwrite data with `{}` and proceed to write (silent data loss).

**Recommendation:** Adopt an explicit error strategy: log + propagate for infrastructure errors, log + degrade-with-warning for optional features. Never silently swallow errors that affect correctness.

---

## 6. Broken or Dead Features

**Severity: HIGH**
**Affected layers: TUI, MCP+Tools, Commands**

### 6.1 TUI — broken control paths

| Feature | Issue | Location |
|---------|-------|----------|
| Subagent kill | Reducer sets `status: "partial"` but App checks `(entry as any).killed` — never matches | `reducer.ts:867`, `App.tsx:260` |
| Subagent inject | Reducer clears target/value on submit before effect checks them — inject never called | `reducer.ts:860`, `App.tsx:272` |
| SubagentPanel runtime | App imports `.js` shim, not `.tsx` — inject key handling missing in JS version | `App.tsx:17`, `SubagentPanel.js:127` |
| Config editing | No character/backspace path updates `editValue` — editing is non-functional | `ConfigPanel.tsx:239` |
| MCP reconnect | `CONFIG_PANEL_MCP_RECONNECT` is a no-op in reducer, no side-effect handler | `reducer.ts:646`, `ConfigPanel.tsx:148` |
| Background cancel | Bar shows `k = cancel` but no key handler exists, `onCancel` unused | `BackgroundBar.tsx:15,73` |
| Command history | `loadHistory()` exists but never called at startup — persistence disabled | `history.ts:10`, `InputBox.tsx:39` |

### 6.2 Nanodevice tools — fake success stubs

`nanodevice.ts:49,68,88,104` — Tools return `"status": "ok"` without executing real work. Silent correctness failure.

### 6.3 Setup wizard — dead validators

`setup.ts:69,141,204` — `validateApiKey` and KLayout detection functions exist but are never called. `skipValidation` parameter is accepted but unused.

### 6.4 Dead code inventory

| File | Line(s) | What |
|------|---------|------|
| `context.ts` | 11, 28 | Entire file appears unused |
| `planning/index.ts` | 55 | `PlanManager.wrapTool` — redundant |
| `role-resolver.ts` | 24, 37 | `listRoles`, `validateRoles` — unused |
| `klayout-client.ts` | 11 | Unused imports |
| `transport.ts` | 10 | `TransportOptions` — unused type |
| `tools/index.ts` | 36 | `DEFAULT_ANNOTATIONS` — unused |
| `StatusBar.tsx` | 22 | `formatTokens` — unused |
| `reducer.ts` | 65, 396, 399 | Dead completion state, `showThinking`, `backgroundTaskCount` |

---

## 7. Concurrency & Resource Management

**Severity: HIGH to MEDIUM**
**Affected layers: Core Agent, Memory, TUI**

### 7.1 Synchronous IO blocking event loop

Sync filesystem and child process APIs used throughout hot paths:

| File | API | Path |
|------|-----|------|
| `history.ts:67,118` | `appendFileSync`, `writeFileSync` | Every tool call + response |
| `config.ts:257` | `readFileSync` | Config loading |
| `memory/index.ts:176,404,525` | `readFileSync`, `appendFileSync`, `unlinkSync` | Memory retrieval |
| `tool-factory.ts:96,121` | `readFileSync`, `execSync` | Subagent tool execution |
| `workspace.ts:59` | `statSync` (recursive) | Startup scan |

### 7.2 Race conditions

- `rpc.ts:39,67` — RPC requests not serialized; concurrent requests can corrupt shared `botSession` state
- `rpc.ts:83` — `initialize` can overwrite live session without disposing (resource leak)
- `memory/index.ts:380,426` — No reindex concurrency guard; concurrent calls rebuild indexes redundantly
- `cli.ts:234,249` — Interactive plain mode allows overlapping prompts (no in-flight guard)

### 7.3 Resource leaks

- `agent.ts:151,288` — No cleanup if `createDesignSession` throws mid-setup
- `cli.ts:203,210` — No `finally` disposal around TUI render failure
- `InputBox.tsx:118` — `Ctrl+C` hard exits, bypassing `dispose()`

### 7.4 Unbounded growth

- `reranker.ts:9,67` — Rerank cache grows forever (memory leak)
- `memory/auto-recall.ts:56`, `compaction/state-loader.ts:31` — Injected context has no size cap
- `subagent/transcript.ts:19,65` — All entries held in memory until save

---

## 8. Protocol & Contract Compliance

**Severity: MEDIUM**
**Affected layers: Core Agent, MCP+Tools**

### 8.1 JSON-RPC compliance

- `rpc.ts:72,77` — Parse errors use `id: 0` instead of `id: null`; notification handling not respected
- `transport.ts:55,62` — No validation of `jsonrpc` field or `id` correlation on responses

### 8.2 Schema conversion

- `mcp/types.ts:8`, `tools/index.ts:56,73` — JSON Schema to TypeBox conversion is lossy: drops `enum`, nested array items, object shapes, and defaults

### 8.3 HTTPS protocol bug

- `setup.ts:10,95,98,147,150` — Uses `http.request` even for `https` URLs. TLS is never negotiated.

### 8.4 Tool routing

- `manager.ts:236,241` — Server key parsing splits on first `_` only; `my_server_tool` routes to `my` instead of `my_server`

---

## 9. Data Integrity Issues

**Severity: HIGH to MEDIUM**
**Affected layers: TUI, Memory**

### 9.1 History format self-corruption

Two writers use incompatible schemas for the same file: `useCommandHistory.ts:90` saves a plain array, while `history.ts:24` and recency saver write `{entries, recency}`. Whichever writes last destroys the other's data.

### 9.2 Recency key mismatch

Ghost text ranking uses `/name` for lookup (`InputBox.tsx:187`, `ghost.ts:49`), but recency is saved as `parsed.name` (no slash, `App.tsx:404`). Recency-based ordering is non-functional.

### 9.3 Memory parser fragility

`parser.ts:18` — Splits entries on `^## `, so normal markdown headings inside content corrupt entry boundaries.

### 9.4 Config migration side-effects

`config.ts:293,295,305` — `loadConfig` has write side-effects (migrations) during reads. Can fail silently and leave partial state.

### 9.5 Double reindex

`auto-recall.ts:50`, `memory/index.ts:251,427` — Auto-recall does a sync stale reindex, then `search()` does another async one. Wasteful double work on every query.

---

## 10. Architectural Concerns

**Severity: MEDIUM**
**Affected layers: TUI, MCP+Tools**

### 10.1 TS/JS source drift

`ConfigPanel.js`, `SubagentPanel.js`, and `focus.js` are manually maintained JS shims that diverge from their `.tsx` counterparts. Runtime imports the `.js` versions (`App.tsx:16,17`), so TSX improvements and bug fixes are not reflected at runtime. This is a maintenance trap.

### 10.2 Duplicate state

- `types.ts:84,101` — `planMode` + `inPlanMode` duplicate state, inviting drift
- `planning/index.ts:7`, `sandbox.ts:8,14` — Two separate plan-mode allowlists that can diverge

### 10.3 Cross-provider API key fallback

`agent.ts:141,145,183` — If provider A has no auth, code injects the first available key from provider B. This leaks credentials cross-provider and causes confusing auth failures.

### 10.4 Model fallback

`config.ts:470` — `resolveModel` silently falls back to first available model if requested model is unknown. Masks config mistakes, can cause accidental spend.

### 10.5 Vector search scalability

`vector-search.ts:28` — Full-table scan for every query. No ANN index strategy. Will not scale beyond small memory stores.

---

## 11. Minor Issues (Low Severity)

| # | Issue | Location |
|---|-------|----------|
| 1 | `Delete` key treated as backspace | `InputBox.tsx:129` |
| 2 | `focus.js` claims CJS but uses ESM syntax | `focus.js:1` |
| 3 | `main().catch` assumes `err.message`; non-Error throws produce `undefined` | `cli.ts:361` |
| 4 | `loadMemoryContext` output order nondeterministic | `context.ts:32` |
| 5 | Dead parameter `_config` accepted and ignored | `compaction/prompt-loader.ts:40` |
| 6 | `extractTag` builds regex from unescaped tag name | `compaction/state-extractor.ts:21` |
| 7 | Tool-name lookup stops at first assistant message | `compaction/tool-result-pruner.ts:33,43` |
| 8 | Config values not sanity-checked (negatives allowed) | `compaction/index.ts:37`, `tool-result-pruner.ts:120` |
| 9 | `initializeUserDir` claims refresh but never overwrites | `config.ts:587`, `cli.ts:153` |
| 10 | `templateDir` in setup wizard is unused | `setup.ts:207` |
| 11 | Events.ts doesn't isolate callback exceptions | `events.ts:41,67` |
| 12 | Prompt MCP section hardcodes "6 native MCP tools" | `prompts/sections/mcp.ts:8` |
| 13 | Skills frontmatter parser is not real YAML | `prompts/sections/skills.ts:91,97` |
| 14 | Skills ordering nondeterministic, no size cap | `prompts/sections/skills.ts:28,68` |
| 15 | Prompt tooling section claims descriptions but emits only names | `prompts/sections/tooling.ts:2,8` |
| 16 | `disconnect()` leaves stale domain tool registry | `klayout-client.ts:177` |
| 17 | `callTool()` doesn't enforce connection precondition | `klayout-client.ts:99` |
| 18 | Vector dimension mismatch produces silent NaN | `vector-search.ts:11,40` |
| 19 | `/config` help is stale (missing `setup`) | `commands/config.ts:87,207` |
| 20 | `/config set` truncates values with spaces | `commands/config.ts:114` |
| 21 | Command metadata duplication invites drift | `commands/index.ts:87,103` |
| 22 | Context command hardcodes workspace path | `commands/context.ts:17` |
| 23 | Compact fallback ignores session workspace | `commands/compact.ts:21,27` |

---

## SQL Injection Assessment

Codex confirmed that **SQL injection is NOT present** in the memory layer. All SQL uses prepared statements with parameters for user-influenced inputs (`memory/index.ts:316`, `vector-search.ts:28`). The bigger security surface is path traversal and prompt injection, not SQL.

---

## Positive Notes

Despite the harsh scores, the reviews acknowledged:

- **TypeScript compilation is clean** — `tsc --noEmit` passes with no errors
- **697 tests pass** — broad test coverage exists, even if runtime behavior diverges from tested contracts
- **Core architectural ideas are sound** — FTS5 memory, context compaction, subagent delegation, domain tool abstraction are all workable foundations
- **No SQL injection** — parameterized queries used correctly throughout

---

## Recommended Priority Order

1. **Security (Sections 1-3):** Code injection, path traversal, sandbox enforcement — these are exploitable and should be fixed before any public deployment
2. **Broken features (Section 6):** Dead TUI controls and fake-success stubs undermine user trust and correctness
3. **Error handling (Section 5):** Silent swallowing masks real failures and makes debugging impossible
4. **Type safety (Section 4):** Systematic `any` elimination to make the compiler useful again
5. **Concurrency (Section 7):** Async IO migration and race condition guards
6. **Architecture (Section 10):** Eliminate JS shim drift, deduplicate state
7. **Protocol compliance (Section 8):** JSON-RPC and schema correctness
8. **Minor issues (Section 11):** Cleanup pass

---

*Generated by 5 independent Codex (gpt-5.3-codex) reviewers with high reasoning effort, consolidated by Claude Opus 4.6.*
