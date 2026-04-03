/**
 * HTTP JSON-RPC transport for KLayout MCP server.
 * KLayout uses plain HTTP POST (no SSE, no STDIO).
 */

import type { MCPToolInfo, MCPToolResult, MCPContentItem } from "./types.js";

let _reqId = 0;

export interface TransportOptions {
  url: string;
  timeout?: number;
}

/**
 * Send a JSON-RPC 2.0 request to the KLayout MCP server.
 */
export async function jsonRpcRequest(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  timeout = 5000,
): Promise<{ result: unknown; sessionId?: string }> {
  _reqId++;
  const payload = {
    jsonrpc: "2.0" as const,
    id: _reqId,
    method,
    ...(params ? { params } : {}),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    if (data.error) {
      const err = data.error as { code?: number; message?: string };
      throw new Error(`MCP error ${err.code}: ${err.message}`);
    }

    return {
      result: data.result,
      sessionId: response.headers.get("Mcp-Session-Id") ?? sessionId,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Initialize MCP session.
 */
export async function initializeSession(
  url: string,
  clientName = "qlaybot",
  clientVersion = "0.2.0",
): Promise<string | undefined> {
  const { sessionId } = await jsonRpcRequest(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: clientName, version: clientVersion },
  });
  return sessionId;
}

/**
 * List available tools from the MCP server.
 */
export async function listTools(
  url: string,
  sessionId?: string,
): Promise<{ tools: MCPToolInfo[]; sessionId?: string }> {
  const { result, sessionId: newSessionId } = await jsonRpcRequest(
    url,
    "tools/list",
    {},
    sessionId,
  );
  const r = result as { tools?: MCPToolInfo[] };
  return { tools: r.tools ?? [], sessionId: newSessionId };
}

/**
 * Call an MCP tool.
 */
export async function callTool(
  url: string,
  toolName: string,
  args: Record<string, unknown> = {},
  sessionId?: string,
  timeout = 300000,
): Promise<{ result: MCPToolResult; sessionId?: string }> {
  const { result, sessionId: newSessionId } = await jsonRpcRequest(
    url,
    "tools/call",
    { name: toolName, arguments: args },
    sessionId,
    timeout,
  );
  return { result: result as MCPToolResult, sessionId: newSessionId };
}

/**
 * Parse text content from MCP tool result.
 */
export function parseTextResult(result: MCPToolResult): string {
  const textItems = result.content.filter(
    (c: MCPContentItem) => c.type === "text" && c.text,
  );
  return textItems.map((c: MCPContentItem) => c.text!).join("\n");
}

/**
 * Parse JSON from MCP tool result text content.
 */
export function parseJsonResult(result: MCPToolResult): unknown {
  const text = parseTextResult(result);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
