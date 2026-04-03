/**
 * v0.4 Phase C1: ConfigPanel Settings + Models Tabs
 *
 * Test-Reinforced Development -- Overseer test suite.
 * All tests call real implementation functions that the Executor must create.
 * Every test should FAIL until the implementation is complete.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

// --- Contract types ---
import type {
  ConfigPanelTab,
  ConfigPanelState,
  CommandResultStateChange,
} from "../src/types/v04-contracts.js";

// --- Test helpers ---
import {
  makeConfig,
  makeTmpDir,
  writeConfigFiles,
} from "./helpers/config-builder.js";
import { stripAnsi, pressKey, waitForFrame } from "./helpers/ink-helpers.js";

// --- Implementation imports ---
import { tuiReducer, initialState } from "../src/tui/reducer.js";
import type { TUIState, TUIAction } from "../src/tui/types.js";
import {
  loadConfig,
  saveModelConfig,
  saveSettingsConfig,
} from "../src/config.js";
import { configCommand } from "../src/commands/config.js";
import { modelCommand } from "../src/commands/model.js";
import { mcpCommand } from "../src/commands/mcp.js";
import type { CommandContext } from "../src/commands/index.js";

// ConfigPanel component (Executor must create this)
import React from "react";
import { render } from "ink-testing-library";

// Lazy import to handle module not existing yet — test will fail at import time
// which is the expected behavior for TRD.
let ConfigPanel: React.ComponentType<{
  config: ReturnType<typeof makeConfig>;
  configPanelState: ConfigPanelState;
  dispatch: (action: TUIAction) => void;
  configDir?: string;
}>;

try {
  // Dynamic import won't work in vitest top-level; use require for sync load
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../src/tui/components/ConfigPanel.js");
  ConfigPanel = mod.ConfigPanel ?? mod.default;
} catch {
  // Will fail at test time — expected for TRD
  ConfigPanel = undefined as unknown as typeof ConfigPanel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default ConfigPanelState for tests */
function defaultPanelState(overrides?: Partial<ConfigPanelState>): ConfigPanelState {
  return {
    open: true,
    tab: "settings",
    editing: false,
    editValue: "",
    cursors: { settings: 0, models: 0, mcp: 0 },
    mcpDrilldown: { level: "servers", selectedServer: null, toolIndex: 0 },
    ...overrides,
  };
}

/** Build a mock CommandContext with a config */
function mockCommandContext(overrides?: Partial<ReturnType<typeof makeConfig>>): CommandContext {
  const config = makeConfig(overrides);
  return {
    session: { config } as unknown as CommandContext["session"],
    mode: "tui",
  };
}

/**
 * Dispatch a sequence of actions through the reducer, returning final state.
 */
function reduceActions(actions: TUIAction[], startState?: TUIState): TUIState {
  let state = startState ?? initialState;
  for (const action of actions) {
    state = tuiReducer(state, action);
  }
  return state;
}

// ==========================================================================
// 1. Reducer State: CONFIG_PANEL actions (SCC-C14a, SCC-C14b)
// ==========================================================================

describe("SCC-C14a: Reducer CONFIG_PANEL_OPEN/CLOSE/TAB_CHANGE/NAVIGATE/SELECT", () => {
  it("CONFIG_PANEL_OPEN sets configPanel.open=true and focusState='config-panel'", () => {
    const state = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    expect(state.focusState).toBe("config-panel");
    expect((state as TUIState & { configPanel: ConfigPanelState }).configPanel.open).toBe(true);
    expect((state as TUIState & { configPanel: ConfigPanelState }).configPanel.tab).toBe("settings");
  });

  it("CONFIG_PANEL_CLOSE sets configPanel.open=false and focusState='input'", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    const closed = tuiReducer(opened, {
      type: "CONFIG_PANEL_CLOSE",
    } as TUIAction);

    expect(closed.focusState).toBe("input");
    expect((closed as TUIState & { configPanel: ConfigPanelState }).configPanel.open).toBe(false);
  });

  it("CONFIG_PANEL_TAB_CHANGE switches active tab", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    const switched = tuiReducer(opened, {
      type: "CONFIG_PANEL_TAB_CHANGE",
      tab: "models",
    } as TUIAction);

    expect((switched as TUIState & { configPanel: ConfigPanelState }).configPanel.tab).toBe("models");
  });

  it("CONFIG_PANEL_NAVIGATE increments/decrements cursor for active tab", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    const down1 = tuiReducer(opened, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "down",
    } as TUIAction);

    const panelState = (down1 as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panelState.cursors.settings).toBe(1);

    const down2 = tuiReducer(down1, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "down",
    } as TUIAction);

    expect((down2 as TUIState & { configPanel: ConfigPanelState }).configPanel.cursors.settings).toBe(2);

    const up1 = tuiReducer(down2, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "up",
    } as TUIAction);

    expect((up1 as TUIState & { configPanel: ConfigPanelState }).configPanel.cursors.settings).toBe(1);
  });

  it("CONFIG_PANEL_SELECT dispatches selection for current tab item", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    // SELECT in settings tab should trigger edit mode start (or be handled by component)
    const selected = tuiReducer(opened, {
      type: "CONFIG_PANEL_SELECT",
    } as TUIAction);

    // After SELECT in settings tab, editing should begin
    const panel = (selected as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.editing).toBe(true);
  });
});

describe("SCC-C14b: Reducer CONFIG_PANEL_EDIT_START/EDIT_CONFIRM/EDIT_CANCEL", () => {
  it("EDIT_START enters edit mode with current value", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    const editing = tuiReducer(opened, {
      type: "CONFIG_PANEL_EDIT_START",
      currentValue: "high",
    } as TUIAction);

    const panel = (editing as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.editing).toBe(true);
    expect(panel.editValue).toBe("high");
  });

  it("EDIT_CANCEL exits edit mode without changing value", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    const editing = tuiReducer(opened, {
      type: "CONFIG_PANEL_EDIT_START",
      currentValue: "high",
    } as TUIAction);

    const cancelled = tuiReducer(editing, {
      type: "CONFIG_PANEL_EDIT_CANCEL",
    } as TUIAction);

    const panel = (cancelled as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.editing).toBe(false);
    expect(panel.editValue).toBe("");
  });

  it("EDIT_CONFIRM exits edit mode with new value", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    const editing = tuiReducer(opened, {
      type: "CONFIG_PANEL_EDIT_START",
      currentValue: "high",
    } as TUIAction);

    const confirmed = tuiReducer(editing, {
      type: "CONFIG_PANEL_EDIT_CONFIRM",
      newValue: "low",
    } as TUIAction);

    const panel = (confirmed as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.editing).toBe(false);
  });
});

// ==========================================================================
// 2. Reducer: Per-tab cursor memory (SCC-C14d)
// ==========================================================================

describe("SCC-C14d: configPanelCursors per-tab cursor memory", () => {
  it("cursor position restored when switching tabs and back (SCC-C27)", () => {
    // Open settings, navigate to item 3
    let state = reduceActions([
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
      { type: "CONFIG_PANEL_NAVIGATE", direction: "down" } as TUIAction,
      { type: "CONFIG_PANEL_NAVIGATE", direction: "down" } as TUIAction,
      { type: "CONFIG_PANEL_NAVIGATE", direction: "down" } as TUIAction,
    ]);

    const panel1 = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel1.cursors.settings).toBe(3);

    // Switch to models tab
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_TAB_CHANGE",
      tab: "models",
    } as TUIAction);

    const panel2 = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel2.tab).toBe("models");
    expect(panel2.cursors.models).toBe(0); // models tab starts at 0

    // Switch back to settings — cursor should still be at 3
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_TAB_CHANGE",
      tab: "settings",
    } as TUIAction);

    const panel3 = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel3.cursors.settings).toBe(3);
  });
});

