/**
 * Public API exports for qlaybot.
 */

export { createDesignSession, type QlayBotSession, type CreateDesignSessionOptions } from "./agent.js";
export { loadConfig, type QlayBotConfig, parseModelRef } from "./config.js";
export { MCPManager } from "./mcp/manager.js";
export { KLayoutMCPClient } from "./mcp/klayout-client.js";
export { MemoryManager } from "./memory/index.js";
export { buildSystemPrompt, PromptMode } from "./prompts/index.js";
export { subscribeToSession, type QlayBotEventCallbacks } from "./events.js";
export { InteractionHistory } from "./history.js";
export { registerAllDomainTools } from "./tools/klayout/index.js";
export type { NamespacedTool, MCPServerConfig, MCPToolInfo } from "./mcp/types.js";
