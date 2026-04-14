import type { IVaultPort, IStoragePort } from '../ports';

/** MCP 토큰 정보 (마스킹된 힌트 + 생성일) */
export interface McpTokenInfo {
  exists: boolean;
  hint: string | null;     // 예: fbt_a1b2****k9m3
  createdAt: string | null; // ISO 8601
}

/**
 * Secret Manager — 시크릿 CRUD + 모듈 시크릿 스캔 + MCP 토큰 관리
 *
 * 인프라: IVaultPort, IStoragePort
 */
export class SecretManager {
  constructor(
    private readonly vault: IVaultPort,
    private readonly storage: IStoragePort,
  ) {}

  // ── 사용자 시크릿 ──

  listUser(): string[] {
    const prefix = 'user:';
    return this.vault.listKeysByPrefix(prefix).map(k => k.slice(prefix.length));
  }

  setUser(name: string, value: string): boolean {
    return this.vault.setSecret(`user:${name}`, value);
  }

  getUser(name: string): string | null {
    return this.vault.getSecret(`user:${name}`);
  }

  deleteUser(name: string): boolean {
    return this.vault.deleteSecret(`user:${name}`);
  }

  /** 유저 모듈이 필요로 하는 시크릿 목록 (module.json secrets 필드에서 수집) */
  async listModuleSecrets(): Promise<Array<{ secretName: string; moduleName: string; hasValue: boolean }>> {
    const result: Array<{ secretName: string; moduleName: string; hasValue: boolean }> = [];
    const seen = new Set<string>();
    const listResult = await this.storage.listDir('user/modules');
    if (!listResult.success || !listResult.data) return result;
    for (const entry of listResult.data) {
      if (!entry.isDirectory) continue;
      const file = await this.storage.read(`user/modules/${entry.name}/module.json`);
      if (!file.success || !file.data) continue;
      try {
        const mod = JSON.parse(file.data);
        const secrets: string[] = mod.secrets ?? [];
        for (const s of secrets) {
          if (seen.has(s)) continue;
          seen.add(s);
          result.push({ secretName: s, moduleName: mod.name || entry.name, hasValue: this.getUser(s) !== null });
        }
      } catch {}
    }
    return result;
  }

  // ── 시스템 시크릿 (Vertex AI 등) ──

  getSystem(key: string): string | null {
    return this.vault.getSecret(key);
  }

  setSystem(key: string, value: string): boolean {
    return this.vault.setSecret(key, value);
  }

  // ── MCP 토큰 ──

  /** 새 MCP 토큰 생성 (기존 토큰 무효화). 원본 토큰을 1회 반환 */
  generateMcpToken(): string {
    // fbt_ + 32자 랜덤 hex
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const token = `fbt_${hex}`;

    this.vault.setSecret('system:mcp-token', token);
    this.vault.setSecret('system:mcp-token-created', new Date().toISOString());
    return token;
  }

  /** MCP 토큰 검증 */
  validateMcpToken(token: string): boolean {
    const stored = this.vault.getSecret('system:mcp-token');
    if (!stored || !token) return false;
    return stored === token;
  }

  /** MCP 토큰 폐기 */
  revokeMcpToken(): boolean {
    this.vault.deleteSecret('system:mcp-token');
    this.vault.deleteSecret('system:mcp-token-created');
    return true;
  }

  /** MCP 토큰 정보 조회 (마스킹) */
  getMcpTokenInfo(): McpTokenInfo {
    const token = this.vault.getSecret('system:mcp-token');
    const created = this.vault.getSecret('system:mcp-token-created');
    if (!token) return { exists: false, hint: null, createdAt: null };

    // fbt_xxxx****xxxx (앞 8자 + **** + 뒤 4자)
    const hint = token.length > 12
      ? `${token.slice(0, 8)}****${token.slice(-4)}`
      : '****';
    return { exists: true, hint, createdAt: created };
  }
}
