# Changelog

## 0.4.3 — 2026-04-18

### Added
- **Plan Mode (major)** — qdevbot-parity sandbox-gated planning with disk-persisted plan files. Use the `enter_plan_mode` tool or `/plan` command. During plan mode, Bash and file writes outside the plan file are blocked; Read, `klayout_get_layout_info`, `screenshot`, `route_inspect`, and `memory_search` remain available.
- iTerm2 inline image rendering for base64 image blocks in tool results.
- 2000-char head+tail truncation for long tool-result entries in transcripts (disable via `--verbose`).
- `--verbose` CLI flag — disables truncation, prints system prompt banner, per-turn stats, and writes a full-fidelity project transcript to `<workspace>/qlaybot-transcripts/`.

### Fixed
- RPC `initialize` concurrency race — prior session cleanup + verbose subscription + promise-chain serialization for N concurrent calls.

## 0.4.2

Previous release.