// ==========================================================================
// 3. Reducer: Ctrl+N keyboard shortcut (SCC-C14e)
// ==========================================================================

describe("SCC-C14e: Ctrl+N opens ConfigPanel", () => {
  it("CONFIG_PANEL_OPEN action sets focusState and opens panel", () => {
    // The reducer must handle CONFIG_PANEL_OPEN to set up the state.
    const state = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    expect(state.focusState).toBe("config-panel");
    expect((state as TUIState & { configPanel: ConfigPanelState }).configPanel.open).toBe(true);
  });

  it("reducer opens configPanel when CONFIG_PANEL_OPEN dispatched from input state", () => {
    // Ctrl+N binding lives in App.tsx (global shortcuts), not ConfigPanel.
    // ConfigPanel is already open, so it does not need to handle Ctrl+N.
    // Here we verify the reducer correctly transitions from input -> config-panel.
    const state = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    expect(state.focusState).toBe("config-panel");
    const panel = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.open).toBe(true);
    expect(panel.tab).toBe("settings");

    // Verify that input is NOT active when config-panel is focused
    // (this is the invariant that App.tsx relies on to route Ctrl+N correctly)
    const { isInputActive } = require("../src/tui/focus.js");
    expect(isInputActive(state.focusState)).toBe(false);
  });
});

// ==========================================================================
// 4. Commands: /config bare and /model bare (SCC-C15, SCC-C16)
// ==========================================================================

describe("SCC-C15: /config (bare) opens ConfigPanel Settings tab", () => {
  it("returns stateChange.configPanel = { open: true, tab: 'settings' }", async () => {
    const context = mockCommandContext();

    // Bare /config with no args should open the config panel
    const result = await configCommand.execute([], context);

    expect(result.stateChange).toBeDefined();
    expect(result.stateChange!.configPanel).toBeDefined();
    expect(result.stateChange!.configPanel!.open).toBe(true);
    expect(result.stateChange!.configPanel!.tab).toBe("settings");
  });
});

describe("SCC-C16: /model (bare) opens ConfigPanel Models tab", () => {
  it("returns stateChange.configPanel = { open: true, tab: 'models' }", async () => {
    const context = mockCommandContext();

    // Bare /model with no args should open the config panel on models tab
    const result = await modelCommand.execute([], context);

    expect(result.stateChange).toBeDefined();
    expect(result.stateChange!.configPanel).toBeDefined();
    expect(result.stateChange!.configPanel!.open).toBe(true);
    expect(result.stateChange!.configPanel!.tab).toBe("models");
  });
});

// ==========================================================================
// 5. ConfigPanel Component: Structure + Tab Navigation (SCC-C1, SCC-C2)
// ==========================================================================

describe("SCC-C1: ConfigPanel renders 3 tabs with active tab bracketed", () => {
  it("renders [Settings] Models MCP when settings tab is active", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings" });
    const dispatch = vi.fn();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("[Settings]");
    expect(frame).toContain("Models");
    expect(frame).toContain("MCP");
    // Inactive tabs should NOT be bracketed
    expect(frame).not.toContain("[Models]");
    expect(frame).not.toContain("[MCP]");
  });

  it("renders Settings [Models] MCP when models tab is active", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "models" });
    const dispatch = vi.fn();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("[Models]");
    expect(frame).not.toContain("[Settings]");
  });
});

describe("SCC-C2: Left/Right arrows switch active tab", () => {
  it("Right arrow from Settings switches to Models tab", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings" });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "right");

    // ConfigPanel should dispatch CONFIG_PANEL_TAB_CHANGE with tab: "models"
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONFIG_PANEL_TAB_CHANGE",
        tab: "models",
      }),
    );
  });

  it("Left arrow from Models switches to Settings tab", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "models" });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "left");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONFIG_PANEL_TAB_CHANGE",
        tab: "settings",
      }),
    );
  });
});

// ==========================================================================
// 6. Settings Tab: SETTABLE_KEYS list + inline edit (SCC-C3, C4, C5, C6)
// ==========================================================================

describe("SCC-C3: Settings tab lists SETTABLE_KEYS with current values", () => {
  it("displays all settable keys and their current config values", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings" });
    const dispatch = vi.fn();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    const frame = stripAnsi(lastFrame()!);
    // Must show all SETTABLE_KEYS
    expect(frame).toContain("thinking");
    expect(frame).toContain("model");
    expect(frame).toContain("memory.maxResults");
    expect(frame).toContain("memory.maxEntries");
    // Must show current values
    expect(frame).toContain("high"); // thinkingLevel
    expect(frame).toMatch(/memory\.maxResults\s+3/); // maxResults value tied to key
  });
});

describe("SCC-C4: Enter on a Settings key enters edit mode", () => {
  it("dispatches CONFIG_PANEL_EDIT_START when Enter pressed on a key", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings", cursors: { settings: 0, models: 0, mcp: 0 } });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "enter");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONFIG_PANEL_EDIT_START",
      }),
    );
  });
});

describe("SCC-C5: Escape in edit mode cancels edit (value unchanged)", () => {
  it("dispatches CONFIG_PANEL_EDIT_CANCEL on Escape during edit", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({
      tab: "settings",
      editing: true,
      editValue: "high",
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "escape");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONFIG_PANEL_EDIT_CANCEL" }),
    );
  });
});

describe("SCC-C6: Enter in edit mode saves value (calls saveSettingsConfig)", () => {
  it("dispatches CONFIG_PANEL_EDIT_CONFIRM on Enter during edit", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({
      tab: "settings",
      editing: true,
      editValue: "low",
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "enter");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONFIG_PANEL_EDIT_CONFIRM" }),
    );
  });

  it("persists the edited value to disk after confirm", () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    // Edit thinking level (cursor 0) from "high" to "low"
    const panelState = defaultPanelState({
      tab: "settings",
      editing: true,
      editValue: "low",
      cursors: { settings: 0, models: 0, mcp: 0 },
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config,
        configPanelState: panelState,
        dispatch,
        configDir,
      }),
    );

    // Confirm the edit
    pressKey(stdin, "enter");

    // Read the file to verify persistence (not just dispatch)
    const modelJson = JSON.parse(readFileSync(join(configDir, "model.json"), "utf-8"));
    expect(modelJson.thinkingLevel).toBe("low");
  });
});

// ==========================================================================
// 7. Models Tab: Provider grouping + context/cost display (SCC-C7, C8, C9)
// ==========================================================================

describe("SCC-C7: Models tab groups models by provider with headers", () => {
  it("renders provider name as header above its models", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "models" });
    const dispatch = vi.fn();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    const frame = stripAnsi(lastFrame()!);
    // Provider header
    expect(frame).toContain("custom-anthropic");
    // Model names should appear under it
    expect(frame).toContain("Claude Sonnet 4.6");
  });
});

describe("SCC-C8: Models tab shows context window and cost per model", () => {
  it("displays context window and input/output cost for each model", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "models" });
    const dispatch = vi.fn();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    const frame = stripAnsi(lastFrame()!);
    // Context window: 200k or 200K
    expect(frame).toMatch(/200[kK]/);
    // Cost info: input/output cost pair $3/$15 or 3/15
    expect(frame).toContain("3/$15");
  });
});

