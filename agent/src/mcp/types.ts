/**
 * MCP connection and tool schema types for qlaybot.
 */

/** Tool parameter schema (JSON Schema subset). */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    items?: { type: string };
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

/** MCP tool definition as returned by tools/list. */
export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: ToolInputSchema;
}

/** Tool call result content item. */
export interface MCPContentItem {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

/** MCP tool call result. */
export interface MCPToolResult {
  content: MCPContentItem[];
  isError?: boolean;
}

/** MCP server config entry from mcp.json. */
export interface MCPServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  required?: boolean;
}

/** MCP connection state. */
export interface MCPConnection {
  key: string;
  config: MCPServerConfig;
  connected: boolean;
  tools: MCPToolInfo[];
  sessionId?: string;
}

/** Namespaced tool: tool definition with its server prefix. */
export interface NamespacedTool {
  /** Full namespaced name, e.g., "klayout_native_execute_script" */
  name: string;
  /** Original MCP tool name, e.g., "execute_script" */
  originalName: string;
  /** Server key, e.g., "klayout" */
  serverKey: string;
  /** Group within server, e.g., "native", "geometry" */
  group: string;
  description: string;
  inputSchema: ToolInputSchema;
}
