import type { IVaultPort, IStoragePort } from '../ports';
import { vkUserSecret } from '../vault-keys';

/**
 * Secret Manager — 시크릿 CRUD + 모듈 시크릿 스캔
 *
 * 인프라: IVaultPort, IStoragePort
 * 참고: MCP/API 토큰 관리는 AuthManager로 이관됨
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
    return this.vault.setSecret(vkUserSecret(name), value);
  }

  getUser(name: string): string | null {
    return this.vault.getSecret(vkUserSecret(name));
  }

  deleteUser(name: string): boolean {
    return this.vault.deleteSecret(vkUserSecret(name));
  }

  /** 유저 모듈이 필요로 하는 시크릿 목록 (config.json secrets 필드에서 수집) */
  async listModuleSecrets(): Promise<Array<{ secretName: string; moduleName: string; hasValue: boolean }>> {
    const result: Array<{ secretName: string; moduleName: string; hasValue: boolean }> = [];
    const seen = new Set<string>();
    const listResult = await this.storage.listDir('user/modules');
    if (!listResult.success || !listResult.data) return result;
    for (const entry of listResult.data) {
      if (!entry.isDirectory) continue;
      const file = await this.storage.read(`user/modules/${entry.name}/config.json`);
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

}