describe("SCC-C9: Enter on a model sets it as default", () => {
  it("dispatches CONFIG_PANEL_SELECT and updates model.json", () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    const panelState = defaultPanelState({
      tab: "models",
      cursors: { settings: 0, models: 0, mcp: 0 },
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config,
        configPanelState: panelState,
        dispatch,
        configDir,
      }),
    );

    // Press Enter to select the first model
    pressKey(stdin, "enter");

    // Must dispatch CONFIG_PANEL_SELECT specifically (not EDIT_CONFIRM, which is for settings)
    expect(dispatch).toHaveBeenCalled();
    const calls = dispatch.mock.calls.flat();
    const selectActions = calls.filter(
      (a: TUIAction) => a.type === "CONFIG_PANEL_SELECT",
    );
    expect(selectActions.length).toBeGreaterThan(0);

    // Verify model.json was updated with the selected model's full reference
    const modelJson = JSON.parse(readFileSync(join(configDir, "model.json"), "utf-8"));
    // The first model in "custom-anthropic" is "claude-sonnet-4-6",
    // so defaultModel should be "custom-anthropic/claude-sonnet-4-6"
    expect(modelJson.defaultModel).toBe("custom-anthropic/claude-sonnet-4-6");
  });
});

// ==========================================================================
// 8. Cross-layer: Settings edit persists to disk (SCC-C21)
// ==========================================================================

describe("SCC-C21: ConfigPanel Settings edit -> Enter -> value persisted to disk", () => {
  it("edit confirm writes updated setting to settings.json", () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    const panelState = defaultPanelState({
      tab: "settings",
      editing: true,
      editValue: "medium",
      cursors: { settings: 0, models: 0, mcp: 0 }, // cursor on 'thinking'
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config,
        configPanelState: panelState,
        dispatch,
        configDir,
      }),
    );

    // Confirm the edit
    pressKey(stdin, "enter");

    // Verify dispatch was called
    expect(dispatch).toHaveBeenCalled();

    // The component (or its effect) should persist the value.
    // Read model.json to check if thinkingLevel was updated (thinking key -> model.json)
    const modelJson = JSON.parse(readFileSync(join(configDir, "model.json"), "utf-8"));
    // After edit confirm, thinkingLevel should be persisted as "medium"
    // (cursor 0 = thinking key, editValue = "medium")
    expect(modelJson.thinkingLevel).toBe("medium");
  });
});

// ==========================================================================
// 9. Cross-layer: Models tab -> Enter -> model.json updated (SCC-C22)
// ==========================================================================

describe("SCC-C22: ConfigPanel Models tab -> Enter on model -> model.json updated", () => {
  it("selecting a different model persists defaultModel to model.json", () => {
    const tmpDir = makeTmpDir();
    // makeConfig() only has 1 model (claude-sonnet-4-6). Add a second model
    // so cursor index 1 selects a genuinely different model.
    const config = makeConfig({
      models: {
        providers: {
          "custom-anthropic": {
            baseUrl: "https://bench.physcai.com/api",
            apiKey: "test-key",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                contextWindow: 200000,
                maxTokens: 65536,
              },
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
                contextWindow: 200000,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    } as Partial<ReturnType<typeof makeConfig>>);
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    // Cursor 1 = claude-opus-4-6 (the second model)
    const panelState = defaultPanelState({
      tab: "models",
      cursors: { settings: 0, models: 1, mcp: 0 },
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config,
        configPanelState: panelState,
        dispatch,
        configDir,
      }),
    );

    pressKey(stdin, "enter");

    // The component should persist the selected model to model.json
    const modelJson = JSON.parse(readFileSync(join(configDir, "model.json"), "utf-8"));
    // Cursor 1 selects claude-opus-4-6 under custom-anthropic provider
    expect(modelJson.defaultModel).toBe("custom-anthropic/claude-opus-4-6");
  });
});

// ==========================================================================
// 10. Focus Exclusivity (SCC-C28, SCC-C29, SCC-C30)
// ==========================================================================

describe("SCC-C28: Enter in Models tab selects model, does NOT send InputBox message", () => {
  it("focusState=config-panel means Enter is consumed by ConfigPanel only", () => {
    // When focusState is "config-panel", the InputBox should NOT process Enter
    const state = reduceActions([
      { type: "CONFIG_PANEL_OPEN", tab: "models" } as TUIAction,
    ]);

    expect(state.focusState).toBe("config-panel");
    expect(state.focusState).not.toBe("input");
  });

  it("Enter in Models tab dispatches CONFIG_PANEL_SELECT, not USER_PROMPT", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "models" });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "enter");

    // Verify NO USER_PROMPT action was dispatched
    const userPromptActions = dispatch.mock.calls
      .flat()
      .filter((a: TUIAction) => a.type === "USER_PROMPT");
    expect(userPromptActions.length).toBe(0);

    // Verify CONFIG_PANEL_SELECT (or similar model-selection action) WAS dispatched
    const selectActions = dispatch.mock.calls
      .flat()
      .filter((a: TUIAction) => a.type === "CONFIG_PANEL_SELECT");
    expect(selectActions.length).toBeGreaterThan(0);
  });
});

describe("SCC-C29: Up/Down in ConfigPanel navigates panel, not InputBox history", () => {
  it("focusState=config-panel means Up/Down dispatches CONFIG_PANEL_NAVIGATE", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings" });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "down");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONFIG_PANEL_NAVIGATE",
        direction: "down",
      }),
    );
  });

  it("Up arrow dispatches CONFIG_PANEL_NAVIGATE direction=up", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings", cursors: { settings: 2, models: 0, mcp: 0 } });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "up");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONFIG_PANEL_NAVIGATE",
        direction: "up",
      }),
    );
  });
});

describe("SCC-C30: Escape from ConfigPanel returns focus to InputBox", () => {
  it("Escape dispatches CONFIG_PANEL_CLOSE (not FOCUS_ESCAPE for agent abort)", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "settings", editing: false });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    pressKey(stdin, "escape");

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONFIG_PANEL_CLOSE" }),
    );
  });

  it("reducer transitions focusState back to input on CONFIG_PANEL_CLOSE", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    expect(opened.focusState).toBe("config-panel");

    const closed = tuiReducer(opened, {
      type: "CONFIG_PANEL_CLOSE",
    } as TUIAction);

    expect(closed.focusState).toBe("input");
  });
});

// ==========================================================================
// 11. Edge Cases (SCC-C33, SCC-C34, SCC-C35)
// ==========================================================================

describe("SCC-C33: Reject invalid value for settable key from ConfigPanel Settings", () => {
  it("EDIT_CONFIRM with invalid thinking level is rejected (value not persisted)", () => {
    // SETTABLE_KEYS has 4 entries: thinking, model, memory.maxResults, memory.maxEntries.
    // "thinking" (cursor 0) only accepts: off, minimal, low, medium, high, xhigh.
    // An invalid value like "invalid_thinking_level" must be rejected.
    const config = makeConfig();
    const tmpDir = makeTmpDir();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    // Cursor 0 = "thinking" key, editValue is an invalid thinking level
    const panelState = defaultPanelState({
      tab: "settings",
      editing: true,
      editValue: "invalid_thinking_level",
      cursors: { settings: 0, models: 0, mcp: 0 },
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config,
        configPanelState: panelState,
        dispatch,
        configDir,
      }),
    );

    pressKey(stdin, "enter");

    // The model.json should NOT contain "invalid_thinking_level".
    // The original thinkingLevel ("high") must be preserved.
    const modelJson = JSON.parse(readFileSync(join(configDir, "model.json"), "utf-8"));
    expect(modelJson.thinkingLevel).not.toBe("invalid_thinking_level");
    expect(modelJson.thinkingLevel).toBe("high");
  });
});

describe("SCC-C34: Space details in Models tab is read-only", () => {
  it("space key does not change model selection, only Enter does", () => {
    const config = makeConfig();
    const panelState = defaultPanelState({ tab: "models" });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, { config, configPanelState: panelState, dispatch }),
    );

    // Press space — should NOT dispatch a model selection
    stdin.write(" ");

    const selectActions = dispatch.mock.calls
      .flat()
      .filter((a: TUIAction) => a.type === "CONFIG_PANEL_SELECT");
    expect(selectActions.length).toBe(0);
  });
});

