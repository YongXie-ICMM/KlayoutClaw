// CJS shim for vitest require() interop -- mirrors focus.ts
export function isInputActive(focusState) {
  return focusState === "input" || focusState === "completion";
}
