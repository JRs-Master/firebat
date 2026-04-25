/**
 * MCP Client Adapter — 외부 MCP 서버 접속 관리
 *
 * 파이어뱃 → 외부 MCP 서버 (Gmail, Slack, 카톡 등)
 * 등록된 서버에 연결, 도구 목록 조회, 도구 실행
 * 설정은 data/mcp-servers.json에 영속 저장
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { IMcpClientPort, McpServerConfig, McpToolInfo } from '../../core/ports';
import type { InfraResult } from '../../core/types';
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'mcp-servers.json');

/** MCP 외부 서버 요청 timeout — listTools / callTool 공통.
 *  외부 서버가 hang 되면 RequestTimeout 에러 → 실패 처리 + 자동 disconnect (다음 호출 재연결).
 *  일반 로직 — 모든 서버·도구 동등 적용. 도메인별 분기 0. */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

export class McpClientAdapter implements IMcpClientPort {
  private configs: McpServerConfig[] = [];
  private clients = new Map<string, Client>();

  constructor() {
    this.loadConfigs();
  }

  // ── 설정 영속화 ────────────────────────────────────────────────────────

  private loadConfigs(): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        this.configs = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      }
    } catch {
      this.configs = [];
    }
  }

  private saveConfigs(): void {
    try {
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.configs, null, 2), 'utf-8');
    } catch {}
  }

  // ── 서버 관리 ──────────────────────────────────────────────────────────

  listServers(): McpServerConfig[] {
    return [...this.configs];
  }

  async addServer(config: McpServerConfig): Promise<InfraResult<void>> {
    try {
      // 기존 동일 이름 제거
      const existing = this.configs.findIndex(c => c.name === config.name);
      if (existing >= 0) {
        await this.disconnect(config.name);
        this.configs[existing] = config;
      } else {
        this.configs.push(config);
      }
      this.saveConfigs();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async removeServer(name: string): Promise<InfraResult<void>> {
    try {
      await this.disconnect(name);
      this.configs = this.configs.filter(c => c.name !== name);
      this.saveConfigs();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ── 연결 관리 ──────────────────────────────────────────────────────────

  private async connect(serverName: string): Promise<Client> {
    // 이미 연결된 클라이언트가 있으면 재사용
    if (this.clients.has(serverName)) {
      return this.clients.get(serverName)!;
    }

    const config = this.configs.find(c => c.name === serverName);
    if (!config) throw new Error(`MCP 서버 '${serverName}'을 찾을 수 없습니다.`);
    if (!config.enabled) throw new Error(`MCP 서버 '${serverName}'이 비활성화 상태입니다.`);

    const client = new Client({ name: 'firebat', version: '0.1.0' });

    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('stdio 전송에는 command가 필요합니다.');
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      });
      await client.connect(transport);
    } else if (config.transport === 'sse') {
      if (!config.url) throw new Error('SSE 전송에는 url이 필요합니다.');
      const transport = new SSEClientTransport(new URL(config.url));
      await client.connect(transport);
    } else {
      throw new Error(`지원하지 않는 전송 방식: ${config.transport}`);
    }

    this.clients.set(serverName, client);
    return client;
  }

  private async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try { await client.close(); } catch {}
      this.clients.delete(serverName);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.clients.keys()) {
      await this.disconnect(name);
    }
  }

  // ── 도구 조회/실행 ─────────────────────────────────────────────────────

  async listTools(serverName: string): Promise<InfraResult<McpToolInfo[]>> {
    try {
      const client = await this.connect(serverName);
      // 30초 timeout — 외부 서버가 hang 되면 RequestTimeout 에러로 빠르게 실패.
      const result = await client.listTools(undefined, { timeout: MCP_REQUEST_TIMEOUT_MS });
      const tools: McpToolInfo[] = (result.tools ?? []).map(t => ({
        server: serverName,
        name: t.name,
        description: t.description ?? '',
        // MCP SDK의 inputSchema 타입은 JsonSchema와 구조가 같지만 타입 정의가 달라 캐스팅
        inputSchema: t.inputSchema as McpToolInfo['inputSchema'],
      }));
      return { success: true, data: tools };
    } catch (err: any) {
      // 실패 시 disconnect — 다음 호출이 새 연결 시도 (서버 죽었다 살아나면 자동 복구).
      await this.disconnect(serverName).catch(() => undefined);
      return { success: false, error: err.message };
    }
  }

  async listAllTools(): Promise<InfraResult<McpToolInfo[]>> {
    const allTools: McpToolInfo[] = [];
    const enabledServers = this.configs.filter(c => c.enabled);

    for (const config of enabledServers) {
      const result = await this.listTools(config.name);
      if (result.success && result.data) {
        allTools.push(...result.data);
      }
    }

    return { success: true, data: allTools };
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<InfraResult<unknown>> {
    try {
      const client = await this.connect(serverName);
      const result = await client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: MCP_REQUEST_TIMEOUT_MS },
      );
      // MCP 도구 결과에서 텍스트 추출
      const contentArr = Array.isArray(result.content) ? result.content : [];
      const textContent = contentArr
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { type: string; text?: string }) => c.text ?? '')
        .join('\n');
      return { success: true, data: { content: textContent, raw: result.content } };
    } catch (err: any) {
      // 실패 시 disconnect — 다음 호출이 새 연결 시도 (자동 재연결).
      await this.disconnect(serverName).catch(() => undefined);
      return { success: false, error: err.message };
    }
  }
}
