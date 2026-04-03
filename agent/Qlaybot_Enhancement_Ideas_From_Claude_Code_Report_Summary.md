# Qlaybot Enhancement Report (Summary)

**Source**: 7-reviewer analysis (Claude Opus deep exploration + 3 comparative Codex reviews + 3 issue-focused Codex reviews)
**Date**: 2026-04-01
**Scope**: Claude Code (open-source) vs qlaybot agent harness — functional, feature, and realization gaps

---

## Executive Summary

qlaybot is a capable domain-specialized agent harness with strong KLayout integration, SQLite FTS5 memory, and role-based subagents. However, compared to Claude Code's harness mechanics, qlaybot has significant gaps in **prompt cache engineering**, **context lifecycle management**, **error recovery**, **tool execution orchestration**, and **subagent reliability**. These gaps directly impact cost, latency, cache hit rate, and long-session stability.

The most impactful issues are not missing features but **realization details** — how existing features are implemented affects performance far more than whether they exist.

---

## Top 10 Issues by Impact

### P0 — Critical (Cost/Reliability)

| # | Issue | Impact | Consensus |
|---|-------|--------|-----------|
| 1 | **No prompt cache engineering** — System prompt rebuilt flat every session with no `cache_control` markers, no static/dynamic boundary, no cache-break detection | 40-60% higher API costs, no cross-turn cache reuse | 7/7 reviewers |
| 2 | **No `prompt_too_long` error recovery** — If context exceeds limits mid-turn, the turn fails with no automatic recovery | Session death on long conversations | 5/7 reviewers |
| 3 | **Non-KLayout MCP tools undiscoverable** — Lazy servers never get tool wrappers built because `allTools()` only returns connected servers, but wrappers are built at startup | Generic MCP servers completely broken | 6/6 codex reviewers |
| 4 | **Subagent MCP tools use wrong names** — Annotation names (e.g., `screenshot`) don't match required namespaced names (e.g., `klayout_native_screenshot`), so `callTool()` rejects them | Subagent MCP calls fail at runtime | 3/6 codex reviewers |

### P1 — High (Performance/Correctness)

| # | Issue | Impact | Consensus |
|---|-------|--------|-----------|
| 5 | **Subagent session/listener leaks** — No `dispose()`, no unsubscribe on any exit path | Memory growth over delegations | 6/6 codex reviewers |
| 6 | **Subagent token accounting wrong** — Reports context size as input tokens, hardcodes output to 0 | Inaccurate cost tracking, budget overshoot | 5/6 codex reviewers |
| 7 | **Transform pipeline order bug** — State loader injects `<compaction-state>` into user message before auto-recall, contaminating memory search queries | Wrong memory recall results | 6/6 codex reviewers |
| 8 | **Subagent MCP schemas empty** — All proxied MCP tools use `Type.Object({})` with no parameter info | Model guesses arguments, high failure rate | 6/6 codex reviewers |
| 9 | **MCP `ensureConnected()` race condition** — No lock on first-connect, concurrent calls can create orphan sessions | Stale session failures under parallel use | 4/6 codex reviewers |
| 10 | **No parallel tool execution** — All tools run serially via Pi-Agent | Multi-read operations unnecessarily slow | 4/7 reviewers |

### P2 — Medium (Robustness)

| Issue | Impact |
|-------|--------|
| Required MCP failure silently downgraded | Runs without KLayout with no error signal |
| Config loading swallows all errors | Bad config silently falls back to defaults |
| `/mcp enable/disable` broken | Session lacks `configDir` property |
| Background task system half-wired | `isBackgroundable()` never called, `cancel()` cosmetic |
| RPC mode double-records responses | Duplicate transcript entries |
| `validateApiKey()` uses `http` for `https` URLs | TLS validation fails |
| `validateRoles()` defined but never called | Bad role configs fail late |
| `autoLaunch` config ignored | Always auto-launches regardless |

---

## Qlaybot Strengths to Preserve

1. **Domain-specific compaction** — XML-tagged state extraction (`layout-state`, `design-rules`, `workspace-state`) is better than Claude Code's generic approach for KLayout workflows
2. **SQLite FTS5 + embeddings + reranking** memory — More sophisticated local search than Claude Code's file-based memory
3. **KLayout MCP integration** — Eager connect, auto-launch, retry timings, tool namespacing
4. **Role-based subagent system** — Explicit roles with scoped tool access and budget enforcement (design is good, implementation needs fixes)
5. **Event subscription system** — Clean observer pattern for TUI/RPC/history

---

## Recommended Fix Order

1. Fix subagent MCP tool naming (broken at runtime)
2. Fix non-KLayout MCP tool discovery (broken at startup)
3. Add subagent session cleanup (`dispose()` + unsubscribe)
4. Swap transform pipeline order (auto-recall before state-loader)
5. Add prompt cache `cache_control` markers to system prompt
6. Propagate real MCP schemas to subagent tools
7. Add `prompt_too_long` error recovery with auto-compaction
8. Fix token accounting in SubagentRunner
9. Add connection lock to `ensureConnected()`
10. Add config validation with user-visible errors

---

---

## Items Added After Cross-Reference Audit

9 items were initially missed or under-represented. Now included in both reports:

| # | Issue | Severity | Source |
|---|-------|----------|--------|
| 1 | MCP timeout not passed through during KLayout connection setup | P2 | Issue Codex 1 |
| 2 | No session resume/replay capability | P3 | Opus + Quality Codex 1 |
| 3 | Model price tables exist but unused for runtime budget enforcement | P3 | Quality Codex 1 |
| 4 | Reranker cache only in-memory, lost on restart | P3 | Quality Codex 1 |
| 5 | Dead config fields `command`/`args` — stdio MCP not implemented | P2 | Issue Codex 3 |
| 6 | KLayout shared mutable `sessionId` unsafe under parallel calls | P2 | Issue Codex 3 |
| 7 | Memory retrieval lacks model-based relevance filtering | P2 | Quality Codex 2 |
| 8 | SDK skills explicitly disabled (`noSkills: true`) | P3 | Quality Codex 1 |
| 9 | Auto-recall injects synthetic user message (cache-hostile pattern) | P2 | Quality Codex 3 |

---

*See `Qlaybot_Enhancement_Ideas_From_Claude_Code_Report_Detail.md` for full analysis with code references.*
