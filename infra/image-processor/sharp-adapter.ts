/**
 * SharpImageProcessorAdapter — sharp 기반 IImageProcessorPort 구현.
 *
 * sharp: libvips C 라이브러리 Node 바인딩. ImageMagick 대비 4~5배 빠르고 메모리 소비 적음.
 * Next.js 가 내부 최적화에 이미 씀 → 중복 설치 부담 없음.
 *
 * 기능:
 *  - getMetadata: 포맷·크기·알파 채널 등 (png/jpeg/webp/avif 전부 지원)
 *  - process: resize + format convert + quality + progressive + EXIF strip 통합
 *  - blurhash: 32자 내외 Base83 문자열 — 로딩 중 블러 플레이스홀더 (LCP 개선)
 */
import sharp from 'sharp';
import { encode } from 'blurhash';
import type { IImageProcessorPort, ImageMetadata, ResizeOpts } from '../../core/ports';
import type { InfraResult } from '../../core/types';

export class SharpImageProcessorAdapter implements IImageProcessorPort {
  async getMetadata(binary: Buffer | Uint8Array): Promise<InfraResult<ImageMetadata>> {
    try {
      const meta = await sharp(binary as Buffer).metadata();
      if (!meta.width || !meta.height || !meta.format) {
        return { success: false, error: '이미지 메타데이터 파싱 실패' };
      }
      return {
        success: true,
        data: {
          width: meta.width,
          height: meta.height,
          format: meta.format,
          bytes: meta.size ?? (binary as Buffer).length,
          hasAlpha: meta.hasAlpha,
        },
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async process(binary: Buffer | Uint8Array, opts: ResizeOpts): Promise<InfraResult<Buffer>> {
    try {
      let img = sharp(binary as Buffer);

      // EXIF 제거 (strip) — 프라이버시 + 용량
      if (opts.stripMetadata !== false) {
        // sharp 는 기본적으로 metadata 제거. withMetadata() 호출 안 하면 strip 됨.
      }

      // EXIF orientation 자동 회전 — 세로 사진 눕혀 저장되는 문제 방지
      img = img.rotate();

      if (opts.width || opts.height) {
        // position 계산 — sharp.strategy.attention / entropy / gravity / xy
        let positionArg: any = undefined;
        if (opts.position === 'attention') positionArg = sharp.strategy.attention;
        else if (opts.position === 'entropy') positionArg = sharp.strategy.entropy;
        else if (opts.position === 'center') positionArg = 'center';
        else if (opts.position && typeof opts.position === 'object') {
          // sharp 는 relative {x,y} 미지원 → extract 로 수동 crop 후 resize 해야 함.
          // 여기선 간단화: gravity 문자열로 근사 매핑.
          const { x, y } = opts.position;
          const vert = y < 0.33 ? 'top' : y > 0.66 ? 'bottom' : '';
          const horz = x < 0.33 ? 'left' : x > 0.66 ? 'right' : '';
          positionArg = (vert + horz) || 'center';
        }
        img = img.resize({
          width: opts.width,
          height: opts.height,
          fit: opts.fit ?? 'inside',
          withoutEnlargement: true, // 원본보다 크게는 리사이즈 안 함
          ...(positionArg !== undefined ? { position: positionArg } : {}),
        });
      }

      // 포맷 변환
      const quality = opts.quality ?? 85;
      switch (opts.format) {
        case 'webp':
          img = img.webp({ quality, effort: 4 });
          break;
        case 'avif':
          img = img.avif({ quality, effort: 4 });
          break;
        case 'jpeg':
          img = img.jpeg({ quality, progressive: opts.progressive ?? false, mozjpeg: true });
          break;
        case 'png':
          img = img.png({ compressionLevel: 9, progressive: opts.progressive ?? false });
          break;
        // 미지정 시 원본 포맷 유지
      }

      const buffer = await img.toBuffer();
      return { success: true, data: buffer };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async createPlaceholder(width: number, height: number): Promise<InfraResult<Buffer>> {
    try {
      // 단순 회색 사각형 — sharp create 으로 N×N 솔리드 PNG. ~수백 byte.
      // 텍스트는 안 박음 — 폰트 의존 + locale 다국어 회피. 사용자는 갤러리 카드 + reload swap 으로 진행 인지.
      const buf = await sharp({
        create: {
          width: Math.max(1, Math.min(4096, Math.floor(width))),
          height: Math.max(1, Math.min(4096, Math.floor(height))),
          channels: 4,
          background: { r: 230, g: 230, b: 235, alpha: 1 },
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      return { success: true, data: buf };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async blurhash(
    binary: Buffer | Uint8Array,
    components?: { x: number; y: number },
  ): Promise<InfraResult<string>> {
    try {
      // Blurhash 인코딩은 raw RGBA 픽셀 배열 필요 → sharp 로 32x32 raw 추출
      const { data, info } = await sharp(binary as Buffer)
        .resize(32, 32, { fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const cx = components?.x ?? 4;
      const cy = components?.y ?? 4;
      const hash = encode(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        cx,
        cy,
      );
      return { success: true, data: hash };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