describe("SCC-C35: Invalid numeric setting rejected", () => {
  it("EDIT_CONFIRM with non-numeric value for numeric field is rejected", () => {
    const config = makeConfig();
    const tmpDir = makeTmpDir();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    // Simulate editing memory.maxResults (a numeric field) with non-numeric value
    // Cursor at index 2 = memory.maxResults (order: thinking=0, model=1, memory.maxResults=2)
    const panelState = defaultPanelState({
      tab: "settings",
      editing: true,
      editValue: "not_a_number",
      cursors: { settings: 2, models: 0, mcp: 0 },
    });
    const dispatch = vi.fn();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config,
        configPanelState: panelState,
        dispatch,
        configDir,
      }),
    );

    pressKey(stdin, "enter");

    // The numeric setting should NOT have been updated to "not_a_number"
    const settingsJson = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf-8"));
    expect(settingsJson.memory?.autoRecall?.maxResults).not.toBe("not_a_number");
    // Original value should be preserved
    expect(settingsJson.memory?.autoRecall?.maxResults).toBe(3);
  });
});

// ==========================================================================
// 12. State Lifecycle (SCC-C41, SCC-C42)
// ==========================================================================

describe("SCC-C41: Focus stays on ConfigPanel when agent turn ends", () => {
  it("AGENT_END does not close ConfigPanel or change focusState from config-panel", () => {
    let state = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    expect(state.focusState).toBe("config-panel");

    // Simulate agent turn ending
    state = tuiReducer(state, { type: "AGENT_END" });

    // ConfigPanel should remain open and focused
    expect(state.focusState).toBe("config-panel");
    expect((state as TUIState & { configPanel: ConfigPanelState }).configPanel.open).toBe(true);
  });
});

describe("SCC-C42: /compact blocked while ConfigPanel open", () => {
  it("COMPACTION_START is not dispatched when configPanel is open (reducer gate)", () => {
    // Open config panel, then attempt compaction.
    // The TUI's handleSubmit must gate /compact on configPanel.open.
    // We verify the reducer state provides the blocking signal.
    const state = reduceActions([
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
    ]);

    // The state should indicate configPanel is open
    const panel = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.open).toBe(true);
    expect(state.focusState).toBe("config-panel");

    // Now verify that dispatching COMPACTION_START while configPanel is open
    // does NOT actually start compaction (reducer should reject it)
    const afterCompact = tuiReducer(state, { type: "COMPACTION_START" });

    // Either the reducer blocks COMPACTION_START when configPanel.open is true
    // (isCompacting stays false), OR if it doesn't gate it, the focusState
    // must remain "config-panel" (not switch to input).
    // The critical invariant: focusState must stay "config-panel" — the TUI
    // should not allow compaction to proceed while panel is open.
    expect(afterCompact.focusState).toBe("config-panel");
    const afterPanel = (afterCompact as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(afterPanel.open).toBe(true);
    expect(afterCompact.isCompacting).toBe(false);
  });

  it("config-panel focus blocks input submission (isInputActive gate)", async () => {
    // The TUI gates /compact (and all input) through handleSubmit, which
    // checks isInputActive(focusState). When configPanel is open,
    // focusState is "config-panel", so handleSubmit never fires.
    // This test verifies the reducer + focus invariants that enforce this.
    const state = reduceActions([
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
    ]);

    // focusState must NOT be "input" when configPanel is open
    expect(state.focusState).toBe("config-panel");
    expect(state.focusState).not.toBe("input");

    // isInputActive must return false — this is the gate that blocks /compact
    const { isInputActive } = await import("../src/tui/focus.js");
    expect(isInputActive(state.focusState)).toBe(false);

    // isCompacting must remain false after COMPACTION_START while panel is open
    const afterCompact = tuiReducer(state, { type: "COMPACTION_START" });
    expect(afterCompact.isCompacting).toBeFalsy();
    expect(afterCompact.focusState).toBe("config-panel");
  });
});

// ==========================================================================
// 13. Navigation Boundary (cursor clamping)
// ==========================================================================

describe("Navigation boundary: cursor clamping at min/max", () => {
  // SETTABLE_KEYS has 4 entries: thinking, model, memory.maxResults, memory.maxEntries
  const SETTABLE_KEYS_COUNT = 4;

  it("up from cursor 0 stays at 0 (does not go negative)", () => {
    const state = reduceActions([
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
    ]);

    const panel = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.cursors.settings).toBe(0);

    // Navigate up from 0 — should stay at 0
    const afterUp = tuiReducer(state, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "up",
    } as TUIAction);

    const afterPanel = (afterUp as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(afterPanel.cursors.settings).toBe(0);
  });

  it("down from last item stays at last (does not exceed max)", () => {
    // Navigate to the last item (index = SETTABLE_KEYS_COUNT - 1 = 3)
    const actions: TUIAction[] = [
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
    ];
    for (let i = 0; i < SETTABLE_KEYS_COUNT - 1; i++) {
      actions.push({ type: "CONFIG_PANEL_NAVIGATE", direction: "down" } as TUIAction);
    }
    const state = reduceActions(actions);

    const panel = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.cursors.settings).toBe(SETTABLE_KEYS_COUNT - 1);

    // Navigate down one more — should stay at last
    const afterDown = tuiReducer(state, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "down",
    } as TUIAction);

    const afterPanel = (afterDown as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(afterPanel.cursors.settings).toBe(SETTABLE_KEYS_COUNT - 1);
  });

  it("multiple up presses from 0 remain at 0", () => {
    const actions: TUIAction[] = [
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
      { type: "CONFIG_PANEL_NAVIGATE", direction: "up" } as TUIAction,
      { type: "CONFIG_PANEL_NAVIGATE", direction: "up" } as TUIAction,
      { type: "CONFIG_PANEL_NAVIGATE", direction: "up" } as TUIAction,
    ];
    const state = reduceActions(actions);

    const panel = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.cursors.settings).toBe(0);
  });

  it("multiple down presses beyond max remain at max", () => {
    const actions: TUIAction[] = [
      { type: "CONFIG_PANEL_OPEN", tab: "settings" } as TUIAction,
    ];
    // Press down more times than there are items
    for (let i = 0; i < SETTABLE_KEYS_COUNT + 5; i++) {
      actions.push({ type: "CONFIG_PANEL_NAVIGATE", direction: "down" } as TUIAction);
    }
    const state = reduceActions(actions);

    const panel = (state as TUIState & { configPanel: ConfigPanelState }).configPanel;
    expect(panel.cursors.settings).toBe(SETTABLE_KEYS_COUNT - 1);
  });
});

// ==========================================================================
// 14. Gap 1: COMMAND_RESULT propagates configPanel.open and configPanel.tab
// ==========================================================================

describe("COMMAND_RESULT propagates configPanel state (Gap 1)", () => {
  it("COMMAND_RESULT with configPanel settings tab sets open, tab, and focusState", () => {
    const state = tuiReducer(initialState, {
      type: "COMMAND_RESULT",
      output: "",
      stateChange: { configPanel: { open: true, tab: "settings" } },
    } as TUIAction);

    expect(state.configPanel.open).toBe(true);
    expect(state.configPanel.tab).toBe("settings");
    expect(state.focusState).toBe("config-panel");
  });

  it("COMMAND_RESULT with configPanel models tab sets open, tab, and focusState", () => {
    const state = tuiReducer(initialState, {
      type: "COMMAND_RESULT",
      output: "",
      stateChange: { configPanel: { open: true, tab: "models" } },
    } as TUIAction);

    expect(state.configPanel.open).toBe(true);
    expect(state.configPanel.tab).toBe("models");
    expect(state.focusState).toBe("config-panel");
  });

  it("COMMAND_RESULT without configPanel stateChange leaves panel closed", () => {
    const state = tuiReducer(initialState, {
      type: "COMMAND_RESULT",
      output: "some output",
    } as TUIAction);

    expect(state.configPanel.open).toBe(false);
    expect(state.focusState).toBe("input");
  });
});

