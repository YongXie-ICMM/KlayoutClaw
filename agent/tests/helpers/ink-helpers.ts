/**
 * Shared ink test utilities for v0.4 TUI tests.
 */

// Strip ANSI escape codes from a string
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// Named key → escape sequence mapping
const KEY_MAP: Record<string, string> = {
  "ctrl-a": "\x01",
  "ctrl-b": "\x02",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-e": "\x05",
  "ctrl-g": "\x07",
  "ctrl-n": "\x0e",
  "ctrl-s": "\x13",
  "ctrl-t": "\x14",
  "ctrl-w": "\x17",
  tab: "\t",
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  delete: "\x1b[3~",
};

export function pressKey(
  stdin: { write: (data: string) => void },
  key: string,
): void {
  const seq = KEY_MAP[key.toLowerCase()];
  if (!seq) {
    throw new Error(
      `Unknown key "${key}". Available: ${Object.keys(KEY_MAP).join(", ")}`,
    );
  }
  stdin.write(seq);
}

export async function waitForFrame(
  _render: { frames: string[] },
  ms = 50,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render a component with a useReducer-style state machine.
 * Returns the render result with frames and stdin.
 *
 * Usage: callers should use ink-testing-library's render() directly
 * with their component. This is a convenience wrapper.
 */
export function renderWithReducer<S, A>(
  Component: React.ComponentType<{ state: S; dispatch: (a: A) => void }>,
  initialState: S,
): {
  frames: string[];
  stdin: { write: (data: string) => void };
  dispatch: (action: A) => void;
} {
  // Lazy import to avoid pulling in ink at module level
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { render } = require("ink-testing-library");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");

  let currentState = initialState;
  let rerender: (node: React.ReactElement) => void;

  const dispatch = (action: A) => {
    // callers must provide their own reducer; this just re-renders
    void action;
    void currentState;
  };

  const result = render(
    React.createElement(Component, { state: initialState, dispatch }),
  );
  rerender = result.rerender;

  return {
    frames: result.frames,
    stdin: result.stdin,
    dispatch: (action: A) => {
      dispatch(action);
      // Re-render with same state — callers should integrate their own reducer
      rerender(
        React.createElement(Component, { state: currentState, dispatch }),
      );
    },
  };
}
