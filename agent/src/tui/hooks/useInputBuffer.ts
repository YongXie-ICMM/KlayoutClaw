/**
 * Text editing buffer with cursor management.
 * Provides insert, delete, and cursor movement operations via useReducer.
 */

import { useReducer, useCallback } from "react";

interface InputBufferState {
  value: string;
  cursor: number;
}

type InputBufferAction =
  | { type: "INSERT"; char: string }
  | { type: "DELETE_BACK" }
  | { type: "DELETE_FORWARD" }
  | { type: "MOVE_LEFT" }
  | { type: "MOVE_RIGHT" }
  | { type: "MOVE_HOME" }
  | { type: "MOVE_END" }
  | { type: "CLEAR" }
  | { type: "SET_VALUE"; value: string };

function bufferReducer(
  state: InputBufferState,
  action: InputBufferAction,
): InputBufferState {
  switch (action.type) {
    case "INSERT": {
      const before = state.value.slice(0, state.cursor);
      const after = state.value.slice(state.cursor);
      return {
        value: before + action.char + after,
        cursor: state.cursor + action.char.length,
      };
    }
    case "DELETE_BACK": {
      if (state.cursor === 0) return state;
      const before = state.value.slice(0, state.cursor - 1);
      const after = state.value.slice(state.cursor);
      return { value: before + after, cursor: state.cursor - 1 };
    }
    case "DELETE_FORWARD": {
      if (state.cursor >= state.value.length) return state;
      const before = state.value.slice(0, state.cursor);
      const after = state.value.slice(state.cursor + 1);
      return { value: before + after, cursor: state.cursor };
    }
    case "MOVE_LEFT":
      return state.cursor > 0
        ? { ...state, cursor: state.cursor - 1 }
        : state;
    case "MOVE_RIGHT":
      return state.cursor < state.value.length
        ? { ...state, cursor: state.cursor + 1 }
        : state;
    case "MOVE_HOME":
      return { ...state, cursor: 0 };
    case "MOVE_END":
      return { ...state, cursor: state.value.length };
    case "CLEAR":
      return { value: "", cursor: 0 };
    case "SET_VALUE":
      return { value: action.value, cursor: action.value.length };
  }
}

const initialBufferState: InputBufferState = { value: "", cursor: 0 };

export function useInputBuffer() {
  const [state, dispatch] = useReducer(bufferReducer, initialBufferState);

  const insert = useCallback(
    (char: string) => dispatch({ type: "INSERT", char }),
    [],
  );
  const deleteBack = useCallback(() => dispatch({ type: "DELETE_BACK" }), []);
  const deleteForward = useCallback(
    () => dispatch({ type: "DELETE_FORWARD" }),
    [],
  );
  const moveCursorLeft = useCallback(
    () => dispatch({ type: "MOVE_LEFT" }),
    [],
  );
  const moveCursorRight = useCallback(
    () => dispatch({ type: "MOVE_RIGHT" }),
    [],
  );
  const moveHome = useCallback(() => dispatch({ type: "MOVE_HOME" }), []);
  const moveEnd = useCallback(() => dispatch({ type: "MOVE_END" }), []);
  const clear = useCallback(() => dispatch({ type: "CLEAR" }), []);
  const setValue = useCallback(
    (value: string) => dispatch({ type: "SET_VALUE", value }),
    [],
  );

  return {
    value: state.value,
    cursor: state.cursor,
    insert,
    deleteBack,
    deleteForward,
    moveCursorLeft,
    moveCursorRight,
    moveHome,
    moveEnd,
    clear,
    setValue,
  };
}

// Export reducer and types for testing
export { bufferReducer, initialBufferState };
export type { InputBufferState, InputBufferAction };