// ==========================================================================
// 15. Gap 2: Full flow — COMMAND_RESULT opens panel, CONFIG_PANEL_CLOSE closes it
// ==========================================================================

describe("Full lifecycle: COMMAND_RESULT open -> CONFIG_PANEL_CLOSE (Gap 2)", () => {
  it("COMMAND_RESULT opens models panel, then CONFIG_PANEL_CLOSE restores input focus", () => {
    // Step 1: COMMAND_RESULT opens config panel on models tab
    const opened = tuiReducer(initialState, {
      type: "COMMAND_RESULT",
      output: "",
      stateChange: { configPanel: { open: true, tab: "models" } },
    } as TUIAction);

    expect(opened.configPanel.open).toBe(true);
    expect(opened.configPanel.tab).toBe("models");
    expect(opened.focusState).toBe("config-panel");

    // Step 2: CONFIG_PANEL_CLOSE closes panel and returns focus to input
    const closed = tuiReducer(opened, {
      type: "CONFIG_PANEL_CLOSE",
    } as TUIAction);

    expect(closed.configPanel.open).toBe(false);
    expect(closed.focusState).toBe("input");
  });

  it("COMMAND_RESULT opens settings panel, then CONFIG_PANEL_CLOSE restores input focus", () => {
    const opened = tuiReducer(initialState, {
      type: "COMMAND_RESULT",
      output: "",
      stateChange: { configPanel: { open: true, tab: "settings" } },
    } as TUIAction);

    expect(opened.configPanel.open).toBe(true);
    expect(opened.configPanel.tab).toBe("settings");
    expect(opened.focusState).toBe("config-panel");

    const closed = tuiReducer(opened, {
      type: "CONFIG_PANEL_CLOSE",
    } as TUIAction);

    expect(closed.configPanel.open).toBe(false);
    expect(closed.focusState).toBe("input");
  });
});

// ==========================================================================
// 16. App.tsx integration: ConfigPanel rendering contract
// ==========================================================================

describe("App.tsx integration: ConfigPanel rendering contract", () => {
  it("configPanel.open in TUIState gates ConfigPanel rendering", () => {
    // This test verifies the state contract that App.tsx uses to decide
    // whether to render ConfigPanel. App.tsx must check state.configPanel.open.

    // Panel closed: App should NOT render ConfigPanel
    const closed = initialState;
    expect(closed.configPanel.open).toBe(false);

    // Panel opened via COMMAND_RESULT: App SHOULD render ConfigPanel
    const opened = tuiReducer(closed, {
      type: "COMMAND_RESULT",
      output: "",
      stateChange: { configPanel: { open: true, tab: "settings" } },
    } as TUIAction);
    expect(opened.configPanel.open).toBe(true);
    expect(opened.configPanel.tab).toBe("settings");
    expect(opened.focusState).toBe("config-panel");

    // Panel opened via CONFIG_PANEL_OPEN: App SHOULD render ConfigPanel
    const opened2 = tuiReducer(closed, {
      type: "CONFIG_PANEL_OPEN",
      tab: "models",
    } as TUIAction);
    expect(opened2.configPanel.open).toBe(true);
    expect(opened2.configPanel.tab).toBe("models");
  });
});

// ==========================================================================
// 17. Phase C2: Reducer — MCP Drilldown Actions (SCC-C14c, SCC-C13a)
// ==========================================================================

describe("SCC-C14c: Reducer CONFIG_PANEL_MCP_DRILLDOWN and CONFIG_PANEL_MCP_BACK", () => {
  it("CONFIG_PANEL_MCP_DRILLDOWN sets level='tools' and selectedServer", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "mcp",
    } as TUIAction);

    const drilled = tuiReducer(opened, {
      type: "CONFIG_PANEL_MCP_DRILLDOWN",
      server: "klayout",
    } as TUIAction);

    expect(drilled.configPanel.mcpDrilldown.level).toBe("tools");
    expect(drilled.configPanel.mcpDrilldown.selectedServer).toBe("klayout");
  });

  it("CONFIG_PANEL_MCP_BACK resets level='servers' and clears selectedServer", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "mcp",
    } as TUIAction);

    const drilled = tuiReducer(opened, {
      type: "CONFIG_PANEL_MCP_DRILLDOWN",
      server: "klayout",
    } as TUIAction);

    // Pre-condition: drilldown must have taken effect
    expect(drilled.configPanel.mcpDrilldown.level).toBe("tools");
    expect(drilled.configPanel.mcpDrilldown.selectedServer).toBe("klayout");

    const backed = tuiReducer(drilled, {
      type: "CONFIG_PANEL_MCP_BACK",
    } as TUIAction);

    expect(backed.configPanel.mcpDrilldown.level).toBe("servers");
    expect(backed.configPanel.mcpDrilldown.selectedServer).toBeNull();
  });

  it("CONFIG_PANEL_MCP_BACK preserves toolIndex for re-drill", () => {
    const opened = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "mcp",
    } as TUIAction);

    // Drill into klayout
    const drilled = tuiReducer(opened, {
      type: "CONFIG_PANEL_MCP_DRILLDOWN",
      server: "klayout",
    } as TUIAction);

    // Navigate down in tool list (simulate cursor movement in mcp tab while drilled)
    const navigated = tuiReducer(drilled, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "down",
    } as TUIAction);

    // Back out
    const backed = tuiReducer(navigated, {
      type: "CONFIG_PANEL_MCP_BACK",
    } as TUIAction);

    // Re-drill into same server — toolIndex should be preserved
    const reDrilled = tuiReducer(backed, {
      type: "CONFIG_PANEL_MCP_DRILLDOWN",
      server: "klayout",
    } as TUIAction);

    expect(reDrilled.configPanel.mcpDrilldown.level).toBe("tools");
    expect(reDrilled.configPanel.mcpDrilldown.selectedServer).toBe("klayout");
    // The mcp cursor (which doubles as toolIndex) should retain position from before
    expect(reDrilled.configPanel.cursors.mcp).toBeGreaterThan(0);
  });
});

// ==========================================================================
// 18. Phase C2: /mcp Command Tests (SCC-C17, SCC-C18, SCC-C19, SCC-C20)
// ==========================================================================

/** Build a mock CommandContext with MCP manager for /mcp command tests */
function mockMcpContext(overrides?: {
  configDir?: string;
  disabledTools?: string[];
}): CommandContext {
  const config = makeConfig({
    klayout: { disabledTools: overrides?.disabledTools ?? [] },
  });
  return {
    session: {
      config,
      configDir: overrides?.configDir,
      mcpManager: {
        getServerKeys: () => ["klayout"],
        isConnected: (k: string) => k === "klayout",
        getToolCount: (k: string) => (k === "klayout" ? 6 : 0),
        getTools: (k: string) =>
          k === "klayout"
            ? [
                { name: "screenshot", description: "Capture viewport" },
                { name: "get_layout_info", description: "Layout summary" },
                { name: "create_layout", description: "Create new layout" },
                { name: "execute_script", description: "Run pya code" },
                { name: "save_layout", description: "Save layout" },
                { name: "auto_route", description: "Autoroute pins" },
              ]
            : [],
        allTools: () => [
          { name: "screenshot", description: "Capture viewport", group: "klayout" },
          { name: "get_layout_info", description: "Layout summary", group: "klayout" },
          { name: "create_layout", description: "Create new layout", group: "klayout" },
          { name: "execute_script", description: "Run pya code", group: "klayout" },
          { name: "save_layout", description: "Save layout", group: "klayout" },
          { name: "auto_route", description: "Autoroute pins", group: "klayout" },
        ],
        reconnect: async () => {},
        reconnectAll: async () => {},
      },
    } as unknown as CommandContext["session"],
    mode: "tui",
  };
}

