import type { IStoragePort, IDatabasePort } from '../ports';
import type { InfraResult } from '../types';

export interface ProjectEntry {
  name: string;
  paths: string[];
  pageSlugs: string[];
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
  ) {}

  /** 프로젝트 목록 스캔 (user/modules + DB pages) */
  async scan(): Promise<ProjectEntry[]> {
    const map: Record<string, { paths: string[]; pageSlugs: string[] }> = {};
    const ensure = (p: string) => { if (!map[p]) map[p] = { paths: [], pageSlugs: [] }; };

    // user/modules/*/module.json 스캔
    const modulesResult = await this.storage.listDir('user/modules');
    if (modulesResult.success && modulesResult.data) {
      for (const entry of modulesResult.data) {
        if (!entry.isDirectory) continue;
        const jsonPath = `user/modules/${entry.name}/module.json`;
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

    return Object.entries(map).map(([name, { paths, pageSlugs }]) => ({ name, paths, pageSlugs }));
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
}
