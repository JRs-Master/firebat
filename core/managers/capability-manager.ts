import type { IStoragePort, IVaultPort, ILogPort } from '../ports';
import { BUILTIN_CAPABILITIES, type CapabilityDef, type CapabilitySettings, type CapabilityProvider } from '../capabilities';

/**
 * Capability Manager — Provider 해석 + 설정 관리
 *
 * 인프라: IStoragePort, IVaultPort, ILogPort
 */
export class CapabilityManager {
  private dynamicCapabilities: Record<string, CapabilityDef> = {};

  constructor(
    private readonly storage: IStoragePort,
    private readonly vault: IVaultPort,
    private readonly log: ILogPort,
  ) {}

  /** 전체 capability 목록 (빌트인 + 자동 등록) */
  list(): Record<string, CapabilityDef> {
    return { ...BUILTIN_CAPABILITIES, ...this.dynamicCapabilities };
  }

  /** 새 capability 수동 등록 */
  register(id: string, label: string, description: string): void {
    this.dynamicCapabilities[id] = { label, description };
    this.log.info(`[Capability] 등록: ${id} (${label})`);
  }

  /** 모듈 스캔하여 capability별 provider 목록 반환 */
  async getProviders(capId: string): Promise<CapabilityProvider[]> {
    const providers: CapabilityProvider[] = [];

    for (const loc of ['system/modules', 'user/modules'] as const) {
      const location = loc === 'system/modules' ? 'system' : 'user';
      const result = await this.storage.listDir(loc);
      if (!result.success || !result.data) continue;

      for (const entry of result.data) {
        if (!entry.isDirectory) continue;
        const file = await this.storage.read(`${loc}/${entry.name}/config.json`);
        if (!file.success || !file.data) continue;
        try {
          const mod = JSON.parse(file.data);
          if (mod.capability === capId) {
            providers.push({
              moduleName: mod.name || entry.name,
              providerType: mod.providerType || 'local',
              location,
              description: mod.description || '',
            });
            if (!BUILTIN_CAPABILITIES[capId] && !this.dynamicCapabilities[capId]) {
              this.dynamicCapabilities[capId] = { label: capId, description: mod.description || '' };
              this.log.warn(`[Capability] 미등록 capability 자동 등록: ${capId}`);
            }
          }
        } catch {}
      }
    }

    return providers;
  }

  /** 전체 capability별 provider 수 요약 */
  async listWithProviders(): Promise<Array<{ id: string; label: string; description: string; providerCount: number }>> {
    // 모든 모듈 스캔하여 capability 자동 등록
    for (const loc of ['system/modules', 'user/modules']) {
      const result = await this.storage.listDir(loc);
      if (!result.success || !result.data) continue;
      for (const entry of result.data) {
        if (!entry.isDirectory) continue;
        const file = await this.storage.read(`${loc}/${entry.name}/config.json`);
        if (!file.success || !file.data) continue;
        try {
          const mod = JSON.parse(file.data);
          if (mod.capability && !BUILTIN_CAPABILITIES[mod.capability] && !this.dynamicCapabilities[mod.capability]) {
            this.dynamicCapabilities[mod.capability] = { label: mod.capability, description: mod.description || '' };
          }
        } catch {}
      }
    }

    const allCaps = this.list();
    const result: Array<{ id: string; label: string; description: string; providerCount: number }> = [];
    for (const [id, def] of Object.entries(allCaps)) {
      const providers = await this.getProviders(id);
      result.push({ id, label: def.label, description: def.description, providerCount: providers.length });
    }
    return result;
  }

  /** capability 설정 조회 (Vault) */
  getSettings(capId: string): CapabilitySettings {
    const raw = this.vault.getSecret(`system:capability:${capId}:settings`);
    if (!raw) return { providers: [] };
    try { return JSON.parse(raw); } catch { return { providers: [] }; }
  }

  /** capability 설정 저장 (Vault) */
  setSettings(capId: string, settings: CapabilitySettings): boolean {
    return this.vault.setSecret(`system:capability:${capId}:settings`, JSON.stringify(settings));
  }

  /** 설정 기준으로 실행할 provider 선택 — providers 배열 순서대로 시도 */
  async resolve(capId: string): Promise<CapabilityProvider | null> {
    const providers = await this.getProviders(capId);
    if (providers.length === 0) return null;
    if (providers.length === 1) return providers[0];

    const settings = this.getSettings(capId);

    // 사용자 정의 순서가 있으면 그 순서대로 반환
    if (settings.providers.length > 0) {
      for (const name of settings.providers) {
        const found = providers.find(p => p.moduleName === name);
        if (found) return found;
      }
    }

    // 순서 미설정 시 기본: api provider 우선
    return providers.find(p => p.providerType === 'api') ?? providers[0];
  }
}