describe("SCC-C17: /mcp (bare) opens ConfigPanel MCP tab", () => {
  it("/mcp with no args returns stateChange to open MCP tab", async () => {
    const ctx = mockMcpContext();
    const result = await mcpCommand.execute([], ctx);

    expect(result.stateChange).toBeDefined();
    expect(result.stateChange!.configPanel).toEqual({
      open: true,
      tab: "mcp",
    });
  });
});

describe("SCC-C18: /mcp disable adds tool to disabledTools", () => {
  it("/mcp disable auto_route persists to klayout.json disabledTools", async () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);

    const ctx = mockMcpContext({ configDir: join(tmpDir, "config") });
    const result = await mcpCommand.execute(["disable", "auto_route"], ctx);

    expect(result.exitCode).toBe(0);

    // Verify klayout.json was updated
    const klayoutJson = JSON.parse(
      readFileSync(join(tmpDir, "config", "klayout.json"), "utf8"),
    );
    expect(klayoutJson.disabledTools).toContain("auto_route");
  });
});

describe("SCC-C19: /mcp enable removes tool from disabledTools", () => {
  it("/mcp enable auto_route removes from disabledTools in klayout.json", async () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig({ klayout: { disabledTools: ["auto_route"] } });
    writeConfigFiles(tmpDir, config);

    const ctx = mockMcpContext({
      configDir: join(tmpDir, "config"),
      disabledTools: ["auto_route"],
    });
    const result = await mcpCommand.execute(["enable", "auto_route"], ctx);

    expect(result.exitCode).toBe(0);

    // Verify klayout.json was updated
    const klayoutJson = JSON.parse(
      readFileSync(join(tmpDir, "config", "klayout.json"), "utf8"),
    );
    expect(klayoutJson.disabledTools).not.toContain("auto_route");
  });
});

describe("SCC-C20: /mcp disable base tool returns error", () => {
  it("/mcp disable read rejects base tools", async () => {
    const ctx = mockMcpContext();
    const result = await mcpCommand.execute(["disable", "read"], ctx);

    expect(result.exitCode).toBe(1);
    expect(result.output.toLowerCase()).toContain("base tool");
  });
});

// ==========================================================================
// 19. Phase C2: ConfigPanel MCP Tab Component Tests (SCC-C10–C14f)
// ==========================================================================

// MCP server data type for ConfigPanel
interface MCPServerData {
  key: string;
  displayName: string;
  connected: boolean;
  tools: Array<{
    name: string;
    description: string;
    disabled: boolean;
    annotation?: import("../src/types/v04-contracts.js").ToolAnnotation;
  }>;
}

function makeMcpServers(): MCPServerData[] {
  return [
    {
      key: "klayout",
      displayName: "klayout",
      connected: true,
      tools: [
        {
          name: "screenshot",
          description: "Capture viewport",
          disabled: false,
          annotation: { name: "screenshot", readonly: true },
        },
        {
          name: "execute_script",
          description: "Run pya code",
          disabled: false,
          annotation: { name: "execute_script", readwrite: true },
        },
        {
          name: "auto_route",
          description: "Autoroute pins",
          disabled: true,
          annotation: { name: "auto_route", readwrite: true, backgroundable: true },
        },
      ],
    },
    {
      key: "generic-server",
      displayName: "generic-server",
      connected: false,
      tools: [],
    },
  ];
}

describe("SCC-C10: ConfigPanel MCP tab renders server list", () => {
  it("renders both klayout and generic servers in server list view", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({ tab: "mcp" });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = stripAnsi(lastFrame() ?? "");
    expect(output).toContain("klayout");
    expect(output).toContain("generic-server");
  });
});

describe("SCC-C10a: Server list shows connection status icons", () => {
  it("shows green dot for connected and red dot for disconnected on distinct rows", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({ tab: "mcp" });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = lastFrame() ?? "";
    const lines = output.split("\n");
    const plain = stripAnsi(output);

    // Find the line for each server and verify its status icon is on that same line
    const klayoutLine = lines.find((l) => stripAnsi(l).includes("klayout") && !stripAnsi(l).includes("generic"));
    const genericLine = lines.find((l) => stripAnsi(l).includes("generic-server"));

    expect(klayoutLine).toBeDefined();
    expect(genericLine).toBeDefined();

    // Connected server (klayout) must have ● on its row
    expect(stripAnsi(klayoutLine!)).toMatch(/●/);
    // Disconnected server (generic-server) must have ○ on its row
    expect(stripAnsi(genericLine!)).toMatch(/○/);

    // They must be on DIFFERENT lines (distinct status rows)
    expect(klayoutLine).not.toBe(genericLine);
  });
});

describe("SCC-C10b: Server list shows tool count per server", () => {
  it("displays tool count next to each server", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({ tab: "mcp" });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = stripAnsi(lastFrame() ?? "");
    // klayout has 3 tools, generic-server has 0
    expect(output).toMatch(/klayout.*3\s*tool/i);
    expect(output).toMatch(/generic-server.*0\s*tool/i);
  });
});

describe("SCC-C10c: KLayout server display name", () => {
  it("KLayout server displays as 'klayout' not 'klayout_mcp'", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({ tab: "mcp" });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = stripAnsi(lastFrame() ?? "");
    expect(output).toContain("klayout");
    expect(output).not.toContain("klayout_mcp");
  });
});

describe("SCC-C11: Enter on server dispatches CONFIG_PANEL_MCP_DRILLDOWN", () => {
  it("dispatches drilldown action with selected server key", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      cursors: { settings: 0, models: 0, mcp: 0 },
    });
    const servers = makeMcpServers();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    // Press Enter to drill into first server (klayout at cursor 0)
    pressKey(stdin, "enter");

    const drilldownCalls = dispatch.mock.calls.filter(
      ([action]: [TUIAction]) => action.type === "CONFIG_PANEL_MCP_DRILLDOWN",
    );
    expect(drilldownCalls.length).toBe(1);
    expect((drilldownCalls[0][0] as { type: string; server: string }).server).toBe("klayout");
  });
});

describe("SCC-C11a: Tool list header shows back indicator and tool count", () => {
  it("renders '← serverName (N tools)' header in tool drilldown view", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      mcpDrilldown: { level: "tools", selectedServer: "klayout", toolIndex: 0 },
    });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = stripAnsi(lastFrame() ?? "");
    // Header must contain back arrow, server name, and tool count
    expect(output).toContain("klayout");
    expect(output).toMatch(/←.*klayout.*3\s*tool/i);
  });
});

describe("SCC-C12: Tool annotation icons rendered", () => {
  it("renders correct annotation icon on each tool's row", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      mcpDrilldown: { level: "tools", selectedServer: "klayout", toolIndex: 0 },
    });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = lastFrame() ?? "";
    const lines = output.split("\n");

    // Find the line containing each tool name and verify its icon is on the SAME line
    const screenshotLine = lines.find((l) => stripAnsi(l).includes("screenshot"));
    const executeScriptLine = lines.find((l) => stripAnsi(l).includes("execute_script"));
    const autoRouteLine = lines.find((l) => stripAnsi(l).includes("auto_route"));

    expect(screenshotLine).toBeDefined();
    expect(executeScriptLine).toBeDefined();
    expect(autoRouteLine).toBeDefined();

    // screenshot is readonly → eyes icon (👀) on its row
    expect(screenshotLine).toContain("\u{1F440}");
    // execute_script is readwrite → pen icon (🖊️) on its row
    expect(executeScriptLine).toContain("\u{1F58A}");
    // auto_route is disabled → lock icon (🔒) on its row
    expect(autoRouteLine).toContain("\u{1F512}");
  });
});

