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

/**
 * Tool call result content item.
 *
 * Discriminated union matching the Anthropic message-content schema:
 *   - text:  `{ type: "text", text: string }`
 *   - image: `{ type: "image", source: { type: "base64", media_type: string, data: string } }`
 *
 * Legacy flat fields (`data?`, `mimeType?`) were removed in 0.4.3 Group 4 —
 * image content now lives under the nested `source` object so the whole
 * pipeline (MCP → tool wrapper → TUI) can round-trip images without
 * renegotiating the shape at each hop.
 */
export type MCPContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

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
