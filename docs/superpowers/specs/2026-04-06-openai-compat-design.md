# OpenAI-Compatible Provider Support for qlaybot

**Date:** 2026-04-06
**Status:** Approved

## Problem

qlaybot's `ProviderConfig.api` field is typed as `string` and the config loading already reads it from `model.json`, but `agent.ts` and `subagent/runner.ts` both hard-cast it to `"anthropic-messages"` before passing it to `ModelRegistry.registerProvider`. This means any non-Anthropic provider configured in `model.json` silently uses the wrong API protocol.

The pi-ai SDK natively supports `"openai-completions"` (and others) — the bug is purely in the cast.

## Goal

Allow qlaybot to connect to an OpenAI-compatible router (`https://bench.physcai.com/openai`) by:
1. Fixing the hard-cast so the `api` field from config is respected
2. Adding a `custom-openai` provider entry to `model.json`

## Changes

### 1. `agent/src/agent.ts` — line 126

Remove the hard-cast:
```ts
// Before
api: providerConfig.api as "anthropic-messages",

// After
api: providerConfig.api as Api,
```

Add import at top of file:
```ts
import type { Api } from "@mariozechner/pi-ai";
```

### 2. `agent/src/subagent/runner.ts` — same cast pattern

Same fix: replace `as "anthropic-messages"` with `as Api` and add the import.

### 3. `~/.qlaybot/config/model.json` — add provider

Add `custom-openai` alongside `custom-anthropic`:

```json
"custom-openai": {
  "baseUrl": "https://bench.physcai.com/openai",
  "apiKey": "cr_e0bc932144e2c96fe1a3f809b42d2899dcae0b5a32126edcc753909978559d3e",
  "api": "openai-completions",
  "models": [
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 500000,
      "maxTokens": 65536
    },
    {
      "id": "gpt-5.3-codex",
      "name": "GPT-5.3 Codex",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 500000,
      "maxTokens": 65536
    }
  ]
}
```

## Usage After Change

Switch to an OpenAI model at runtime:
```
/model set custom-openai/gpt-5.4
```

Or set as default in `model.json`:
```json
"defaultModel": "custom-openai/gpt-5.4"
```

## Out of Scope

- `/config set` support for provider `api` type (config is hand-edited)
- Auto-detection of API type from `baseUrl`
- Thinking/reasoning parameter mapping differences between providers

## Testing

- `npm run build` — verifies TypeScript compiles with `Api` type
- `npm test` — existing test suite should pass unchanged
- Manual: launch qlaybot, run `/model set custom-openai/gpt-5.4`, send a prompt
