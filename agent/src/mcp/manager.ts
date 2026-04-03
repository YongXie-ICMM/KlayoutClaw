/**
 * MCPManager -- routes tool calls to the appropriate MCP server.
 * KLayout uses custom HTTP client; other servers use lazy-loaded connections.
 */

import { KLayoutMCPClient } from "./klayout-client.js";
import {
  initializeSession,
  listTools,
  callTool as transportCallTool,
} from "./transport.js";
import type {
  MCPServerConfig,
  MCPConnection,
  MCPToolResult,
  NamespacedTool,
} from "./types.js";
import { exec } from "child_process";
import { platform } from "os";

const KLAYOUT_KEY = "klayout";

export interface MCPManagerTimeouts {
  requestMs: number;
  toolExecutionMs: number;
  healthCheckMs: number;
  autoLaunchDelaysMs: number[];
}

export interface MCPManagerConfig {
  servers: Record<string, MCPServerConfig>;
  timeouts?: MCPManagerTimeouts;
}

const DEFAULT_TIMEOUTS: MCPManagerTimeouts = {
  requestMs: 5000,
  toolExecutionMs: 300000,
  healthCheckMs: 5000,
  autoLaunchDelaysMs: [1000, 2000, 4000, 8000],
};

export class MCPManager {
  private klayout: KLayoutMCPClient | null = null;
  private connections = new Map<string, MCPConnection>();
  private connecting = new Map<string, Promise<MCPConnection>>();
  private config: MCPManagerConfig;
  private timeouts: MCPManagerTimeouts;

  constructor(config: MCPManagerConfig) {
    this.config = config;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  }

  /**
   * Connect to all required MCP servers.
   * KLayout is connected eagerly; others are registered but lazy-loaded.
   */
  async connectAll(): Promise<void> {
    for (const [key, serverConfig] of Object.entries(this.config.servers)) {
      const serverKey = key.replace(/_mcp$/, "");

      if (serverKey === KLAYOUT_KEY && serverConfig.url) {
        // KLayout: eager connection with auto-launch
        this.klayout = new KLayoutMCPClient({
          url: serverConfig.url,
          timeout: this.timeouts.toolExecutionMs,
        });

        let connected = false;
        try {
          await this.klayout.connect();
          connected = true;
        } catch {
          // Try auto-launch
          connected = await this.autoLaunchAndConnect(serverConfig.url);
        }

        if (!connected) {
          if (serverConfig.required) {
            throw new Error(
              "Cannot connect to KLayout MCP server at " +
                serverConfig.url +
                ". Make sure KLayout is running with KlayoutClaw plugin, " +
                "or launch it manually: open /Applications/klayout.app",
            );
          }
        }
      } else {
        // Other servers: register and eagerly connect so tools are discoverable
        this.connections.set(serverKey, {
          key: serverKey,
          config: serverConfig,
          connected: false,
          tools: [],
        });
        try {
          await this.ensureConnected(serverKey);
        } catch {
          // Non-fatal: server may be unavailable, tools just won't be listed
        }
      }
    }
  }

