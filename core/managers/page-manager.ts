import type { IDatabasePort, IStoragePort } from '../ports';
import type { InfraResult } from '../types';

/**
 * Page Manager — 페이지 CRUD + 정적 페이지 스캔
 *
 * 인프라: IDatabasePort, IStoragePort
 * SSE 발행: 하지 않음 (Core 파사드에서 처리)
 */
export class PageManager {
  constructor(
    private readonly database: IDatabasePort,
    private readonly storage: IStoragePort,
  ) {}

  async list() {
    return this.database.listPages();
  }

  async get(slug: string) {
    return this.database.getPage(slug);
  }

  async save(slug: string, spec: string) {
    return this.database.savePage(slug, spec);
  }

  async delete(slug: string) {
    return this.database.deletePage(slug);
  }

  /** app/(user)/ 하위 정적 페이지 slug 목록 (manifest.json 있는 디렉토리) */
  async listStatic(): Promise<string[]> {
    const result = await this.storage.listDir('app/(user)');
    if (!result.success || !result.data) return [];

    const slugs: string[] = [];
    for (const entry of result.data) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith('[')) continue;
      const manifest = await this.storage.read(`app/(user)/${entry.name}/manifest.json`);
      if (manifest.success) slugs.push(entry.name);
    }
    return slugs;
  }
}
