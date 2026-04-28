import type { IStoragePort } from '../ports';
import type { InfraResult } from '../types';

/** 템플릿 spec — 페이지 발행 시 spec.body 의 backbone. */
export interface TemplateConfig {
  /** 사람 친화 이름 (어드민 UI 표시) */
  name: string;
  /** 템플릿 목적·사용 시점 — AI 가 매칭 시 참고 */
  description: string;
  /** 분류 태그 — stock / news / report 등 */
  tags?: string[];
  /** 페이지 spec (head + body). cron-agent 가 이 구조 그대로 spec 으로 사용. */
  spec: {
    head?: Record<string, unknown>;
    body: Array<{ type: string; props: Record<string, unknown> }>;
  };
}

export interface TemplateEntry {
  /** 폴더 이름 (slug) — `user/templates/{slug}/template.json` */
  slug: string;
  /** template.json 의 name 필드 (사람 친화) */
  name: string;
  description: string;
  tags: string[];
}

/**
 * Template Manager — Phase 8b. 사용자 정의 페이지 템플릿 CRUD.
 *
 * 위치: `user/templates/{slug}/template.json`
 * cron-agent 가 prompt 에 템플릿 목록 주입 → AI 가 매칭 시 spec.body 그대로 사용 (일관 발행).
 *
 * 책임:
 *   - storage 위 CRUD (list/get/save/delete)
 *   - 폴더명 slug 검증 (path traversal 차단)
 */
export class TemplateManager {
  constructor(private readonly storage: IStoragePort) {}

  /** 템플릿 목록 조회 — user/templates 스캔. */
  async list(): Promise<TemplateEntry[]> {
    const dirRes = await this.storage.listDir('user/templates');
    if (!dirRes.success || !dirRes.data) return [];
    const entries: TemplateEntry[] = [];
    for (const e of dirRes.data) {
      if (!e.isDirectory) continue;
      const slug = e.name;
      const fileRes = await this.storage.read(`user/templates/${slug}/template.json`);
      if (!fileRes.success || !fileRes.data) continue;
      try {
        const t = JSON.parse(fileRes.data) as Partial<TemplateConfig>;
        if (!t.name) continue;
        entries.push({
          slug,
          name: t.name,
          description: t.description || '',
          tags: Array.isArray(t.tags) ? t.tags : [],
        });
      } catch { /* skip 잘못된 JSON */ }
    }
    return entries;
  }

  /** 템플릿 조회 — config 객체 또는 null. */
  async get(slug: string): Promise<TemplateConfig | null> {
    if (!this.isSafeSlug(slug)) return null;
    const fileRes = await this.storage.read(`user/templates/${slug}/template.json`);
    if (!fileRes.success || !fileRes.data) return null;
    try {
      return JSON.parse(fileRes.data) as TemplateConfig;
    } catch {
      return null;
    }
  }

  /** 템플릿 저장 — upsert. spec 검증 (body 배열 필수). */
  async save(slug: string, config: TemplateConfig): Promise<InfraResult<void>> {
    if (!this.isSafeSlug(slug)) {
      return { success: false, error: '잘못된 템플릿 slug 입니다.' };
    }
    if (!config.name || !config.spec || !Array.isArray(config.spec.body)) {
      return { success: false, error: 'name 과 spec.body (배열) 필수입니다.' };
    }
    const json = JSON.stringify(config, null, 2);
    return this.storage.write(`user/templates/${slug}/template.json`, json);
  }

  /** 템플릿 삭제 — 폴더 통째 제거. */
  async delete(slug: string): Promise<InfraResult<void>> {
    if (!this.isSafeSlug(slug)) {
      return { success: false, error: '잘못된 템플릿 slug 입니다.' };
    }
    return this.storage.delete(`user/templates/${slug}`);
  }

  /** path traversal 차단 — slug 는 영숫자·하이픈·언더스코어만. */
  private isSafeSlug(slug: string): boolean {
    return !!slug && /^[a-zA-Z0-9_-]+$/.test(slug);
  }
}
