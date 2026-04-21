/**
 * Color theme for qlaybot TUI.
 * Chalk-based color functions for consistent terminal styling.
 */

import { Chalk } from "chalk";

// Force color output regardless of terminal detection (needed for tests)
const c = new Chalk({ level: 3 });

export const theme = {
  // Primary colors
  primary: c.blue,
  primaryBold: c.blue.bold,

  // Text
  text: c.white,
  textDim: c.dim,
  textBold: c.bold,

  // User messages
  userPrefix: c.cyan.bold,
  userText: c.cyan,

  // Assistant
  assistantBorder: c.blue,
  assistantText: c.white,

  // Thinking
  thinking: c.dim.italic,
  thinkingBorder: c.gray,
  // v0.4.4 §3 / TH-6 / TH-9 — distinct color for `source:"tool"` markers.
  // Any distinct chalk function satisfies the "raw frames differ" test
  // in test-components.ts; we pick dim-italic-cyan to visually separate
  // tool-scratchpad from native reasoning while keeping the same dim/italic
  // weight so the two read as a matched pair.
  thinkingTool: c.dim.italic.cyan,

  // Tools
  toolRunning: c.yellow,
  toolSuccess: c.green,
  toolError: c.red,
  toolName: c.yellow.bold,
  toolArgs: c.dim,
  toolDuration: c.dim,

  // Status
  statusModel: c.blue.bold,
  statusPhase: c.dim,
  statusReady: c.green,
  statusActive: c.yellow,
  statusThinking: c.magenta,

  // Errors
  error: c.red.bold,
  errorText: c.red,

  // Input
  prompt: c.green.bold,

  // Misc
  separator: c.dim,
  muted: c.gray,
} as const;