describe("SCC-C13: Escape from tool list dispatches CONFIG_PANEL_MCP_BACK", () => {
  it("dispatches back action on Escape in tool drilldown", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      mcpDrilldown: { level: "tools", selectedServer: "klayout", toolIndex: 0 },
    });
    const servers = makeMcpServers();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    pressKey(stdin, "escape");

    const backCalls = dispatch.mock.calls.filter(
      ([action]: [TUIAction]) => action.type === "CONFIG_PANEL_MCP_BACK",
    );
    expect(backCalls.length).toBe(1);
  });
});

describe("SCC-C14f: 'r' key dispatches reconnect action", () => {
  it("dispatches CONFIG_PANEL_MCP_RECONNECT with selected server key", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      cursors: { settings: 0, models: 0, mcp: 0 },
    });
    const servers = makeMcpServers();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    // Press 'r' for reconnect
    stdin.write("r");

    // Must dispatch exactly CONFIG_PANEL_MCP_RECONNECT (not MCP_RECONNECT or other)
    const reconnectCalls = dispatch.mock.calls.filter(
      ([action]: [TUIAction]) =>
        (action as { type: string }).type === "CONFIG_PANEL_MCP_RECONNECT",
    );
    expect(reconnectCalls.length).toBe(1);

    // Must include the server key for the currently selected server (cursor 0 = klayout)
    const payload = reconnectCalls[0][0] as { type: string; server: string };
    expect(payload.server).toBe("klayout");
  });
});

// ==========================================================================
// 20. Phase C2: Cross-layer Integration (SCC-C23, SCC-C31, SCC-C40)
// ==========================================================================

describe("SCC-C23: MCP tab Space toggle updates klayout.json disabledTools", () => {
  it("Space on enabled tool disables it and persists to config", () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);

    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      mcpDrilldown: { level: "tools", selectedServer: "klayout", toolIndex: 0 },
    });
    const servers = makeMcpServers();

    const { stdin } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        configDir: join(tmpDir, "config"),
        mcpServers: servers,
      }),
    );

    // Press Space to toggle the first tool (screenshot, currently enabled)
    stdin.write(" ");

    // Dispatch should include a toggle action
    const toggleCalls = dispatch.mock.calls.filter(
      ([action]: [TUIAction]) =>
        (action as { type: string }).type === "CONFIG_PANEL_MCP_TOGGLE_TOOL" ||
        (action as { type: string }).type === "MCP_TOOL_TOGGLE",
    );
    expect(toggleCalls.length).toBeGreaterThanOrEqual(1);

    // CRITICAL: Verify disk persistence — klayout.json must contain the toggled tool
    const klayoutJson = JSON.parse(
      readFileSync(join(tmpDir, "config", "klayout.json"), "utf8"),
    );
    expect(klayoutJson.disabledTools).toContain("screenshot");
  });
});

describe("SCC-C31: MCP drill-down full cycle", () => {
  it("open → drill → navigate → escape produces correct state transitions", () => {
    // Open config panel on MCP tab
    let state = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "mcp",
    } as TUIAction);
    expect(state.configPanel.open).toBe(true);
    expect(state.configPanel.tab).toBe("mcp");
    expect(state.configPanel.mcpDrilldown.level).toBe("servers");

    // Drill into klayout
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_MCP_DRILLDOWN",
      server: "klayout",
    } as TUIAction);
    expect(state.configPanel.mcpDrilldown.level).toBe("tools");
    expect(state.configPanel.mcpDrilldown.selectedServer).toBe("klayout");

    // Navigate down in tool list
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "down",
    } as TUIAction);
    expect(state.configPanel.cursors.mcp).toBeGreaterThanOrEqual(1);

    // Back out
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_MCP_BACK",
    } as TUIAction);
    expect(state.configPanel.mcpDrilldown.level).toBe("servers");

    // Focus should still be on config panel
    expect(state.focusState).toBe("config-panel");
  });
});

describe("SCC-C40: ConfigPanel cursor/drilldown survives close/reopen", () => {
  it("drilldown state and cursor positions persist across close/reopen", () => {
    // Open MCP tab, drill into klayout, and navigate
    let state = tuiReducer(initialState, {
      type: "CONFIG_PANEL_OPEN",
      tab: "mcp",
    } as TUIAction);

    // Drill into klayout
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_MCP_DRILLDOWN",
      server: "klayout",
    } as TUIAction);
    expect(state.configPanel.mcpDrilldown.level).toBe("tools");
    expect(state.configPanel.mcpDrilldown.selectedServer).toBe("klayout");

    // Move cursor down in tool list
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_NAVIGATE",
      direction: "down",
    } as TUIAction);
    const savedCursor = state.configPanel.cursors.mcp;
    expect(savedCursor).toBeGreaterThan(0);

    // Close the panel
    state = tuiReducer(state, { type: "CONFIG_PANEL_CLOSE" } as TUIAction);
    expect(state.configPanel.open).toBe(false);

    // Reopen — drilldown state and cursor should still be preserved
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_OPEN",
      tab: "mcp",
    } as TUIAction);
    expect(state.configPanel.open).toBe(true);
    expect(state.configPanel.cursors.mcp).toBe(savedCursor);
    expect(state.configPanel.mcpDrilldown.selectedServer).toBe("klayout");
  });
});

// ==========================================================================
// 21. Phase C2: Edge Cases (SCC-C37, SCC-C38, SCC-C36)
// ==========================================================================

describe("SCC-C37: klayout.json missing during toggle creates file", () => {
  it("/mcp disable works even when klayout.json does not exist", async () => {
    const tmpDir = makeTmpDir();
    // Create config dir but do NOT write klayout.json
    mkdirSync(join(tmpDir, "config"), { recursive: true });

    const ctx = mockMcpContext({ configDir: join(tmpDir, "config") });
    const result = await mcpCommand.execute(["disable", "auto_route"], ctx);

    expect(result.exitCode).toBe(0);

    // klayout.json should now exist with auto_route disabled
    const klayoutJson = JSON.parse(
      readFileSync(join(tmpDir, "config", "klayout.json"), "utf8"),
    );
    expect(klayoutJson.disabledTools).toContain("auto_route");
  });
});

describe("SCC-C38: Disconnected server with 0 tools shows safe empty list", () => {
  it("renders empty tool list with 'no tools' message for disconnected server", () => {
    const dispatch = vi.fn();
    const state = defaultPanelState({
      tab: "mcp",
      mcpDrilldown: { level: "tools", selectedServer: "generic-server", toolIndex: 0 },
    });
    const servers = makeMcpServers();

    const { lastFrame } = render(
      React.createElement(ConfigPanel, {
        config: makeConfig(),
        configPanelState: state,
        dispatch,
        mcpServers: servers,
      }),
    );

    const output = stripAnsi(lastFrame() ?? "");
    // Should show the server name in the header
    expect(output).toContain("generic-server");
    // Should show 0 tools count
    expect(output).toMatch(/0\s*tool/i);

    // The tool list area must show an explicit empty state message (not just a header)
    // Verify no tool names from other servers leak through
    expect(output).not.toContain("screenshot");
    expect(output).not.toContain("execute_script");
    expect(output).not.toContain("auto_route");
    // Must show an explicit "no tools" or "empty" indicator
    expect(output).toMatch(/no tools|empty|not available|disconnected/i);
  });
});

