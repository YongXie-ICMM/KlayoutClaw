# Issue #23 — Delegate Subagent Always Fails (TDD-Debug + API Redesign)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:systematic-debugging` for Phase 1, then `superpowers:test-driven-development` for Phases 2–3. Do NOT skip to the redesign before the root cause is named.

**Goal (two layers):**
1. **Fix the runtime crash** that causes every `delegate` tool call to fail with `Cannot read properties of undefined (reading 'startsWith')` before any API call.
2. **Redesign the delegate API** to match the Claude Code `Agent` tool pattern — the agent should be able to spawn a subagent with just `{task, prompt?, model?, subagent_type?}` and a sensible `"general-purpose"` default, without needing every role pre-declared in `config.roles`.

**Ground truth bug signature** (from ml14 transcript entry 14, `/Volumes/RandomData/harbour-workspace/qlaybot/ml14/qlaybot-transcripts/session_1776928889652-20260423-072129.jsonl`):
```json
{
  "status": "error",
  "turns": 1,
  "tokenUsage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
  "errorMessage": "Cannot read properties of undefined (reading 'startsWith')"
}
```
0 tokens + turns=1 means the exception fires synchronously inside `await session.prompt(taskMessage)` at `runner.ts:311`, caught by the try/catch at `:323–356`.

**Reference pattern:** `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/AgentTool.tsx:82–102` (input schema) and `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/prompt.ts:99–113` (writing-the-prompt guidance).

---

## Prerequisites

- Branch off `main`.
- `cd /Users/andrewwayne/testFolder/KlayoutClaw/agent && npm install`
- `npm run build` passes on baseline
- Read `agent/src/subagent/runner.ts:1–200` and `agent/src/tools/delegate.ts` before starting.

---

## Phase 1 — Name the exact failure point

The TypeError is thrown from inside pi-agent-core during session construction or first `.prompt()`. Before fixing, name the exact field that is undefined. Do NOT patch around the symptom.

- [ ] **Add diagnostic logging** in `runner.ts` at line 152 (after model resolution):

```ts
console.error("[DEBUG delegate]", JSON.stringify({
  modelId,
  provider,
  bareModelId,
  resolvedModel: resolvedModel === null ? "null" : resolvedModel === undefined ? "undefined" : "present",
  resolvedModelId: (resolvedModel as any)?.id,
  resolvedModelProvider: (resolvedModel as any)?.provider,
  defaultModel: this.deps.defaultModel,
  thinkingLevel,
}));
```

Add a try/catch around the `new Agent(...)` and `new AgentSession(...)` constructor calls that logs the stack trace (not just the message) when a TypeError is thrown.

- [ ] **Reproduce the failure** in a unit test (new file `agent/tests/unit/test-subagent-delegate-repro.ts`):

```ts
import { SubagentRunner } from "../../src/subagent/runner.js";
// ... construct SubagentRunner with the same deps qlaybot uses at benchmark time
// (pull defaultModel from a fresh createDesignSession config snapshot)
// Call runner.run({ role: "designer", task: "test task", toolCallId: "t1" })
// Assert: result.status === "error" AND result.errorMessage.includes("startsWith")
```

This test is the REPRO — it runs green against the current bug.

- [x] **Record the finding** (actual root cause — hypothesis was WRONG):

**Finding (2026-04-23):** The TypeError is NOT from model resolution. It's from `AgentSession.prompt(text)` being called with `text=undefined`.

- Crash site: `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:500`:
  ```js
  if (expandPromptTemplates && text.startsWith("/")) { ... }
  ```
- Caller: `runner.ts:308-314`:
  ```ts
  if (promptArg !== undefined) {
    await session.prompt(promptArg);
  } else if (turns === 0) {
    await session.prompt(taskMessage);
  } else {
    await session.prompt();   // ← text=undefined → crash at startsWith
  }
  ```
- Transcript signature fits: `turns: 1` + 0 tokens means turn 0 completed (prompt(taskMessage) returned), loop iterated, `turns !== 0` and no injected `promptArg` → else branch → `prompt()` with no args → crash before any LLM call.
- Rules out the plan's model-resolution hypothesis: if `model` were undefined, pi-agent-core would throw `"No model configured"` (`agent.js:275-276`) or `AgentSession.prompt` would throw `"No model selected"` (`agent-session.js:548-551`), neither matches.

**Architectural implication:** `AgentSession.prompt(text)` runs a FULL agentic turn internally (tool calls and all) — you don't re-call `prompt()` to "continue". Subsequent calls need a new user message. The runner's turn loop is structurally wrong: it re-enters `prompt()` each iteration, which is only valid with a new injected message or a new task.

