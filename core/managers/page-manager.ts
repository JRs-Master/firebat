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

  /** 페이지 visibility 설정 */
  async setVisibility(slug: string, visibility: 'public' | 'password' | 'private', password?: string) {
    return this.database.setPageVisibility(slug, visibility, password);
  }

  /** 페이지 비밀번호 검증 */
  async verifyPassword(slug: string, password: string) {
    return this.database.verifyPagePassword(slug, password);
  }

  /** slug 이름 변경 — 리디렉트 옵션. 새 slug 중복 시 실패 반환 */
  async rename(oldSlug: string, newSlug: string, opts: { setRedirect?: boolean } = {}): Promise<InfraResult<{ oldSlug: string; newSlug: string }>> {
    if (!newSlug || !newSlug.trim()) return { success: false, error: '새 slug 가 비어 있습니다.' };
    if (oldSlug === newSlug) return { success: false, error: '기존과 동일한 slug 입니다.' };
    // 허용: 영숫자/한글/하이픈/슬래시. 선행·후행 슬래시·연속 슬래시 금지
    if (/^\/|\/$|\/\//.test(newSlug) || /\s/.test(newSlug)) {
      return { success: false, error: 'slug 형식 오류: 공백·선행/후행/연속 슬래시 금지.' };
    }
    // 중복 검사
    const dup = await this.database.getPage(newSlug);
    if (dup.success && dup.data) return { success: false, error: `이미 존재하는 slug: ${newSlug}` };
    // 기존 페이지 로드
    const cur = await this.database.getPage(oldSlug);
    if (!cur.success || !cur.data) return { success: false, error: `원본 페이지 없음: ${oldSlug}` };
    const specObj = cur.data as unknown as Record<string, unknown>;
    specObj.slug = newSlug;
    // 새 slug 첫 세그먼트 로 project 자동 동기 (있을 때만, 사용자가 project 유지 원하면 수동 수정 가능)
    const firstSegment = newSlug.includes('/') ? newSlug.split('/')[0] : undefined;
    if (firstSegment) specObj.project = firstSegment;
    // 새 slug 로 저장 → 구 slug 삭제 (순서 중요: 실패 시 원본 보존)
    const saveRes = await this.database.savePage(newSlug, JSON.stringify(specObj));
    if (!saveRes.success) return { success: false, error: `저장 실패: ${saveRes.error}` };
    await this.database.deletePage(oldSlug);
    // 리디렉트 등록 (옵션)
    if (opts.setRedirect) {
      await this.database.query(
        `INSERT INTO page_redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?) ON CONFLICT(from_slug) DO UPDATE SET to_slug=excluded.to_slug, created_at=excluded.created_at`,
        [oldSlug, newSlug, Date.now()],
      );
    }
    return { success: true, data: { oldSlug, newSlug } };
  }

  /** 프로젝트 일괄 이름 변경 — project=old 인 모든 페이지의 slug prefix + project 필드 동시 업데이트 */
  async renameProject(oldName: string, newName: string, opts: { setRedirect?: boolean } = {}): Promise<InfraResult<{ renamed: Array<{ oldSlug: string; newSlug: string }> }>> {
    if (!newName || !newName.trim()) return { success: false, error: '새 프로젝트 이름이 비어 있습니다.' };
    if (oldName === newName) return { success: false, error: '기존과 동일한 이름입니다.' };
    if (/[/\s]/.test(newName)) return { success: false, error: '프로젝트명에는 슬래시·공백 금지.' };
    const listRes = await this.database.listPagesByProject(oldName);
    if (!listRes.success) return { success: false, error: listRes.error };
    const slugs = (listRes.data ?? []) as string[];
    const renamed: Array<{ oldSlug: string; newSlug: string }> = [];
    for (const slug of slugs) {
      // slug 첫 세그먼트가 oldName 이면 교체, 아니면 prefix 가 없는 페이지 (flat slug) → 중첩 구조로 전환: newName/slug
      const newSlug = slug.startsWith(`${oldName}/`)
        ? `${newName}/${slug.slice(oldName.length + 1)}`
        : `${newName}/${slug}`;
      const res = await this.rename(slug, newSlug, opts);
      if (res.success && res.data) renamed.push(res.data);
    }
    return { success: true, data: { renamed } };
  }

  /** from_slug → to_slug 리디렉트 조회 (catch-all 라우트에서 사용) */
  async getRedirect(fromSlug: string): Promise<string | null> {
    const res = await this.database.query(
      `SELECT to_slug as toSlug FROM page_redirects WHERE from_slug = ? LIMIT 1`,
      [fromSlug],
    );
    if (!res.success || !res.data || res.data.length === 0) return null;
    return (res.data[0].toSlug as string) ?? null;
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