describe("SCC-C36: Repeated toggle produces correct disabledTools set", () => {
  it("enable → disable → enable cycle results in tool being enabled", async () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig({ klayout: { disabledTools: [] } });
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    // First: disable auto_route
    const ctx1 = mockMcpContext({ configDir });
    await mcpCommand.execute(["disable", "auto_route"], ctx1);

    let klayoutJson = JSON.parse(readFileSync(join(configDir, "klayout.json"), "utf8"));
    expect(klayoutJson.disabledTools).toContain("auto_route");

    // Second: enable auto_route
    const ctx2 = mockMcpContext({ configDir, disabledTools: ["auto_route"] });
    await mcpCommand.execute(["enable", "auto_route"], ctx2);

    klayoutJson = JSON.parse(readFileSync(join(configDir, "klayout.json"), "utf8"));
    expect(klayoutJson.disabledTools).not.toContain("auto_route");

    // Third: disable again
    const ctx3 = mockMcpContext({ configDir });
    await mcpCommand.execute(["disable", "auto_route"], ctx3);

    klayoutJson = JSON.parse(readFileSync(join(configDir, "klayout.json"), "utf8"));
    expect(klayoutJson.disabledTools).toContain("auto_route");

    // Fourth: enable again — final state should be enabled
    const ctx4 = mockMcpContext({ configDir, disabledTools: ["auto_route"] });
    await mcpCommand.execute(["enable", "auto_route"], ctx4);

    klayoutJson = JSON.parse(readFileSync(join(configDir, "klayout.json"), "utf8"));
    expect(klayoutJson.disabledTools).not.toContain("auto_route");
  });
});

// ---------------------------------------------------------------------------
// Section 22: Generic MCP server per-server persistence (SCC-C11d/C11e)
// ---------------------------------------------------------------------------

/**
 * Build a mock CommandContext that includes a generic MCP server with tools.
 * The allTools() response includes tools from both klayout and generic-server,
 * so the command can look up which server owns a given tool.
 */
function mockMcpContextGeneric(overrides?: {
  configDir?: string;
  disabledTools?: string[];
}): CommandContext {
  const config = makeConfig({
    klayout: { disabledTools: overrides?.disabledTools ?? [] },
  });
  return {
    session: {
      config,
      configDir: overrides?.configDir,
      mcpManager: {
        getServerKeys: () => ["klayout", "generic-server"],
        isConnected: (k: string) => true,
        getToolCount: (k: string) => (k === "klayout" ? 6 : 2),
        getTools: (k: string) =>
          k === "generic-server"
            ? [
                { name: "custom_fetch", description: "Fetch data" },
                { name: "custom_search", description: "Search" },
              ]
            : k === "klayout"
              ? [
                  { name: "screenshot", description: "Capture viewport" },
                  { name: "auto_route", description: "Autoroute pins" },
                ]
              : [],
        allTools: () => [
          { name: "screenshot", description: "Capture viewport", group: "klayout" },
          { name: "auto_route", description: "Autoroute pins", group: "klayout" },
          { name: "custom_fetch", description: "Fetch data", group: "generic-server" },
          { name: "custom_search", description: "Search", group: "generic-server" },
        ],
        reconnect: async () => {},
        reconnectAll: async () => {},
      },
    } as unknown as CommandContext["session"],
    mode: "tui",
  };
}

describe("SCC-C11d: /mcp disable generic server tool persists to mcp.json", () => {
  it("/mcp disable custom_fetch writes to mcp.json under generic-server.disabledTools, not klayout.json", async () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    const ctx = mockMcpContextGeneric({ configDir });
    const result = await mcpCommand.execute(["disable", "custom_fetch"], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("custom_fetch");

    // Must persist to mcp.json under the generic-server key
    const mcpPath = join(configDir, "mcp.json");
    const mcpJson = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(mcpJson["generic-server"]).toBeDefined();
    expect(mcpJson["generic-server"].disabledTools).toContain("custom_fetch");

    // Must NOT write to klayout.json disabledTools
    const klayoutPath = join(configDir, "klayout.json");
    if (existsSync(klayoutPath)) {
      const klayoutJson = JSON.parse(readFileSync(klayoutPath, "utf8"));
      const klayoutDisabled = klayoutJson.disabledTools ?? [];
      expect(klayoutDisabled).not.toContain("custom_fetch");
    }
  });
});

describe("SCC-C11e: /mcp enable generic server tool removes from mcp.json", () => {
  it("/mcp enable custom_fetch removes from mcp.json generic-server.disabledTools", async () => {
    const tmpDir = makeTmpDir();
    const config = makeConfig();
    writeConfigFiles(tmpDir, config);
    const configDir = join(tmpDir, "config");

    // Pre-populate mcp.json with the tool disabled
    const mcpPath = join(configDir, "mcp.json");
    const mcpData = JSON.parse(readFileSync(mcpPath, "utf8"));
    mcpData["generic-server"] = { disabledTools: ["custom_fetch", "custom_search"] };
    writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2));

    const ctx = mockMcpContextGeneric({ configDir });
    const result = await mcpCommand.execute(["enable", "custom_fetch"], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("custom_fetch");

    // custom_fetch should be removed, custom_search should remain
    const updatedMcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(updatedMcp["generic-server"].disabledTools).not.toContain("custom_fetch");
    expect(updatedMcp["generic-server"].disabledTools).toContain("custom_search");
  });
});

describe("SCC-C11f: /mcp command usage includes enable and disable", () => {
  it("mcpCommand.usage string contains 'enable' and 'disable'", () => {
    expect(mcpCommand.usage).toContain("enable");
    expect(mcpCommand.usage).toContain("disable");
  });
});

// ==========================================================================
// 23. Phase C2: Runtime tool filtering — all servers' disabledTools combined
// ==========================================================================

import { filterDisabledTools } from "../src/tools/index.js";
import { getAllMCPServers } from "../src/config.js";

describe("SCC-C12a: filterDisabledTools filters tools from combined klayout + generic MCP disabled lists", () => {
  it("filters disabled tools from all servers while preserving base tools", () => {
    const allToolNames = [
      "read",
      "bash",
      "screenshot",
      "auto_route",
      "custom_fetch",
      "custom_search",
    ];
    // Combined disabled list from klayout (auto_route) + generic MCP (custom_fetch)
    const disabledTools = ["auto_route", "custom_fetch"];

    const result = filterDisabledTools(allToolNames, disabledTools);

    // Base tools must survive even if someone tries to disable them
    expect(result).toContain("read");
    expect(result).toContain("bash");

    // Disabled tools must be filtered out
    expect(result).not.toContain("auto_route");
    expect(result).not.toContain("custom_fetch");

    // Non-disabled, non-base tools must remain
    expect(result).toContain("screenshot");
    expect(result).toContain("custom_search");

    // Exact expected output
    expect(result).toEqual(["read", "bash", "screenshot", "custom_search"]);
  });
});

describe("SCC-C12b: getAllMCPServers returns disabledTools from mcp config for all servers", () => {
  it("collects disabledTools from both klayout and generic MCP servers", () => {
    const config = makeConfig();
    // Set klayout disabled tools
    config.klayout.disabledTools = ["auto_route"];
    // Set generic MCP server with its own disabled tools
    config.mcp = {
      "generic-server": {
        url: "http://localhost:9999/mcp",
        disabledTools: ["custom_fetch"],
      },
    };

    const servers = getAllMCPServers(config);

    // klayout server must include its disabled tools
    expect(servers.klayout).toBeDefined();
    expect(servers.klayout.disabledTools).toContain("auto_route");

    // generic-server must include its disabled tools
    expect(servers["generic-server"]).toBeDefined();
    expect(servers["generic-server"].disabledTools).toContain("custom_fetch");

    // Collecting ALL disabled tools from all servers should yield both
    const allDisabled = Object.values(servers).flatMap(
      (s) => s.disabledTools ?? [],
    );
    expect(allDisabled).toContain("auto_route");
    expect(allDisabled).toContain("custom_fetch");
    expect(allDisabled.length).toBeGreaterThanOrEqual(2);
  });
});