---

## Phase 2 — Fix the runtime crash

The fix MUST either:
- (a) Make `resolveModel` always return a valid `Model<any>` object, OR
- (b) Hard-fail with a clear error message in `runner.ts` before calling `new Agent(...)` when model resolution failed, instead of silently passing `undefined`.

Prefer (a) if a sensible fallback exists (e.g., inherit the parent's exact model object). (b) is acceptable as a guardrail so future regressions surface loudly.

- [ ] **Write the failing test first** — extend `test-subagent-delegate-repro.ts` with:
  - A test that calls `runner.run()` with valid parent-model config and asserts `result.status !== "error"` (post-fix)
  - A test that calls `runner.run()` with a deliberately broken `defaultModel` (e.g., `"nonexistent-provider/fake"`) and asserts `result.errorMessage` contains a helpful message like `"failed to resolve subagent model"` — NOT `"startsWith"`

- [ ] **Implement the fix** in `runner.ts:149–171`. Likely shape:

```ts
// BEFORE new Agent(...) — resolve model, fail clearly if not found
const [provider, bareModelId] = modelId.includes("/")
  ? [modelId.split("/")[0], modelId.split("/").slice(1).join("/")]
  : ["", modelId];
const resolvedModel = this.deps.modelRegistry.find(provider, bareModelId);

if (!resolvedModel) {
  // Preferred: fall back to parent model object if available
  // (requires threading parentModelObj through deps)
  // Guardrail fallback: fail loudly with diagnostic info
  return {
    role, task, status: "error",
    findings: [], warnings: [], dataPaths: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
    transcriptPath: transcript.save(),
    errorMessage: `Subagent model resolution failed: modelId="${modelId}" provider="${provider}" bareModelId="${bareModelId}". Check that config.roles["${role}"].model or the parent default model is registered in ModelRegistry.`,
  };
}
```

Depending on what Phase 1 revealed, the real fix may also be to change the `defaultModel` format passed into `SubagentRunnerDeps` (e.g., parent passes the fully-qualified `"custom-anthropic/claude-sonnet-4-6"` but ModelRegistry indexes under `"anthropic"` — that's a separate bug that needs fixing at the wire-up site, likely `agent.ts` where `createDesignSession` builds `SubagentRunnerDeps`).

- [ ] **Run repro tests**: both the "valid config works" test and the "broken config fails cleanly" test pass.

- [ ] **Run full unit suite**: `npm run test:unit` — `test-subagent.ts` (64 tests) must still pass.

---

## Phase 3 — Redesign the delegate tool to be easy to use

Study the Claude Code `Agent` tool's input schema before writing the new one:
- `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/AgentTool.tsx:82–102`
- `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/prompt.ts:99–113` — the "writing the prompt" guidance
- `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/built-in/generalPurposeAgent.ts` — the default agent definition shape

The key differences to adopt:
| | qlaybot today | Claude Code | Target |
|---|---|---|---|
| Required params | `role`, `task` | `description`, `prompt` | `description`, `prompt` |
| Subagent type | required, must exist in config.roles | optional, defaults to `general-purpose` | optional, defaults to `general-purpose` |
| Model | role-scoped | optional override | optional override |
| System prompt | always from role | inherited / agent-defined | inherited / agent-defined / optional override |
| Tool set | role-scoped | inherited / agent-defined | inherited / agent-defined |
| Error on unknown role | hard fail | falls back to default | fall back with warning |

- [ ] **Add a built-in `general-purpose` role definition** under `agent/src/subagent/built-in/generalPurposeRole.ts`. It should:
  - Inherit the parent's model (no override)
  - Inherit the parent's full tool set (MCP + built-in), minus `delegate` itself (no recursive delegation unless explicitly re-enabled)
  - Provide a neutral system prompt modeled on Claude Code's general-purpose agent ("you are a general-purpose agent … brief the parent with findings")
  - Set sensible default budgets: `maxTurns: 30`, `maxTokens: 100_000`

- [ ] **Update the delegate tool schema** (`agent/src/tools/delegate.ts:28–32`):

```ts
parameters: Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task" }),
  prompt: Type.String({ description: "The task for the subagent to perform. Brief it like a smart colleague who just walked in — it hasn't seen this conversation. Explain what you're trying to accomplish, what you've learned, and what specifically to do. Include file paths and line numbers." }),
  subagent_type: Type.Optional(Type.String({ description: "Specialized subagent role. Omit for general-purpose." })),
  model: Type.Optional(Type.String({ description: "Optional model override. Format: provider/model-id." })),
  // Keep legacy `role` + `task` names for backward compat — see migration note below
  role: Type.Optional(Type.String({ description: "(Deprecated) use subagent_type" })),
  task: Type.Optional(Type.String({ description: "(Deprecated) use prompt" })),
  context: Type.Optional(Type.String({ description: "Optional extra context" })),
}),
```

Inside `execute`:
1. Resolve `effectivePrompt = params.prompt ?? params.task` — error if both absent
2. Resolve `effectiveRole = params.subagent_type ?? params.role ?? "general-purpose"`
3. If `effectiveRole` is not in `config.roles` AND is not `"general-purpose"`, emit a warning and fall back to `"general-purpose"` (don't hard fail). Include the unknown role name in the warning.
4. If `params.model` is set, pass it through to `runner.run()` as a per-call override (requires adding `model?: string` to `runner.run()`'s opts).

- [ ] **Expose the parent's tool set to the general-purpose subagent.** This requires the `SubagentRunner.deps` to carry a reference to the parent's full tool inventory, not just MCP tools. Add:

```ts
// In SubagentRunnerDeps
parentTools?: () => AgentTool<any>[];  // Returns parent's tool set sans `delegate`
```

In `createSubagentTools`, when `roleConfig.roleName === "general-purpose"`, use `deps.parentTools?.() ?? []` instead of the role-scoped tool list.

- [ ] **Update the delegate tool description** to include the Claude Code writing-the-prompt guidance (abbreviated):

```
Delegate a task to a subagent. Brief it like a smart colleague who just walked in —
it hasn't seen this conversation. Explain what you're trying to accomplish, what
you've learned, and what specifically to do. Include file paths and line numbers.
Never delegate understanding — don't write "based on your findings, implement it".

- description: 3-5 word task summary
- prompt: the full briefing for the subagent
- subagent_type: (optional) role name; omit for general-purpose
- model: (optional) model override
```

- [ ] **Write tests** in `agent/tests/unit/test-delegate-redesign.ts`:
  1. `delegate({description, prompt})` with NO `subagent_type` resolves to `general-purpose` and succeeds
  2. `delegate({description, prompt, subagent_type: "designer"})` works when `designer` is configured
  3. `delegate({description, prompt, subagent_type: "nonexistent"})` falls back to `general-purpose` with a warning (NOT an error)
  4. `delegate({role: "designer", task: "..."})` (legacy params) still works, emits a deprecation note in the result
  5. `delegate({})` (neither prompt nor task) fails with a clear "missing required parameter" error

All 5 must pass.

- [ ] **Run full suite**: `npm run test:unit && npm run test:integration` — no regressions.

---

## Phase 4 — E2E verification

- [ ] **Write an E2E test** `agent/tests/e2e/test-delegate-e2e.ts` that:
  1. Launches an RPC qlaybot session
  2. Sends a prompt asking the agent to delegate a 1-step task to `general-purpose` (e.g., "Delegate to a subagent: read `README.md` and return the first line.")
  3. Asserts the delegation completes with a non-empty `findings` array (the first line of the README)
  4. Asserts `result.status === "completed"`

This is the smoke test that was silently broken — a delegate that returns with `status: "error", errorMessage: "startsWith"` should never ship again.

- [ ] **Manual reproduction** against the same instruction ml14 used (Hall bar design). Verify that the delegate call at transcript-entry-14's point now succeeds — pass the task, subagent runs, returns structured result.

- [ ] **Commit** with message `fix(agent/subagent): resolve model-resolution TypeError and simplify delegate API (issue #23)`. Include co-author trailer.

---

## Success criteria

1. `test-subagent-delegate-repro.ts`: pre-fix test demonstrates the bug; post-fix tests pass
2. `test-delegate-redesign.ts`: 5/5 passing
3. `test-delegate-e2e.ts`: passing against a real qlaybot RPC session
4. `npm run test:unit` + `npm run test:integration`: no regressions
5. Live ml14-style repro: delegate completes with non-empty findings

## Migration / compatibility

- Keep `role`/`task` params accepted for at least one release (deprecation window)
- `config.roles` is still honored — `general-purpose` is additive, not replacing roles
- The deprecation warning text should name the new parameter names so agents pick them up quickly

## Out of scope

- Multi-agent team coordination (Claude Code's `team_name`, `TeamCreate` — that's a much bigger scope)
- Worktree isolation (`isolation: "worktree"`)
- Background delegation (`run_in_background`)
- Shared prompt cache across parent and subagent

## References

- `agent/src/subagent/runner.ts:149–171` — model resolution (likely bug site)
- `agent/src/tools/delegate.ts:28–80` — current tool schema + execute
- `/Volumes/RandomData/harbour-workspace/qlaybot/ml14/qlaybot-transcripts/session_1776928889652-20260423-072129.jsonl` — failure transcript
- `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/AgentTool.tsx:82–102` — reference input schema (Appendix A.1)
- `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/prompt.ts:99–113` — writing-the-prompt guidance (Appendix A.3)
- `~/testFolder/claude_code/start-claude-code/src/tools/AgentTool/built-in/generalPurposeAgent.ts` — full general-purpose agent definition (Appendix A.2)
- Other built-ins for flavor: `built-in/exploreAgent.ts`, `built-in/verificationAgent.ts`, `built-in/planAgent.ts`

---

## Appendix A — Claude Code reference code (verbatim)

Inlined so the Executor does not need to re-navigate the reference codebase. Paths are authoritative — if you need more surrounding context, open them directly.

### A.1 — Input schema of the `Agent` tool (`AgentTool.tsx:82–102`)

```ts
// Base input schema without multi-agent parameters
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent to use for this task'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe("Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent."),
  run_in_background: z.boolean().optional().describe('Set to true to run this agent in the background. You will be notified when it completes.')
}));

// Full schema combining base + multi-agent params + isolation
const fullInputSchema = lazySchema(() => {
  const multiAgentInputSchema = z.object({
    name: z.string().optional().describe('Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.'),
    team_name: z.string().optional().describe('Team name for spawning. Uses current team context if omitted.'),
    mode: permissionModeSchema().optional().describe('Permission mode for spawned teammate (e.g., "plan" to require plan approval).')
  });
  return baseInputSchema().merge(multiAgentInputSchema).extend({
    isolation: z.enum(['worktree']).optional().describe('Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.'),
    cwd: z.string().optional().describe('Absolute path to run the agent in.')
  });
});
```

**What to borrow for qlaybot:** the base schema — `{description, prompt, subagent_type?, model?}`. Skip `run_in_background`, `name`, `team_name`, `mode`, `isolation`, `cwd` for v1 (out-of-scope per the main plan). `model` in qlaybot should be a free-form string (our provider prefix format), not the closed enum `['sonnet', 'opus', 'haiku']`.

### A.2 — The `general-purpose` agent definition (`built-in/generalPurposeAgent.ts`, full file)

```ts
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

const SHARED_PREFIX = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.`

const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

// Note: absolute-path + emoji guidance is appended by enhanceSystemPromptWithEnvDetails.
function getGeneralPurposeSystemPrompt(): string {
  return `${SHARED_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_GUIDELINES}`
}

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  // model is intentionally omitted - uses getDefaultSubagentModel().
  getSystemPrompt: getGeneralPurposeSystemPrompt,
}
```

**Adaptation for qlaybot** — create `agent/src/subagent/built-in/generalPurposeRole.ts` with the same shape, translated into our `RoleConfig` type:

```ts
import type { RoleConfig } from "../../types/v04-contracts.js";

const SYSTEM_PROMPT = `You are a subagent for qlaybot, the KLayout device-design agent. Given the task from your parent agent, use the tools available to complete it fully — don't gold-plate, but don't leave it half-done.

Your strengths:
- Searching code and layouts
- Analyzing multiple files to understand device-design flows
- Multi-step research or implementation
- Running MCP tools against KLayout when the task requires it

Guidelines:
- Start broad and narrow down. Use multiple search strategies when the first doesn't yield.
- NEVER create files unless necessary. Prefer editing.
- NEVER proactively create docs or README files.
- When done, respond with a concise report of what was done and key findings — the caller will relay to the user.`;

export const GENERAL_PURPOSE_ROLE: RoleConfig = {
  roleName: "general-purpose",
  systemPrompt: SYSTEM_PROMPT,
  tools: ["*"],              // inherits all parent tools sans `delegate`
  maxTurns: 30,
  maxTokens: 100_000,
  // model: undefined — inherits parent's default
};
```

Register it in `role-resolver.ts` as a fallback when the requested role is not in `config.roles`.

### A.3 — Writing-the-prompt guidance (`AgentTool/prompt.ts:99–113`)

```
## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
```

**Adaptation for qlaybot** — shorten and put in the delegate tool's description. Don't inline the full Claude Code text verbatim (too long for a tool description). Keep: "brief like a smart colleague who just walked in", "include file paths and line numbers", "never delegate understanding". Drop the Claude-Code-specific examples.

### A.4 — Example usage block (`prompt.ts:147–154`)

```
<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
{AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
```

Note how `prompt` carries the full briefing — the subagent doesn't see the parent's prior context. Qlaybot's `delegate` has the same property (each subagent gets a fresh `AgentSession` in `runner.ts:163–171`), so the same "brief like a smart colleague" rule applies.
