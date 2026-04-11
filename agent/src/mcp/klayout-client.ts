/**
 * Custom KLayout MCP client.
 * Handles HTTP JSON-RPC transport, discovers native tools,
 * and routes domain tool calls through execute_script.
 */

import {
  initializeSession,
  listTools,
  callTool,
  parseTextResult,
  parseJsonResult,
} from "./transport.js";
import type {
  MCPToolInfo,
  MCPToolResult,
  NamespacedTool,
  ToolInputSchema,
} from "./types.js";
import { registerAllDomainTools } from "../tools/klayout/index.js";

const KLAYOUT_PREFIX = "klayout";

export interface KLayoutClientOptions {
  url: string;
  timeout?: number;
}

export class KLayoutMCPClient {
  private url: string;
  private timeout: number;
  private sessionId?: string;
  private nativeTools: MCPToolInfo[] = [];
  private domainTools: NamespacedTool[] = [];
  private _connected = false;

  constructor(opts: KLayoutClientOptions) {
    this.url = opts.url;
    this.timeout = opts.timeout ?? 30000;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to KLayout MCP server, initialize session, discover native tools.
   */
  async connect(): Promise<void> {
    this.sessionId = await initializeSession(this.url);
    await this.discoverNativeTools();
    this.registerDomainTools();
    this._connected = true;
  }

  /**
   * Discover the 6 native MCP tools from the server.
   */
  private async discoverNativeTools(): Promise<void> {
    const { tools, sessionId } = await listTools(this.url, this.sessionId);
    this.sessionId = sessionId;
    this.nativeTools = tools;
  }

  /**
   * Register typed domain tools from src/tools/klayout/.
   */
  private registerDomainTools(): void {
    this.domainTools = registerAllDomainTools();
  }

  /**
   * Get all tools (native + domain) with namespaced names using underscores.
   */
  allTools(): NamespacedTool[] {
    const native: NamespacedTool[] = this.nativeTools.map((t) => ({
      name: `${KLAYOUT_PREFIX}_native_${t.name}`,
      originalName: t.name,
      serverKey: KLAYOUT_PREFIX,
      group: "native",
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
    return [...native, ...this.domainTools];
  }

  /**
   * Get all tool names.
   */
  allToolNames(): string[] {
    return this.allTools().map((t) => t.name);
  }

  /**
   * Call a tool by its namespaced name.
   * Native tools are forwarded directly to MCP server.
   * Domain tools generate pya code and call execute_script.
   */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    // Routing: prefer exact lookup against the registered tool, fall back to
    // native-prefix detection. The old code split on the first `_` after the
    // `klayout_` prefix to derive the group, which breaks on multi-level
    // groups like `klayout_nanodevice_flakedetect_detect` (group parsed as
    // `nanodevice` instead of `nanodevice_flakedetect`). Domain tools carry
    // their `group` as a registered field — just honor it.
    const prefix = `${KLAYOUT_PREFIX}_`;
    if (!namespacedName.startsWith(prefix)) {
      throw new Error(`Not a KLayout tool: ${namespacedName}`);
    }

    // Try exact lookup among domain tools first (handles multi-level groups).
    const domainTool = this.domainTools.find((t) => t.name === namespacedName);
    if (domainTool) {
      if (domainTool.group === "native") {
        // Degenerate registration — shouldn't happen, but honor it.
        const { result, sessionId } = await callTool(
          this.url,
          domainTool.originalName,
          args,
          this.sessionId,
          this.timeout,
        );
        this.sessionId = sessionId;
        return result;
      }

      const codeGen = (domainTool as NamespacedTool & { generateCode?: (args: Record<string, unknown>) => string }).generateCode;
      if (!codeGen) {
        throw new Error(`Domain tool ${namespacedName} has no code generator`);
      }
      const pyaCode = codeGen(args);
      const { result, sessionId } = await callTool(
        this.url,
        "execute_script",
        { code: pyaCode },
        this.sessionId,
        this.timeout,
      );
      this.sessionId = sessionId;
      return result;
    }

    // Not a registered domain tool — must be a native tool of the form
    // `klayout_native_<toolName>`. Everything after `klayout_native_` is the
    // original MCP tool name.
    const nativePrefix = `${KLAYOUT_PREFIX}_native_`;
    if (!namespacedName.startsWith(nativePrefix)) {
      throw new Error(`Unknown tool: ${namespacedName}`);
    }
    const toolName = namespacedName.slice(nativePrefix.length);
    if (!toolName) {
      throw new Error(`Invalid native tool name: ${namespacedName}`);
    }
    const { result, sessionId } = await callTool(
      this.url,
      toolName,
      args,
      this.sessionId,
      this.timeout,
    );
    this.sessionId = sessionId;
    return result;
  }

  /**
   * Health check -- verify KLayout is responsive.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const { result } = await callTool(
        this.url,
        "get_layout_info",
        {},
        this.sessionId,
        5000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Disconnect.
   */
  disconnect(): void {
    this._connected = false;
    this.sessionId = undefined;
    this.nativeTools = [];
  }
}
