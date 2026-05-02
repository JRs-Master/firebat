import type { IDatabasePort, IStoragePort } from '../ports';
import type { InfraResult } from '../types';
import { parseMediaUrl } from '../../lib/media-url';

/** 사용처 1건 — 갤러리 모달·삭제 confirm 에서 사용 */
export interface MediaUsageEntry {
  pageSlug: string;
  usedAt: number;
}

/**
 * Page Manager — 페이지 CRUD + 정적 페이지 스캔 + 미디어 사용처 인덱스
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

  /** 검색 — title/description/project/본문 텍스트 매칭. private 페이지 제외. */
  async search(query: string, limit?: number) {
    return this.database.searchPages(query, limit);
  }

  async get(slug: string) {
    return this.database.getPage(slug);
  }

  /** 저장 — PageSpec 안 미디어 src 추출 → media_usage 인덱스 동기 갱신.
   *  spec 파싱 실패해도 페이지 저장은 진행 (인덱스만 못 만듦). */
  async save(slug: string, spec: string) {
    const res = await this.database.savePage(slug, spec);
    if (res.success) {
      // 일반 로직: 어떤 PageSpec 구조든 'src' 같은 미디어 URL 필드 자동 추출.
      // src/url 키가 미디어 URL 패턴이면 추출 — 도메인별 분기 X.
      const slugs = this.extractMediaSlugsFromSpec(spec);
      await this.syncMediaUsage(slug, slugs).catch(() => undefined);
    }
    return res;
  }

  /** 삭제 — media_usage 에서 해당 페이지의 사용 관계 일괄 정리 */
  async delete(slug: string) {
    const res = await this.database.deletePage(slug);
    if (res.success) {
      await this.database.query('DELETE FROM media_usage WHERE page_slug = ?', [slug]).catch(() => undefined);
    }
    return res;
  }

  /** PageSpec JSON 문자열에서 미디어 slug 추출 — 모든 string value 를 walk 하면서 parseMediaUrl 호출.
   *  도구별 enumerate 가 아닌 일반 패턴 매칭 (Image src, Card image, Hero image, Html 안 src 등 모두 인식). */
  private extractMediaSlugsFromSpec(spec: string): Set<string> {
    const found = new Set<string>();
    let parsed: unknown;
    try { parsed = JSON.parse(spec); } catch { return found; }
    const seen = new WeakSet<object>();
    const walk = (v: unknown) => {
      if (v === null || v === undefined) return;
      if (typeof v === 'string') {
        const p = parseMediaUrl(v);
        if (p) found.add(p.slug);
        return;
      }
      if (typeof v !== 'object') return;
      if (seen.has(v as object)) return;
      seen.add(v as object);
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    };
    walk(parsed);
    // HTML 안의 <img src="..."> 같은 케이스도 잡기 — 위 walk 이 string 단위로 parseMediaUrl 통과시키지만
    // string 안에 여러 URL 포함되면 miss. 보강: 정규식으로 추가 추출.
    const URL_RE = /\/(user|system)\/media\/([A-Za-z0-9가-힣\-_]+)(?:-(?:thumb|full|\d+w))?\.([a-zA-Z0-9]+)/g;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(spec)) !== null) {
      // 변형 suffix 제외한 raw slug 만 추가
      found.add(m[2]);
    }
    return found;
  }

  /** 페이지의 사용처 set 을 새 set 으로 동기화 — 추가/삭제 자동 반영 */
  private async syncMediaUsage(pageSlug: string, mediaSlugs: Set<string>): Promise<void> {
    const now = Date.now();
    // 기존 사용처 삭제
    await this.database.query('DELETE FROM media_usage WHERE page_slug = ?', [pageSlug]);
    // 새 사용처 일괄 insert
    for (const ms of mediaSlugs) {
      await this.database.query(
        'INSERT OR REPLACE INTO media_usage (media_slug, page_slug, used_at) VALUES (?, ?, ?)',
        [ms, pageSlug, now],
      );
    }
  }

  /** 미디어 slug 의 사용처 (페이지 목록) 조회. 갤러리 삭제 confirm·메타 표시에 사용. */
  async findMediaUsage(mediaSlug: string): Promise<MediaUsageEntry[]> {
    const res = await this.database.query(
      'SELECT page_slug as pageSlug, used_at as usedAt FROM media_usage WHERE media_slug = ? ORDER BY used_at DESC',
      [mediaSlug],
    );
    if (!res.success || !res.data) return [];
    return (res.data as Array<{ pageSlug: string; usedAt: number }>).map(r => ({
      pageSlug: r.pageSlug,
      usedAt: r.usedAt,
    }));
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
    // 자동 정규화: 공백·선행/후행/연속 슬래시 제거 (클라이언트 편의)
    newSlug = (newSlug ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
    if (!newSlug) return { success: false, error: '새 slug 가 비어 있습니다.' };
    if (oldSlug === newSlug) return { success: false, error: '기존과 동일한 slug 입니다.' };
    if (/\s/.test(newSlug)) {
      return { success: false, error: 'slug 에 공백을 넣을 수 없습니다.' };
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
    // 새 slug 로 저장 → 구 slug 삭제 (순서 중요: 실패 시 원본 보존).
    // this.save / this.delete 경유 — media_usage 인덱스 동기화 자동 처리.
    const saveRes = await this.save(newSlug, JSON.stringify(specObj));
    if (!saveRes.success) return { success: false, error: `저장 실패: ${saveRes.error}` };
    await this.delete(oldSlug);
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
