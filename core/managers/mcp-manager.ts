import type { IMcpClientPort, McpServerConfig } from '../ports';

/**
 * MCP Manager — MCP 서버/도구 관리
 *
 * 인프라: IMcpClientPort
 */
export class McpManager {
  constructor(private readonly mcpClient: IMcpClientPort) {}

  listServers() {
    return this.mcpClient.listServers();
  }

  async addServer(config: McpServerConfig) {
    return this.mcpClient.addServer(config);
  }

  async removeServer(name: string) {
    return this.mcpClient.removeServer(name);
  }

  async listTools(serverName: string) {
    return this.mcpClient.listTools(serverName);
  }

  async listAllTools() {
    return this.mcpClient.listAllTools();
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>) {
    return this.mcpClient.callTool(serverName, toolName, args);
  }
}
