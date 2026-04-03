/**
 * InputBox — cursor-aware text editing with hooks, history, and tab completion.
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { Chalk } from "chalk";
import type { SessionPhase } from "../types.js";
import type { FocusState } from "../../types/v04-contracts.js";
import { useInputBuffer } from "../hooks/useInputBuffer.js";
import { useCommandHistory } from "../hooks/useCommandHistory.js";
import { matchCommands, matchCommandsWithInfo, SLASH_COMMANDS } from "../commands.js";
import type { CommandMatch } from "../commands.js";
import { CompletionList } from "./CompletionList.js";
import { getGhostSuffix } from "../ghost.js";
import { isInputActive } from "../focus.js";

// Force color output regardless of terminal detection
const chalk = new Chalk({ level: 3 });

interface InputBoxProps {
  phase?: SessionPhase;
  onSubmit: (text: string) => void;
  disabled?: boolean;
  onToggleThinking?: () => void;
  focusState?: FocusState;
  recency?: Record<string, number>;
}

export function InputBox({
  phase = "ready",
  onSubmit,
  disabled = false,
  onToggleThinking,
  focusState = "input",
  recency = {},
}: InputBoxProps) {
  const buf = useInputBuffer();
  const history = useCommandHistory();
  const [completions, setCompletions] = useState<CommandMatch[]>([]);
  const [completionIdx, setCompletionIdx] = useState(0);
  const tabCycleRef = useRef(false);

  const isDisabled = disabled || phase === "streaming" || phase === "tool_executing";

  const clearCompletions = useCallback(() => {
    setCompletions([]);
    setCompletionIdx(0);
    tabCycleRef.current = false;
  }, []);

  useInput(
    (input, key) => {
      if (isDisabled) return;

      // Tab completion
      if (key.tab) {
        const val = buf.value;
        if (val.startsWith("/")) {
          if (tabCycleRef.current && completions.length > 1) {
            // Cycle through completions
            const next = (completionIdx + 1) % completions.length;
            setCompletionIdx(next);
            buf.setValue(completions[next].name + " ");
            return;
          }

          const matches = matchCommandsWithInfo(val.trimEnd());
          if (matches.length === 1) {
            buf.setValue(matches[0].name + " ");
            clearCompletions();
          } else if (matches.length > 1) {
            setCompletions(matches);
            setCompletionIdx(0);
            tabCycleRef.current = true;
          }
        }
        return;
      }

      // Reset tab state on any non-tab input
      if (tabCycleRef.current) {
        clearCompletions();
      }

      // Enter = submit
      if (key.return) {
        const trimmed = buf.value.trim();
        if (trimmed) {
          history.push(trimmed);
          onSubmit(trimmed);
        }
        buf.clear();
        clearCompletions();
        return;
      }

      // Ctrl+A = home
      if (key.ctrl && input === "a") {
        buf.moveHome();
        return;
      }

      // Ctrl+E = end
      if (key.ctrl && input === "e") {
        buf.moveEnd();
        return;
      }

      // Ctrl+D = delete forward
      if (key.ctrl && input === "d") {
        buf.deleteForward();
        return;
      }

      // Ctrl+C = exit
      if (key.ctrl && input === "c") {
        process.exit(0);
        return;
      }

      // Ctrl+T = toggle thinking
      if (key.ctrl && input === "t") {
        onToggleThinking?.();
        return;
      }

      // Backspace / Delete
      if (key.backspace || key.delete) {
        buf.deleteBack();
        return;
      }

      // Arrow keys
      if (key.leftArrow) {
        buf.moveCursorLeft();
        return;
      }
      if (key.rightArrow) {
        buf.moveCursorRight();
        return;
      }

      // Up arrow = history
      if (key.upArrow) {
        const entry = history.navigateUp(buf.value);
        if (entry != null) {
          buf.setValue(entry);
        }
        return;
      }

      // Down arrow = history
      if (key.downArrow) {
        const entry = history.navigateDown();
        if (entry != null) {
          buf.setValue(entry);
        }
        return;
      }

      // Regular character input
      if (!key.ctrl && !key.meta && input) {
        buf.insert(input);
      }
    },
    { isActive: isInputActive(focusState) && !isDisabled },
  );

  // Disabled state
  if (isDisabled) {
    return (
      <Box borderStyle="single" paddingX={1}>
        <Text color="gray">...</Text>
      </Box>
    );
  }

  // Render cursor-aware text
  const before = buf.value.slice(0, buf.cursor);
  const cursorChar = buf.cursor < buf.value.length ? buf.value[buf.cursor] : " ";
  const after = buf.value.slice(buf.cursor + 1);

  const isEmpty = buf.value.length === 0;

  // Ghost text (inline completion hint for slash commands)
  const slashCommands = SLASH_COMMANDS.map((c) => `/${c.name}`);
  const ghostSuffix = getGhostSuffix(buf.value, slashCommands, recency);

  return (
    <Box flexDirection="column">
      {completions.length > 1 && (
        <CompletionList matches={completions} selectedIndex={completionIdx} />
      )}
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan">qlaybot&gt; </Text>
        <Text>
          {before}
          {chalk.inverse(cursorChar)}
          {after}
          {ghostSuffix ? chalk.gray(ghostSuffix) : ""}
        </Text>
        {isEmpty && <Text color="gray"> Type a message or /command</Text>}
      </Box>
    </Box>
  );
}
