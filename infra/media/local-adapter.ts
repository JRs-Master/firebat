/**
 * LocalMediaAdapter — IMediaPort 구현체.
 *
 * 저장소: `data/media/<slug>.<ext>` + 메타데이터 JSON (`<slug>.json` 동일 폴더).
 * 썸네일: `data/media/<slug>-thumb.<ext>` (옵션, sharp 미설치 시 silently skip).
 * 공개 URL: `/api/media/<slug>.<ext>` 로 서빙 (route 가 slug 파싱 → this.read).
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
import { DATA_DIR } from '../config';

const MEDIA_DIR = path.join(DATA_DIR, 'media');

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
    this.ensureDir();
  }

  private ensureDir(): void {
    try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* 이미 존재 */ }
  }

  private slugPath(slug: string, ext: string): string {
    return path.join(MEDIA_DIR, `${slug}.${ext}`);
  }

  private metaPath(slug: string): string {
    return path.join(MEDIA_DIR, `${slug}.json`);
  }

  async save(
    binary: Buffer | Uint8Array,
    contentType: string,
    opts?: MediaSaveOptions,
  ): Promise<InfraResult<MediaSaveResult>> {
    try {
      const buf = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
      const ext = (opts?.ext ?? extFromContentType(contentType)).replace(/^\./, '');
      const slug = generateSlug();
      const filePath = this.slugPath(slug, ext);
      await fs.promises.writeFile(filePath, buf);

      // PNG 면 크기 파싱 (v2 에서 sharp 로 포맷 무관하게 확장 가능)
      const dims = ext === 'png' ? parsePngDimensions(buf) : {};

      const record: MediaFileRecord = {
        slug,
        ext,
        contentType,
        bytes: buf.length,
        createdAt: Date.now(),
      };
      await fs.promises.writeFile(this.metaPath(slug), JSON.stringify(record, null, 2));

      const url = `/api/media/${slug}.${ext}`;
      // 썸네일: v1 에선 sharp 미도입 → 옵션 들어와도 silently skip (TODO)
      const thumbnailUrl: string | undefined = undefined;

      this.logger.info(`[Media] saved slug=${slug}.${ext} bytes=${buf.length}${opts?.originalName ? ` (${opts.originalName})` : ''}`);
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

  async read(slug: string): Promise<InfraResult<{ binary: Buffer; contentType: string; record: MediaFileRecord } | null>> {
    try {
      // slug 안에 경로 구분자 차단 (디렉토리 순회 방지)
      if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
        return { success: false, error: '잘못된 slug 형식' };
      }
      const metaBuf = await fs.promises.readFile(this.metaPath(slug), 'utf-8').catch(() => null);
      if (!metaBuf) return { success: true, data: null };
      const record = JSON.parse(metaBuf) as MediaFileRecord;
      const binary = await fs.promises.readFile(this.slugPath(slug, record.ext)).catch(() => null);
      if (!binary) return { success: true, data: null };
      return { success: true, data: { binary, contentType: record.contentType || contentTypeFromExt(record.ext), record } };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stat(slug: string): Promise<InfraResult<MediaFileRecord | null>> {
    try {
      if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
        return { success: false, error: '잘못된 slug 형식' };
      }
      const metaBuf = await fs.promises.readFile(this.metaPath(slug), 'utf-8').catch(() => null);
      if (!metaBuf) return { success: true, data: null };
      return { success: true, data: JSON.parse(metaBuf) as MediaFileRecord };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async remove(slug: string): Promise<InfraResult<void>> {
    try {
      if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
        return { success: false, error: '잘못된 slug 형식' };
      }
      const stat = await this.stat(slug);
      if (!stat.success || !stat.data) return { success: true, data: undefined };
      const ext = stat.data.ext;
      await fs.promises.unlink(this.slugPath(slug, ext)).catch(() => {});
      await fs.promises.unlink(this.metaPath(slug)).catch(() => {});
      // 썸네일 (있으면) — v2 정리
      this.logger.info(`[Media] removed slug=${slug}`);
      return { success: true, data: undefined };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
