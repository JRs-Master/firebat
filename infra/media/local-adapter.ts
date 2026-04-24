/**
 * LocalMediaAdapter — IMediaPort 구현체.
 *
 * 저장소: `user/media/<slug>.<ext>` + 메타데이터 JSON (`<slug>.json` 동일 폴더).
 *  - data/ 는 시스템 영속 (DB, 크론, logs) 전용.
 *  - user/ 는 유저 콘텐츠 영역 (user/modules, user/media 등).
 *  - 이미지는 유저가 AI 로 생성한 콘텐츠 → user/media 가 의미론적으로 적합.
 * 썸네일: `user/media/<slug>-thumb.<ext>` (옵션, sharp 미설치 시 silently skip).
 * 공개 URL: `/media/<slug>.<ext>` 로 서빙 (app/media/[...slug]/route.ts, /api/ 밖).
 *
 * 왜 DB 가 아니라 파일?
 *  - 이미지 바이너리는 DB 에 넣으면 조회 매번 read 비용 + 백업·복원·마이그레이션 부담
 *  - 파일 시스템은 OS 차원 캐싱·압축 혜택 + rsync·S3 동기화 단순
 *  - 메타데이터만 JSON 으로 같이 저장해서 DB 없이도 정보 유지
 *
 * Slug 형식: `<timestamp36>-<random4>` (정렬 가능·짧음·충돌 확률 극히 낮음)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  IMediaPort,
  MediaSaveOptions,
  MediaSaveResult,
  MediaFileRecord,
  ILogPort,
} from '../../core/ports';
import type { InfraResult } from '../../core/types';

// scope 별 저장 디렉토리 분리:
//  - user/media: 유저가 AI 로 만든 콘텐츠 (블로그 헤더·일러스트·썸네일 등)
//  - system/media: Firebat 자체 생성물 (OG 이미지 캐시, 모듈 생성 자산 등)
// env 로 override 가능 (다른 경로 마운트 시 유용).
const USER_MEDIA_DIR = process.env.FIREBAT_USER_MEDIA_DIR || path.join('user', 'media');
const SYSTEM_MEDIA_DIR = process.env.FIREBAT_SYSTEM_MEDIA_DIR || path.join('system', 'media');
const mediaDir = (scope: 'user' | 'system'): string =>
  scope === 'system' ? SYSTEM_MEDIA_DIR : USER_MEDIA_DIR;

/** contentType → 확장자 매핑 (일반적인 이미지 포맷만) */
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

function generateSlug(): string {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(2).toString('hex');
  return `${ts}-${rnd}`;
}

/** PNG 바이트 스트림에서 width/height 파싱 (IHDR chunk, offset 16~23).
 *  JPEG/WEBP 파서는 v2 에서 (sharp 도입과 함께). 지금은 PNG 만. */
function parsePngDimensions(buf: Buffer): { width?: number; height?: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length < 24) return {};
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return {};
  // IHDR starts at offset 8 (4-byte length + 4-byte 'IHDR'), width at 16, height at 20
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

export class LocalMediaAdapter implements IMediaPort {
  constructor(private logger: ILogPort) {
    this.ensureDirs();
  }

  private ensureDirs(): void {
    try { fs.mkdirSync(USER_MEDIA_DIR, { recursive: true }); } catch { /* 이미 존재 */ }
    try { fs.mkdirSync(SYSTEM_MEDIA_DIR, { recursive: true }); } catch { /* 이미 존재 */ }
  }

  private slugPath(slug: string, ext: string, scope: 'user' | 'system'): string {
    return path.join(mediaDir(scope), `${slug}.${ext}`);
  }

  private metaPath(slug: string, scope: 'user' | 'system'): string {
    return path.join(mediaDir(scope), `${slug}.json`);
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
      const slug = generateSlug();
      const filePath = this.slugPath(slug, ext, scope);
      await fs.promises.writeFile(filePath, buf);

      // PNG 면 크기 파싱 (v2 에서 sharp 로 포맷 무관하게 확장 가능)
      const dims = ext === 'png' ? parsePngDimensions(buf) : {};

      const record: MediaFileRecord = {
        slug,
        ext,
        contentType,
        bytes: buf.length,
        createdAt: Date.now(),
        scope,
      };
      await fs.promises.writeFile(this.metaPath(slug, scope), JSON.stringify(record, null, 2));

      // URL 을 파일 경로와 1:1 매핑 — /user/media/<slug>.ext 또는 /system/media/<slug>.ext.
      // nginx 가 location /user/media/ 는 alias /root/firebat/user/media/ 로 단순 매핑.
      const url = `/${scope}/media/${slug}.${ext}`;
      // 썸네일: v1 에선 sharp 미도입 → 옵션 들어와도 silently skip (TODO)
      const thumbnailUrl: string | undefined = undefined;

      this.logger.info(`[Media] saved scope=${scope} slug=${slug}.${ext} bytes=${buf.length}${opts?.originalName ? ` (${opts.originalName})` : ''}`);
      return {
        success: true,
        data: {
          slug,
          url,
          thumbnailUrl,
          bytes: buf.length,
          ...(dims.width ? { width: dims.width } : {}),
          ...(dims.height ? { height: dims.height } : {}),
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Media] save 실패: ${msg}`);
      return { success: false, error: msg };
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
      const found = await this.findSlug(slug);
      if (!found) return { success: true, data: null };
      const binary = await fs.promises.readFile(this.slugPath(slug, found.record.ext, found.scope)).catch(() => null);
      if (!binary) return { success: true, data: null };
      return { success: true, data: { binary, contentType: found.record.contentType || contentTypeFromExt(found.record.ext), record: found.record } };
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
      await fs.promises.unlink(this.slugPath(slug, found.record.ext, found.scope)).catch(() => {});
      await fs.promises.unlink(this.metaPath(slug, found.scope)).catch(() => {});
      // 썸네일 (있으면) — v2 정리
      this.logger.info(`[Media] removed scope=${found.scope} slug=${slug}`);
      return { success: true, data: undefined };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