  /**
   * Auto-launch KLayout and poll for connection.
   */
  private async autoLaunchAndConnect(url: string): Promise<boolean> {
    // Launch KLayout
    const os = platform();
    const launchCmd =
      os === "darwin"
        ? "open /Applications/klayout.app"
        : os === "win32"
          ? "start klayout"
          : "klayout &";

    try {
      await new Promise<void>((resolve, reject) => {
        exec(launchCmd, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      return false;
    }

    // Poll with exponential backoff: 1s, 2s, 4s, 8s (total ~15s)
    const delays = this.timeouts.autoLaunchDelaysMs;
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        this.klayout = new KLayoutMCPClient({ url, timeout: this.timeouts.healthCheckMs });
        await this.klayout.connect();
        // Restore longer timeout for actual tool calls after connect
        this.klayout = new KLayoutMCPClient({ url, timeout: this.timeouts.toolExecutionMs });
        await this.klayout.connect();
        return true;
      } catch {
        // Keep trying
      }
    }
    return false;
  }

  /**
   * Ensure a non-KLayout server is connected (lazy connect).
   */
  private async ensureConnected(serverKey: string): Promise<MCPConnection> {
    const conn = this.connections.get(serverKey);
    if (!conn) {
      throw new Error(`Unknown MCP server: ${serverKey}`);
    }
    if (conn.connected) return conn;

    // Deduplicate concurrent first-connect calls with promise memoization
    const inflight = this.connecting.get(serverKey);
    if (inflight) return inflight;

    const connectPromise = (async () => {
      if (!conn.config.url) {
        throw new Error(`No URL configured for MCP server: ${serverKey}`);
      }

      conn.sessionId = await initializeSession(conn.config.url);
      const { tools, sessionId } = await listTools(
        conn.config.url,
        conn.sessionId,
      );
      conn.sessionId = sessionId;
      conn.tools = tools;
      conn.connected = true;
      return conn;
    })();

    this.connecting.set(serverKey, connectPromise);
    try {
      return await connectPromise;
    } finally {
      this.connecting.delete(serverKey);
    }
  }

  /**
   * Check if a server is connected.
   */
  isConnected(serverKey: string): boolean {
    if (serverKey === KLAYOUT_KEY) {
      return this.klayout?.connected ?? false;
    }
    return this.connections.get(serverKey)?.connected ?? false;
  }

  /**
   * Get all tools from all connected servers (KLayout eager, others lazy-loaded).
   */
  allTools(): NamespacedTool[] {
    const tools: NamespacedTool[] = [];
    if (this.klayout?.connected) {
      tools.push(...this.klayout.allTools());
    }
    // Note: other server tools are only available after lazy connection
    for (const [key, conn] of this.connections) {
      if (conn.connected) {
        for (const t of conn.tools) {
          tools.push({
            name: `${key}_${t.name}`,
            originalName: t.name,
            serverKey: key,
            group: key,
            description: t.description ?? "",
            inputSchema: t.inputSchema,
          });
        }
      }
    }
    return tools;
  }

  /**
   * Get all tool names.
   */
  allToolNames(): string[] {
    return this.allTools().map((t) => t.name);
  }

  /**
   * Route a tool call to the appropriate server.
   */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    // Parse server key from name: "klayout_native_execute_script" -> "klayout"
    const firstUnderscore = namespacedName.indexOf("_");
    if (firstUnderscore === -1) {
      throw new Error(`Invalid namespaced tool name: ${namespacedName}`);
    }

    const serverKey = namespacedName.slice(0, firstUnderscore);

    if (serverKey === KLAYOUT_KEY) {
      if (!this.klayout?.connected) {
        throw new Error("KLayout MCP not connected");
      }
      return this.klayout.callTool(namespacedName, args);
    }

    // Other servers: lazy connect on first call
    const conn = await this.ensureConnected(serverKey);
    const toolName = namespacedName.slice(firstUnderscore + 1);
    const { result, sessionId } = await transportCallTool(
      conn.config.url!,
      toolName,
      args,
      conn.sessionId,
    );
    conn.sessionId = sessionId;
    return result;
  }

  /**
   * Get all configured server keys.
   */
  getServerKeys(): string[] {
    const keys: string[] = [];
    for (const key of Object.keys(this.config.servers)) {
      keys.push(key.replace(/_mcp$/, ""));
    }
    return keys;
  }

  /**
   * Get tool count for a specific server.
   */
  getToolCount(serverKey: string): number {
    if (serverKey === KLAYOUT_KEY) {
      return this.klayout?.connected ? this.klayout.allTools().length : 0;
    }
    const conn = this.connections.get(serverKey);
    return conn?.connected ? conn.tools.length : 0;
  }

  /**
   * Reconnect a specific server.
   */
  async reconnect(serverKey: string): Promise<void> {
    if (serverKey === KLAYOUT_KEY) {
      this.klayout?.disconnect();
      const klayoutConfig = Object.entries(this.config.servers).find(
        ([k]) => k.replace(/_mcp$/, "") === KLAYOUT_KEY,
      );
      if (klayoutConfig?.[1].url) {
        this.klayout = new KLayoutMCPClient({
          url: klayoutConfig[1].url,
          timeout: this.timeouts.toolExecutionMs,
        });
        await this.klayout.connect();
      }
      return;
    }
    const conn = this.connections.get(serverKey);
    if (conn) {
      conn.connected = false;
      conn.tools = [];
      await this.ensureConnected(serverKey);
    }
  }

  /**
   * Reconnect all servers.
   */
  async reconnectAll(): Promise<void> {
    await this.disconnectAll();
    await this.connectAll();
  }

  /**
   * Disconnect all servers.
   */
  async disconnectAll(): Promise<void> {
    this.klayout?.disconnect();
    this.klayout = null;
    this.connecting.clear();
    this.connections.clear();
  }
}
