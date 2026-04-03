/**
 * MCP section — describes MCP server topology.
 */

export function buildMCPSection(connectedServers: string[]): string {
  if (connectedServers.length === 0) return "";
  const list = connectedServers.map((s) => `- ${s}`).join("\n");
  return `## MCP Servers\n\nConnected MCP servers:\n${list}\n\nAll KLayout tools use underscored namespacing: \`klayout_native_*\` (6 native MCP tools) and \`klayout_{group}_*\` (typed domain tools). Other MCP servers use \`{server}_{tool}\` format.`;
}
