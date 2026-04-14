import type { ISandboxPort, IStoragePort, IVaultPort } from '../ports';
import type { InfraResult } from '../types';

interface SystemModule {
  name: string;
  description: string;
  runtime: string;
}

/**
 * Module Manager — 모듈 실행 + 시스템 모듈 관리
 *
 * 인프라: ISandboxPort, IStoragePort, IVaultPort
 */
export class ModuleManager {
  constructor(
    private readonly sandbox: ISandboxPort,
    private readonly storage: IStoragePort,
    private readonly vault: IVaultPort,
  ) {}

  /** 경로 지정 직접 실행 (TEST_RUN, 파이프라인 등) */
  async execute(targetPath: string, inputData: any): Promise<InfraResult<any>> {
    return this.sandbox.execute(targetPath, inputData);
  }

  /** 모듈명으로 실행 — 엔트리 파일 자동 탐색 (Form bindModule 전용) */
  async run(moduleName: string, inputData: any): Promise<InfraResult<any>> {
    if (moduleName.includes('..') || moduleName.includes('/') || moduleName.includes('\\')) {
      return { success: false, error: '잘못된 모듈 이름입니다.' };
    }

    const dirResult = await this.storage.listDir(`user/modules/${moduleName}`);
    if (!dirResult.success || !dirResult.data) {
      return { success: false, error: `모듈을 찾을 수 없습니다: ${moduleName}` };
    }

    const entries = ['main.py', 'index.js', 'index.mjs', 'main.php', 'main.sh'];
    const files = dirResult.data.filter(e => !e.isDirectory).map(e => e.name);
    const entry = entries.find(e => files.includes(e));
    if (!entry) {
      return { success: false, error: '모듈 엔트리 파일을 찾을 수 없습니다.' };
    }

    return this.sandbox.execute(`user/modules/${moduleName}/${entry}`, inputData);
  }

  /** system/modules/ 목록 조회 */
  async listSystem(): Promise<SystemModule[]> {
    const result = await this.storage.listDir('system/modules');
    if (!result.success || !result.data) return [];

    const modules: SystemModule[] = [];
    for (const entry of result.data) {
      if (!entry.isDirectory) continue;
      const file = await this.storage.read(`system/modules/${entry.name}/module.json`);
      if (!file.success || !file.data) continue;
      try {
        const parsed = JSON.parse(file.data);
        modules.push({
          name: parsed.name || entry.name,
          description: parsed.description || '',
          runtime: parsed.runtime || '',
        });
      } catch {}
    }
    return modules;
  }

  /** 시스템 모듈 설정 조회 */
  getSettings(moduleName: string): Record<string, any> {
    const raw = this.vault.getSecret(`system:module:${moduleName}:settings`);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  /** 시스템 모듈 설정 저장 */
  setSettings(moduleName: string, settings: Record<string, any>): boolean {
    return this.vault.setSecret(`system:module:${moduleName}:settings`, JSON.stringify(settings));
  }

  /** SEO 모듈 설정 조회 (편의 메서드) */
  getSeoSettings(): {
    sitemapEnabled: boolean;
    rssEnabled: boolean;
    robotsTxt: string;
    headScripts: string;
    bodyScripts: string;
    siteTitle: string;
    siteDescription: string;
  } {
    const s = this.getSettings('seo');
    return {
      sitemapEnabled: s.sitemapEnabled ?? true,
      rssEnabled: s.rssEnabled ?? false,
      robotsTxt: s.robotsTxt ?? 'User-agent: *\nAllow: /',
      headScripts: s.headScripts ?? '',
      bodyScripts: s.bodyScripts ?? '',
      siteTitle: s.siteTitle ?? 'Firebat',
      siteDescription: s.siteDescription ?? 'Firebat',
    };
  }
}
