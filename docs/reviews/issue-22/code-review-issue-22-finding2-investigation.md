# Finding 2 Investigation — Activity-stream fallback aggressiveness

Date: 2026-04-23
Scope: `agent/src/thinking-only-guard.ts:170–172` — does the fallback
fire spuriously on legitimate no-output paths in `AgentSession.prompt()`?

## Codex's concern

The combined detector (`isThinkingOnlyTermination`) ends with:

```ts
if (isThinkingOnlyTerminationByMessages(session)) return true;
const a = tracker.current();
return !a.sawText && !a.sawToolCall;
```

Codex claim: `AgentSession.prompt()` has early-return paths that resolve
without appending any assistant event. If qlaybot hits one in `-m` / RPC
mode, the fallback triggers a spurious `Continue...` re-prompt.

## Evidence — reading `AgentSession.prompt`

Source: `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:496–608`.
Three early-return-without-assistant-event paths exist:

1. **Extension command** (line 500-505)
   ```js
   if (expandPromptTemplates && text.startsWith("/")) {
     const handled = await this._tryExecuteExtensionCommand(text);
     if (handled) return;
   }
   ```
   `_tryExecuteExtensionCommand` bails at the top (line 613-614) if
   `this._extensionRunner` is undefined.

2. **Input handler** (line 510-514)
   ```js
   if (this._extensionRunner?.hasHandlers("input")) {
     const inputResult = await this._extensionRunner.emitInput(...);
     if (inputResult.action === "handled") return;
   }
   ```
   Optional chain — unreachable when `_extensionRunner` is undefined.

3. **Already streaming** (line 527-538)
   ```js
   if (this.isStreaming) {
     if (!options?.streamingBehavior) {
       throw new Error("Agent is already processing. Specify streamingBehavior...");
     }
     ...
     return;
   }
   ```
   Throws if `streamingBehavior` is absent (which qlaybot never sets);
   the throw propagates into the `catch` in cli.ts / rpc.ts, so this is
   **not** a silent no-output path.

## Does qlaybot construct `_extensionRunner`?

`agent/src/agent.ts:397`:

```ts
const session = new AgentSession({
  agent,
  baseToolsOverride,
  customTools,
  resourceLoader,
  sessionManager,
  settingsManager,
  modelRegistry,
  initialActiveToolNames: activeToolNames,
  cwd,
});
```

No `extensionRunnerRef` / extensions are passed. Cross-checked with a
grep over `agent/src/` for `extensionRunner`, `emitInput`, `hasHandlers`,
`registerExtension`, `addExtension` — **zero matches**. Subagent runner
(`src/subagent/runner.ts:163`) also omits extensions.

Conclusion: `_extensionRunner` is **always undefined** in qlaybot's
supported modes. All three no-output paths are unreachable.

## Is slash-command routing a concern?

Codex's finding already answers this (per the review doc): qlaybot
routes slash commands via `parseCommand` + `commandRegistry.execute`
BEFORE `session.prompt()` is ever called (see `rpc.ts:248-263` and
`cli.ts:393-`). They do not reach `prompt()`.

## Decision

**Theoretical-only — no code change required.** The fallback cannot
spuriously fire in qlaybot because the three early-return paths all
require features qlaybot does not use.

**Action taken**: added a comment at `thinking-only-guard.ts:170–172`
documenting the gotcha for future callers who might wire up extensions
and hit a legitimate no-output path.

If a future qlaybot change adds extension support (input handlers,
extension commands, or concurrent `prompt()` via `streamingBehavior`),
the fallback logic must be revisited — likely by gating it on
"the call actually produced a terminal assistant message".

## Test coverage

The existing test at `tests/test-thinking-only.ts:494-499` (`"fallback
catches 'no terminal assistant + no activity'"`) codifies the intended
behavior: when there is no terminal assistant message AND no activity
was seen, the guard DOES retry. This is the documented contract.
