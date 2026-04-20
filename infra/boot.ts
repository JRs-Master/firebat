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
import { buildConfigDrivenAdapter, loadModelRegistry } from './llm/factory';
import { McpClientAdapter } from './mcp-client';
import { VaultAuthAdapter } from './auth';
import { DB_PATH, DEFAULT_MODEL } from './config';

/** 전체 인프라 싱글톤 */
const globalForInfra = globalThis as unknown as { firebatInfra: FirebatInfraContainer | undefined };

export function getInfra(): FirebatInfraContainer {
  if (!globalForInfra.firebatInfra) {
    const log = new ConsoleLogAdapter();

    // Vault에 logger 주입 (부팅 전 console.error 대신 ILogPort 사용)
    vault.setLogger(log);

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

    // LLM — Config-driven (configs/*.json 전체 로드 → format handler 위임)
    const registry = loadModelRegistry();
    const modelIds = Object.keys(registry);
    if (modelIds.length === 0) {
      log.warn('[Firebat] LLM 모델 config가 없습니다. infra/llm/configs/ 디렉토리를 확인하세요.');
    }
    const llm = buildConfigDrivenAdapter(
      registry,
      DEFAULT_MODEL,
      (key: string) => vault.getSecret(key) || process.env[key] || null,
      () => {
        const token = vault.getSecret('system:internal-mcp-token');
        const baseUrl = process.env['NEXT_PUBLIC_BASE_URL'] || 'http://localhost:3000';
        if (!token) return null;
        return { url: `${baseUrl}/api/mcp-internal`, token };
      },
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
      auth: new VaultAuthAdapter(vault),
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
    const pause = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end); };
    const BAR_WIDTH = 30;
    const steps = [
      [208, 'Core',           25],
      [214, 'Managers',       50],
      [220, 'Infra',          75],
      [226, 'System Modules', 100],
    ] as [number, string, number][];
    let prev = 0;
    for (const [c, label, target] of steps) {
      for (let pct = prev + 1; pct <= target; pct++) {
        const filled = Math.round((pct / 100) * BAR_WIDTH);
        const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
        process.stdout.write(`\r\x1b[38;5;${c}m[Firebat]\x1b[0m ${bar} ${String(pct).padStart(3)}% \x1b[38;5;246m${label}\x1b[0m`);
        pause(10);
      }
      prev = target;
    }
    process.stdout.write('\n');
    log.info('\x1b[38;5;46m[Firebat]\x1b[0m Ready.');
  }
  return globalForInfra.firebatInfra;
}
