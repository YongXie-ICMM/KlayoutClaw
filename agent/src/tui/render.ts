/**
 * Ink render entry point for qlaybot TUI.
 */

import React from "react";
import { render } from "ink";
import { App } from "./components/App.js";
import type { QlayBotSession } from "../agent.js";

/**
 * Render the TUI and wait until the user exits.
 */
export async function renderTUI(botSession: QlayBotSession): Promise<void> {
  const { waitUntilExit } = render(React.createElement(App, { botSession }));
  await waitUntilExit();
}
