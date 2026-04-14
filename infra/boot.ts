/**
 * Infra Boot — 어댑터 조립 팩토리 (전체 싱글톤)
 *
 * 모든 인프라 어댑터를 1회 생성하고, globalThis에 캐시한다.
 * Core는 이 컨테이너를 받아서 매니저에 포트를 분배한다.
 */
import type { FirebatInfraContainer } from '../core/ports';
import { LocalStorageAdapter } from './storage';
import { ConsoleLogAdapter } from './log';
import { ProcessSandboxAdapter } from './sandbox';
import { SqliteDatabaseAdapter } from './database';
import { FetchNetworkAdapter } from './network';
import { NodeCronAdapter } from './cron';
import { vault } from './storage/vault-adapter';
import { buildVertexAdapter, VERTEX_VAULT_KEYS } from './llm/factory';
import { McpClientAdapter } from './mcp-client';
import { DB_PATH, DEFAULT_MODEL, DEFAULT_VERTEX_LOCATION } from './config';

/** 전체 인프라 싱글톤 */
const globalForInfra = globalThis as unknown as { firebatInfra: FirebatInfraContainer | undefined };

export function getInfra(): FirebatInfraContainer {
  if (!globalForInfra.firebatInfra) {
    const log = new ConsoleLogAdapter();

    // Sandbox
    const sandbox = new ProcessSandboxAdapter();
    sandbox.setVault(vault);

    // Cron
    const cron = new NodeCronAdapter();
    cron.setLogger(log);
    const savedTz = vault.getSecret('system:timezone');
    if (savedTz) cron.setTimezone(savedTz);
    cron.restore();

    // MCP Client
    const mcpClient = new McpClientAdapter();

    // LLM — lazy API 키 로드, 요청별 모델 오버라이드 지원
    const llm = buildVertexAdapter(
      () => vault.getSecret(VERTEX_VAULT_KEYS.apiKey) || process.env[VERTEX_VAULT_KEYS.apiKey] || null,
      DEFAULT_MODEL,
      () => vault.getSecret(VERTEX_VAULT_KEYS.project) || process.env[VERTEX_VAULT_KEYS.project] || undefined,
      () => vault.getSecret(VERTEX_VAULT_KEYS.location) || process.env[VERTEX_VAULT_KEYS.location] || DEFAULT_VERTEX_LOCATION,
    );

    globalForInfra.firebatInfra = {
      storage: new LocalStorageAdapter(),
      log,
      sandbox,
      database: new SqliteDatabaseAdapter(DB_PATH),
      network: new FetchNetworkAdapter(),
      cron,
      vault,
      mcpClient,
      llm,
    };

    // nfo-style banner — 불꽃 그라데이션 (빨강→주황→노랑)
    console.log(`
\x1b[38;5;196m ███████╗██╗██████╗ ███████╗██████╗  █████╗ ████████╗\x1b[0m
\x1b[38;5;202m ██╔════╝██║██╔══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝\x1b[0m
\x1b[38;5;208m █████╗  ██║██████╔╝█████╗  ██████╔╝███████║   ██║   \x1b[0m
\x1b[38;5;214m ██╔══╝  ██║██╔══██╗██╔══╝  ██╔══██╗██╔══██║   ██║   \x1b[0m
\x1b[38;5;220m ██║     ██║██║  ██║███████╗██████╔╝██║  ██║   ██║   \x1b[0m
\x1b[38;5;226m ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   \x1b[0m
\x1b[38;5;246m            Just Imagine. Firebat Runs.\x1b[0m
`);
    log.info('\x1b[38;5;208m[Firebat]\x1b[0m Loading core...');
    log.info('\x1b[38;5;214m[Firebat]\x1b[0m Loading managers...');
    log.info('\x1b[38;5;220m[Firebat]\x1b[0m Loading infra...');
    log.info('\x1b[38;5;226m[Firebat]\x1b[0m Loading system modules...');
    log.info('\x1b[38;5;46m[Firebat]\x1b[0m Ready.');
  }
  return globalForInfra.firebatInfra;
}
