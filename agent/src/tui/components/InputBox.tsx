/**
 * InputBox — cursor-aware text editing with hooks, history, and tab completion.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
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
  /**
   * v0.4.3 Group 3: when true, the input is frozen (does not accept keystrokes
   * nor submit via Enter) but still renders the normal qlaybot> prompt. Used
   * when the plan-mode exit menu is open.
   */
  frozen?: boolean;
  onToggleThinking?: () => void;
  focusState?: FocusState;
  recency?: Record<string, number>;
}

/**
 * Cursor-aware synchronous shadow of the committed buffer.
 *
 * Why: `useInputBuffer` is a `useReducer`, so a single sync tick like
 * `stdin.write("ab"); stdin.write("\r")` fires two useInput callbacks before
 * React commits either reducer update. Enter then reads a stale `buf.value`
 * and submits "". We track the would-be-committed state (value + cursor) in
 * a ref that every keystroke path updates identically to `useInputBuffer`'s
 * reducer, so the Enter handler can submit using the effective state and
 * non-insert paths (arrow keys, backspace) also reflect intermediate edits
 * without resurrecting deleted text.
 *
 * A useEffect clears the ref once the React-committed state catches up.
 */
type PendingBuf = { value: string; cursor: number };

export function InputBox({
  phase = "ready",
  onSubmit,
  disabled = false,
  frozen = false,
  onToggleThinking,
  focusState = "input",
  recency = {},
}: InputBoxProps) {
  const buf = useInputBuffer();
  const pendingBufRef = useRef<PendingBuf | null>(null);
  // Read the effective buffer state: pending ref if ahead of React, else committed.
  const getEffective = useCallback((): PendingBuf => {
    return pendingBufRef.current ?? { value: buf.value, cursor: buf.cursor };
  }, [buf.value, buf.cursor]);

  useEffect(() => {
    // Drop the shadow once committed state matches what we tracked.
    const p = pendingBufRef.current;
    if (p && p.value === buf.value && p.cursor === buf.cursor) {
      pendingBufRef.current = null;
    }
  }, [buf.value, buf.cursor]);

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
        const { value: effVal } = getEffective();
        if (effVal.startsWith("/")) {
          if (tabCycleRef.current && completions.length > 1) {
            // Cycle through completions
            const next = (completionIdx + 1) % completions.length;
            setCompletionIdx(next);
            const newVal = completions[next].name + " ";
            pendingBufRef.current = { value: newVal, cursor: newVal.length };
            buf.setValue(newVal);
            return;
          }

          const matches = matchCommandsWithInfo(effVal.trimEnd());
          if (matches.length === 1) {
            const newVal = matches[0].name + " ";
            pendingBufRef.current = { value: newVal, cursor: newVal.length };
            buf.setValue(newVal);
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

      // Enter = submit using the effective (cursor-aware) buffer value.
      if (key.return) {
        const { value } = getEffective();
        const trimmed = value.trim();
        pendingBufRef.current = null;
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
        const { value } = getEffective();
        pendingBufRef.current = { value, cursor: 0 };
        buf.moveHome();
        return;
      }

      // Ctrl+E = end
      if (key.ctrl && input === "e") {
        const { value } = getEffective();
        pendingBufRef.current = { value, cursor: value.length };
        buf.moveEnd();
        return;
      }

      // Ctrl+D = delete forward
      if (key.ctrl && input === "d") {
        const { value, cursor } = getEffective();
        if (cursor < value.length) {
          const newValue = value.slice(0, cursor) + value.slice(cursor + 1);
          pendingBufRef.current = { value: newValue, cursor };
        }
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

      // Backspace / Delete — delete-before-cursor
      if (key.backspace || key.delete) {
        const { value, cursor } = getEffective();
        if (cursor > 0) {
          const newValue = value.slice(0, cursor - 1) + value.slice(cursor);
          pendingBufRef.current = { value: newValue, cursor: cursor - 1 };
        }
        buf.deleteBack();
        return;
      }

      // Arrow keys
      if (key.leftArrow) {
        const { value, cursor } = getEffective();
        pendingBufRef.current = { value, cursor: Math.max(0, cursor - 1) };
        buf.moveCursorLeft();
        return;
      }
      if (key.rightArrow) {
        const { value, cursor } = getEffective();
        pendingBufRef.current = {
          value,
          cursor: Math.min(value.length, cursor + 1),
        };
        buf.moveCursorRight();
        return;
      }

      // Up arrow = history
      if (key.upArrow) {
        const { value: effVal } = getEffective();
        const entry = history.navigateUp(effVal);
        if (entry != null) {
          pendingBufRef.current = { value: entry, cursor: entry.length };
          buf.setValue(entry);
        }
        return;
      }

      // Down arrow = history
      if (key.downArrow) {
        const entry = history.navigateDown();
        if (entry != null) {
          pendingBufRef.current = { value: entry, cursor: entry.length };
          buf.setValue(entry);
        }
        return;
      }

      // Regular character input — cursor-aware insert into the pending shadow
      // so a same-tick Enter submits the right value, and so mid-buffer
      // inserts do not resurrect as an appended suffix.
      if (!key.ctrl && !key.meta && input) {
        const { value, cursor } = getEffective();
        const newValue = value.slice(0, cursor) + input + value.slice(cursor);
        pendingBufRef.current = {
          value: newValue,
          cursor: cursor + input.length,
        };
        buf.insert(input);
      }
    },
    { isActive: isInputActive(focusState) && !isDisabled && !frozen },
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
