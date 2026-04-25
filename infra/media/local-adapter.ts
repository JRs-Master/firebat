/**
 * LocalMediaAdapter — IMediaPort 구현체.
 *
 * 저장소:
 *   - user/media/<slug>.<ext>   — AI 가 유저 요청으로 생성한 블로그·일러스트
 *   - system/media/<slug>.<ext> — Firebat 자체 생성 (OG 캐시·모듈 자산, v2+)
 * 썸네일/variants: 같은 dir 에 <slug>-thumb.webp, <slug>-480w.webp 등 suffix 파일.
 * 공개 URL: /user/media/<filename>, /system/media/<filename> (nginx alias 권장).
 *
 * 네이밍 규칙 (v0.1, 2026-04-24):
 *   YYYY-MM-DD-<hint-slug>-<rand4>.<ext>
 *   - hint 있으면: 2026-04-24-samsung-hero-1c19.png
 *   - hint 없으면: 2026-04-24-1c19.png (짧은 날짜+랜덤)
 *   - 한국어 hint 허용 (파일시스템·브라우저 둘 다 UTF-8 지원)
 *
 * 메타데이터: <slug>.json 별도 저장 (variants·prompt·blurhash 등 포함).
 *
 * 후처리: MediaManager 가 호출 전에 이미 variants·thumbnail·blurhash 생성해 넘김.
 * 이 어댑터는 단순 파일 쓰기/읽기 만 담당 (관심사 분리).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  IMediaPort,
  MediaSaveOptions,
  MediaSaveResult,
  MediaFileRecord,
  MediaVariant,
  ILogPort,
} from '../../core/ports';
import type { InfraResult } from '../../core/types';

// scope 별 저장 디렉토리 분리:
const USER_MEDIA_DIR = process.env.FIREBAT_USER_MEDIA_DIR || path.join('user', 'media');
const SYSTEM_MEDIA_DIR = process.env.FIREBAT_SYSTEM_MEDIA_DIR || path.join('system', 'media');
const mediaDir = (scope: 'user' | 'system'): string =>
  scope === 'system' ? SYSTEM_MEDIA_DIR : USER_MEDIA_DIR;

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function extFromContentType(ct: string): string {
  const norm = ct.toLowerCase().split(';')[0].trim();
  return CONTENT_TYPE_EXT[norm] ?? 'bin';
}

function contentTypeFromExt(ext: string): string {
  const norm = ext.toLowerCase().replace(/^\./, '');
  for (const [ct, e] of Object.entries(CONTENT_TYPE_EXT)) {
    if (e === norm) return ct;
  }
  return 'application/octet-stream';
}

/** 날짜 prefix: YYYY-MM-DD (UTC) */
function datePrefix(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** filenameHint 정제 — 특수문자 → '-', 연속 '-' 압축, 앞뒤 '-' 제거, 최대 40자. 한국어 허용. */
function slugifyHint(hint: string): string {
  return hint
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

/** 네이밍 규칙: YYYY-MM-DD-<hint>-<rand4>  또는  YYYY-MM-DD-<rand4> */
function generateSlug(hint?: string): string {
  const date = datePrefix();
  const rand = crypto.randomBytes(2).toString('hex');
  if (hint) {
    const cleaned = slugifyHint(hint);
    if (cleaned) return `${date}-${cleaned}-${rand}`;
  }
  return `${date}-${rand}`;
}

export class LocalMediaAdapter implements IMediaPort {
  constructor(private logger: ILogPort) {
    this.ensureDirs();
  }

  private ensureDirs(): void {
    try { fs.mkdirSync(USER_MEDIA_DIR, { recursive: true }); } catch {}
    try { fs.mkdirSync(SYSTEM_MEDIA_DIR, { recursive: true }); } catch {}
  }

  private slugPath(slug: string, ext: string, scope: 'user' | 'system'): string {
    return path.join(mediaDir(scope), `${slug}.${ext}`);
  }

  private metaPath(slug: string, scope: 'user' | 'system'): string {
    return path.join(mediaDir(scope), `${slug}.json`);
  }

  /** variant·thumbnail 용 suffix 파일 경로 — 예: <slug>-480w.webp, <slug>-thumb.webp */
  private suffixPath(slug: string, suffix: string, ext: string, scope: 'user' | 'system'): string {
    return path.join(mediaDir(scope), `${slug}-${suffix}.${ext}`);
  }

  async save(
    binary: Buffer | Uint8Array,
    contentType: string,
    opts?: MediaSaveOptions,
  ): Promise<InfraResult<MediaSaveResult>> {
    try {
      const scope = opts?.scope ?? 'user';
      const buf = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
      const ext = (opts?.ext ?? extFromContentType(contentType)).replace(/^\./, '');
      const slug = generateSlug(opts?.filenameHint);
      const filePath = this.slugPath(slug, ext, scope);
      await fs.promises.writeFile(filePath, buf);

      const url = `/${scope}/media/${slug}.${ext}`;
      // variants/thumbnail/blurhash 는 MediaManager 에서 sharp 로 별도 생성 후 saveVariant() 로 여기에 기록.
      // 이 save() 는 원본만 쓰고, 메타는 initial 상태로 저장.
      const record: MediaFileRecord = {
        slug,
        ext,
        contentType,
        bytes: buf.length,
        createdAt: Date.now(),
        scope,
        // 원본 binary 가 저장됐으므로 default 'done'. variants 후처리 실패해도 원본은 살아있음.
        status: 'done',
        ...(opts?.filenameHint ? { filenameHint: opts.filenameHint } : {}),
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        ...(opts?.revisedPrompt ? { revisedPrompt: opts.revisedPrompt } : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.size ? { size: opts.size } : {}),
        ...(opts?.quality ? { quality: opts.quality } : {}),
      };
      await fs.promises.writeFile(this.metaPath(slug, scope), JSON.stringify(record, null, 2));

      this.logger.info(`[Media] saved scope=${scope} slug=${slug}.${ext} bytes=${buf.length}${opts?.filenameHint ? ` hint="${opts.filenameHint}"` : ''}`);
      return {
        success: true,
        data: {
          slug,
          url,
          bytes: buf.length,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Media] save 실패: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** variant / thumbnail binary 를 기존 slug 에 연결해 저장. 메타에도 기록. */
  async saveVariant(
    slug: string,
    scope: 'user' | 'system',
    suffix: string,              // 'thumb' | '480w' | '768w' | ...
    format: string,              // 'webp' | 'avif' | ...
    binary: Buffer,
    variantMeta: Omit<MediaVariant, 'url'>,
  ): Promise<InfraResult<string>> {
    try {
      const ext = format === 'jpeg' ? 'jpg' : format;
      const filePath = this.suffixPath(slug, suffix, ext, scope);
      await fs.promises.writeFile(filePath, binary);
      const url = `/${scope}/media/${slug}-${suffix}.${ext}`;
      return { success: true, data: url };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Media] saveVariant 실패: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** 실패 기록 — 원본 binary 없이 메타만 status='error' 로 저장.
   *  ext/contentType/bytes 는 placeholder (재생성 시 실제 값으로 갱신).
   *  사용자가 갤러리에서 prompt 보고 재시도하거나 삭제할 수 있도록 메타 보존. */
  async saveErrorRecord(opts: MediaSaveOptions & { errorMsg: string }): Promise<InfraResult<{ slug: string }>> {
    try {
      const scope = opts.scope ?? 'user';
      const slug = generateSlug(opts.filenameHint);
      const record: MediaFileRecord = {
        slug,
        ext: 'png',          // placeholder — 재생성 시 실제 ext 로 덮어씀
        contentType: 'image/png',
        bytes: 0,
        createdAt: Date.now(),
        scope,
        status: 'error',
        errorMsg: opts.errorMsg,
        ...(opts.filenameHint ? { filenameHint: opts.filenameHint } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.revisedPrompt ? { revisedPrompt: opts.revisedPrompt } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.size ? { size: opts.size } : {}),
        ...(opts.quality ? { quality: opts.quality } : {}),
        ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
        ...(opts.focusPoint ? { focusPoint: opts.focusPoint } : {}),
      };
      await fs.promises.writeFile(this.metaPath(slug, scope), JSON.stringify(record, null, 2));
      this.logger.info(`[Media] error record saved scope=${scope} slug=${slug} reason="${opts.errorMsg.slice(0, 100)}"`);
      return { success: true, data: { slug } };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Media] saveErrorRecord 실패: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** 메타 JSON 업데이트 (variants·thumbnailUrl·blurhash 추가 반영) */
  async updateMeta(slug: string, scope: 'user' | 'system', patch: Partial<MediaFileRecord>): Promise<InfraResult<void>> {
    try {
      const metaBuf = await fs.promises.readFile(this.metaPath(slug, scope), 'utf-8').catch(() => null);
      if (!metaBuf) return { success: false, error: 'meta 파일이 없습니다' };
      const record = JSON.parse(metaBuf) as MediaFileRecord;
      const updated = { ...record, ...patch };
      await fs.promises.writeFile(this.metaPath(slug, scope), JSON.stringify(updated, null, 2));
      return { success: true, data: undefined };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** slug 로 meta JSON 을 두 scope dir 에서 순차 검색. 먼저 찾은 scope 반환. */
  private async findSlug(slug: string): Promise<{ record: MediaFileRecord; scope: 'user' | 'system' } | null> {
    for (const scope of ['user', 'system'] as const) {
      const metaBuf = await fs.promises.readFile(this.metaPath(slug, scope), 'utf-8').catch(() => null);
      if (!metaBuf) continue;
      try {
        const record = JSON.parse(metaBuf) as MediaFileRecord;
        return { record, scope };
      } catch { continue; }
    }
    return null;
  }

  async read(slug: string): Promise<InfraResult<{ binary: Buffer; contentType: string; record: MediaFileRecord } | null>> {
    try {
      if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
        return { success: false, error: '잘못된 slug 형식' };
      }
      // slug 가 variant suffix 포함할 수 있음 — 예: 2026-04-24-samsung-1c19-480w
      // 이 경우 base slug 로 meta 찾기 → 실제 파일 경로는 slug+ext 직접 사용
      const baseSlug = slug.replace(/-(?:\d+w|thumb)$/, '');
      const found = await this.findSlug(baseSlug);
      if (!found) return { success: true, data: null };

      // slug 가 base 면 원본, suffix 있으면 variant 파일
      const isVariant = baseSlug !== slug;
      let filePath: string;
      let contentType: string;
      if (isVariant) {
        // variant 는 webp/avif 일 가능성 → meta.variants 에서 찾기
        const suffix = slug.slice(baseSlug.length + 1); // '480w', 'thumb' 등
        // 확장자 추정: 파일 시스템 glob (간단히 webp·avif·jpg 순서로 시도)
        for (const tryExt of ['webp', 'avif', 'jpg', 'png']) {
          const p = this.suffixPath(baseSlug, suffix, tryExt, found.scope);
          try {
            const binary = await fs.promises.readFile(p);
            return { success: true, data: { binary, contentType: contentTypeFromExt(tryExt), record: found.record } };
          } catch { continue; }
        }
        return { success: true, data: null };
      }
      filePath = this.slugPath(slug, found.record.ext, found.scope);
      contentType = found.record.contentType || contentTypeFromExt(found.record.ext);
      const binary = await fs.promises.readFile(filePath).catch(() => null);
      if (!binary) return { success: true, data: null };
      return { success: true, data: { binary, contentType, record: found.record } };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stat(slug: string): Promise<InfraResult<MediaFileRecord | null>> {
    try {
      if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
        return { success: false, error: '잘못된 slug 형식' };
      }
      const found = await this.findSlug(slug);
      return { success: true, data: found?.record ?? null };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async remove(slug: string): Promise<InfraResult<void>> {
    try {
      if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
        return { success: false, error: '잘못된 slug 형식' };
      }
      const found = await this.findSlug(slug);
      if (!found) return { success: true, data: undefined };
      // 원본 + 모든 variants + 메타 삭제
      await fs.promises.unlink(this.slugPath(slug, found.record.ext, found.scope)).catch(() => {});
      for (const v of found.record.variants ?? []) {
        // v.url 에서 파일명 추출
        const filename = path.basename(v.url);
        const variantPath = path.join(mediaDir(found.scope), filename);
        await fs.promises.unlink(variantPath).catch(() => {});
      }
      if (found.record.thumbnailUrl) {
        const thumbName = path.basename(found.record.thumbnailUrl);
        await fs.promises.unlink(path.join(mediaDir(found.scope), thumbName)).catch(() => {});
      }
      await fs.promises.unlink(this.metaPath(slug, found.scope)).catch(() => {});
      this.logger.info(`[Media] removed scope=${found.scope} slug=${slug} (+${found.record.variants?.length ?? 0} variants)`);
      return { success: true, data: undefined };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 갤러리용 list — scope 기반 전체 meta 스캔 + 최신순 정렬 + 페이징. */
  async list(opts?: { scope?: 'user' | 'system' | 'all'; limit?: number; offset?: number; search?: string }): Promise<InfraResult<{ items: MediaFileRecord[]; total: number }>> {
    try {
      const scopes: Array<'user' | 'system'> = opts?.scope === 'all' || !opts?.scope
        ? ['user', 'system']
        : [opts.scope];
      const all: MediaFileRecord[] = [];
      for (const scope of scopes) {
        const dir = mediaDir(scope);
        if (!fs.existsSync(dir)) continue;
        const files = await fs.promises.readdir(dir);
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const content = await fs.promises.readFile(path.join(dir, f), 'utf-8');
            const record = JSON.parse(content) as MediaFileRecord;
            if (!record.scope) record.scope = scope;
            all.push(record);
          } catch { /* corrupted meta 스킵 */ }
        }
      }
      // 검색 필터 — filenameHint, prompt, model 에서 키워드 매칭
      const filtered = opts?.search
        ? all.filter(r => {
            const q = opts.search!.toLowerCase();
            return (r.filenameHint?.toLowerCase().includes(q)
              || r.prompt?.toLowerCase().includes(q)
              || r.model?.toLowerCase().includes(q)
              || r.slug.toLowerCase().includes(q));
          })
        : all;
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      const total = filtered.length;
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? 50;
      const items = filtered.slice(offset, offset + limit);
      return { success: true, data: { items, total } };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
