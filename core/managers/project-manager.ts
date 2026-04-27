import type { IStoragePort, IDatabasePort, IVaultPort } from '../ports';
import type { InfraResult } from '../types';
import { vkProjectVisibility, vkProjectPassword } from '../vault-keys';

export type ProjectVisibility = 'public' | 'password' | 'private';

export interface ProjectEntry {
  name: string;
  paths: string[];
  pageSlugs: string[];
  visibility?: ProjectVisibility;
}

/**
 * Project Manager — 프로젝트 스캔 + 일괄 삭제
 *
 * 인프라: IStoragePort, IDatabasePort
 * SSE 발행: 하지 않음 (Core 파사드에서 처리)
 */
export class ProjectManager {
  constructor(
    private readonly storage: IStoragePort,
    private readonly database: IDatabasePort,
    private readonly vault: IVaultPort,
  ) {}

  /** 프로젝트 목록 스캔 (user/modules + DB pages) */
  async scan(): Promise<ProjectEntry[]> {
    const map: Record<string, { paths: string[]; pageSlugs: string[] }> = {};
    const ensure = (p: string) => { if (!map[p]) map[p] = { paths: [], pageSlugs: [] }; };

    // user/modules/*/config.json 스캔
    const modulesResult = await this.storage.listDir('user/modules');
    if (modulesResult.success && modulesResult.data) {
      for (const entry of modulesResult.data) {
        if (!entry.isDirectory) continue;
        const jsonPath = `user/modules/${entry.name}/config.json`;
        const fileResult = await this.storage.read(jsonPath);
        if (!fileResult.success || !fileResult.data) continue;
        try {
          const { project } = JSON.parse(fileResult.data);
          if (project) { ensure(project); map[project].paths.push(`user/modules/${entry.name}`); }
        } catch {}
      }
    }

    // app/(user)/*/manifest.json 스캔 (기존 정적 페이지)
    const pagesResult = await this.storage.listDir('app/(user)');
    if (pagesResult.success && pagesResult.data) {
      for (const entry of pagesResult.data) {
        if (!entry.isDirectory) continue;
        const jsonPath = `app/(user)/${entry.name}/manifest.json`;
        const fileResult = await this.storage.read(jsonPath);
        if (!fileResult.success || !fileResult.data) continue;
        try {
          const { project } = JSON.parse(fileResult.data);
          if (project) { ensure(project); map[project].paths.push(`app/(user)/${entry.name}`); }
        } catch {}
      }
    }

    // DB pages에서 project 필드 스캔
    const dbPages = await this.database.listPages();
    if (dbPages.success && dbPages.data) {
      for (const page of dbPages.data) {
        if (page.project) { ensure(page.project); map[page.project].pageSlugs.push(page.slug); }
      }
    }

    return Object.entries(map).map(([name, { paths, pageSlugs }]) => ({
      name, paths, pageSlugs,
      visibility: this.getVisibility(name),
    }));
  }

  /** 프로젝트 일괄 삭제 */
  async delete(project: string): Promise<InfraResult<{ paths: string[]; pages: string[] }>> {
    const projects = await this.scan();
    const entry = projects.find(p => p.name === project);
    if (!entry || (entry.paths.length === 0 && entry.pageSlugs.length === 0)) {
      return { success: false, error: '해당 프로젝트를 찾을 수 없습니다.' };
    }

    for (const p of entry.paths) {
      await this.storage.delete(p);
    }

    let deletedPages: string[] = [];
    if (entry.pageSlugs.length > 0) {
      const res = await this.database.deletePagesByProject(project);
      if (res.success && res.data) deletedPages = res.data;
    }

    return { success: true, data: { paths: entry.paths, pages: deletedPages } };
  }

  /** 프로젝트 visibility 조회 */
  getVisibility(project: string): ProjectVisibility {
    const raw = this.vault.getSecret(vkProjectVisibility(project));
    if (raw === 'private' || raw === 'password') return raw;
    return 'public';
  }

  /** 프로젝트 visibility 설정 */
  setVisibility(project: string, visibility: ProjectVisibility, password?: string): boolean {
    this.vault.setSecret(vkProjectVisibility(project), visibility);
    if (visibility === 'password' && password) {
      this.vault.setSecret(vkProjectPassword(project), password);
    } else {
      this.vault.deleteSecret(vkProjectPassword(project));
    }
    return true;
  }

  /** 프로젝트 비밀번호 검증 */
  verifyPassword(project: string, password: string): boolean {
    const stored = this.vault.getSecret(vkProjectPassword(project));
    return stored === password;
  }

  /** 프로젝트 설정 조회 — `user/projects/{name}/config.json` 의 theme override / customCss / layoutOverride 등.
   *  미존재 시 null. CMS Phase 3 — 프로젝트별 디자인 override. 페이지 spec.project 가 이 name 과 매칭되면 적용.
   *
   *  config.json 스키마:
   *    {
   *      "theme": { ... Partial<DesignTokens> ... },     // 글로벌 CMS theme 위에 override
   *      "customCss": "...",                              // 프로젝트 페이지에만 적용되는 CSS
   *      "layoutOverride": { ... }                        // Phase 4 layout 토큰 override (sidebar 위치 등)
   *    }
   */
  async getProjectConfig(name: string): Promise<Record<string, unknown> | null> {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
    const file = await this.storage.read(`user/projects/${name}/config.json`);
    if (!file.success || !file.data) return null;
    try {
      return JSON.parse(file.data);
    } catch {
      return null;
    }
  }

  /** 프로젝트 설정 저장 — config.json upsert. 어드민 UI 에서 호출. */
  async setProjectConfig(name: string, config: Record<string, unknown>): Promise<InfraResult<void>> {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      return { success: false, error: '잘못된 프로젝트 이름입니다.' };
    }
    const json = JSON.stringify(config, null, 2);
    return this.storage.write(`user/projects/${name}/config.json`, json);
  }
}
