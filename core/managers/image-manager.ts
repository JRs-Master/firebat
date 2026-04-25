/**
 * ImageManager — AI 이미지 생성 오케스트레이션 + 후처리 파이프라인.
 *
 * 흐름:
 *  1. Vault 에서 선택된 모델 ID 조회 (기본 provider)
 *  2. IImageGenPort → binary 생성
 *  3. IMediaPort.save 로 원본 저장
 *  4. SEO 이미지 설정 읽어서 SharpImageProcessorAdapter 로 variants·thumbnail·blurhash 생성
 *  5. IMediaPort.saveVariant 로 각 variant 저장
 *  6. IMediaPort.updateMeta 로 variants[] + thumbnailUrl + blurhash + width/height 반영
 *  7. 결과 {url, thumbnailUrl, variants, blurhash, ...} 반환 → render_image 에 바로 전달
 *
 * SEO 이미지 설정 (system:module:seo:settings 의 image 섹션):
 *   webp, avif, thumbnail, variants[], blurhash, stripExif, progressive, defaultQuality, keepOriginal
 *   미설정 시 합리적 기본값으로 동작.
 */
import type {
  IImageGenPort,
  IMediaPort,
  IImageProcessorPort,
  IVaultPort,
  ILogPort,
  ImageGenOpts,
  ImageModelInfo,
  MediaVariant,
} from '../ports';
import type { InfraResult } from '../types';
import { vkModuleSettings } from '../vault-keys';

const VK_IMAGE_MODEL = 'system:image-model';
const VK_IMAGE_SIZE = 'system:image-size';
const VK_IMAGE_QUALITY = 'system:image-quality';

export interface SeoImageSettings {
  /** WebP variant 생성 — 대부분 브라우저 지원, 원본보다 25~35% 작음 */
  webp: boolean;
  /** AVIF variant 생성 — 최신 포맷, WebP 보다 20% 더 작음. 구형 브라우저 미지원 */
  avif: boolean;
  /** 썸네일 256px 생성 */
  thumbnail: boolean;
  /** 반응형 variants 의 width 목록 — 각 width 마다 webp/avif 쌍 생성 */
  variants: number[];
  /** blurhash LQIP (Low-Quality Image Placeholder) 생성 — 로딩 중 부드러운 블러 표시 */
  blurhash: boolean;
  /** EXIF 등 메타데이터 제거 — 프라이버시 + 용량 */
  stripExif: boolean;
  /** progressive encoding (JPEG/WebP) — 느린 네트워크에서 점진 표시 */
  progressive: boolean;
  /** 기본 품질 (1~100) — WebP/AVIF/JPEG */
  defaultQuality: number;
  /** 원본 파일 유지 여부. false 면 variants 만 보관 (용량 절약, PNG→WebP 손실) */
  keepOriginal: boolean;
}

const DEFAULT_IMAGE_SETTINGS: SeoImageSettings = {
  webp: true,
  avif: true,
  thumbnail: true,
  variants: [480, 768, 1024],
  blurhash: true,
  stripExif: true,
  progressive: true,
  defaultQuality: 85,
  keepOriginal: true,
};

export interface GenerateImageInput extends ImageGenOpts {
  /** 저장 시 파일명 힌트 (네이밍 규칙에 반영). 예: "blog-hero-samsung" */
  filenameHint?: string;
  /** 저장 scope — 'user' (AI 생성 기본) / 'system' (Firebat 내부용) */
  scope?: 'user' | 'system';
  /** Aspect ratio crop — "16:9" / "1:1" / "4:5" / "3:2" 등.
   *  지정 시 sharp 가 focusPoint 전략으로 해당 비율로 잘라냄. 미지정 시 원본 비율 유지. */
  aspectRatio?: string;
  /** Crop 전략 — 기본 'attention' (인물·제품 자동 감지).
   *  {x, y} 수동 좌표 (0~1 상대) 도 가능. */
  focusPoint?: 'attention' | 'entropy' | 'center' | { x: number; y: number };
}

/** "16:9" → [16, 9] / 잘못된 포맷은 null */
function parseAspectRatio(s: string): [number, number] | null {
  const m = s.match(/^\s*(\d+)\s*:\s*(\d+)\s*$/);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return [w, h];
}

/** 원본 치수에 target ratio 적용해서 crop 후 새 치수 계산 (한 축 고정, 다른 축만 깎음) */
function computeCropDims(origW: number, origH: number, rw: number, rh: number): { width: number; height: number } {
  const origRatio = origW / origH;
  const targetRatio = rw / rh;
  if (origRatio > targetRatio) {
    // 원본이 더 가로로 넓음 → height 기준으로 width 깎기
    return { width: Math.round(origH * targetRatio), height: origH };
  }
  // 원본이 더 세로로 김 → width 기준으로 height 깎기
  return { width: origW, height: Math.round(origW / targetRatio) };
}

export interface GenerateImageResult {
  url: string;
  thumbnailUrl?: string;
  variants?: MediaVariant[];
  blurhash?: string;
  width?: number;
  height?: number;
  slug: string;
  revisedPrompt?: string;
  modelId: string;
  /** crop 이 적용된 경우 실제 저장된 aspect ratio */
  aspectRatio?: string;
}

export class ImageManager {
  constructor(
    private imageGen: IImageGenPort,
    private media: IMediaPort,
    private processor: IImageProcessorPort,
    private vault: IVaultPort,
    private logger: ILogPort,
  ) {}

  getModel(): string {
    const stored = this.vault.getSecret(VK_IMAGE_MODEL);
    if (stored) return stored;
    return this.imageGen.getModelId();
  }

  setModel(modelId: string): InfraResult<void> {
    const ok = this.vault.setSecret(VK_IMAGE_MODEL, modelId);
    return ok ? { success: true, data: undefined } : { success: false, error: 'Vault 저장 실패' };
  }

  getDefaultSize(): string | null {
    return this.vault.getSecret(VK_IMAGE_SIZE);
  }
  setDefaultSize(size: string | null): InfraResult<void> {
    const ok = size === null
      ? this.vault.deleteSecret(VK_IMAGE_SIZE)
      : this.vault.setSecret(VK_IMAGE_SIZE, size);
    return ok ? { success: true, data: undefined } : { success: false, error: 'Vault 저장 실패' };
  }
  getDefaultQuality(): string | null {
    return this.vault.getSecret(VK_IMAGE_QUALITY);
  }
  setDefaultQuality(quality: string | null): InfraResult<void> {
    const ok = quality === null
      ? this.vault.deleteSecret(VK_IMAGE_QUALITY)
      : this.vault.setSecret(VK_IMAGE_QUALITY, quality);
    return ok ? { success: true, data: undefined } : { success: false, error: 'Vault 저장 실패' };
  }

  listModels(): ImageModelInfo[] {
    return this.imageGen.listModels();
  }

  /** SEO 설정의 image_* 필드 읽기 — system:module:seo:settings 에 flat 저장.
   *  설정 UI 는 SystemModuleSettings 의 '이미지' 탭에서 관리 (imageWebp, imageAvif 등 key 네이밍). */
  getImageSettings(): SeoImageSettings {
    const raw = this.vault.getSecret(vkModuleSettings('seo'));
    if (!raw) return { ...DEFAULT_IMAGE_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const parseVariants = (v: unknown): number[] => {
        if (Array.isArray(v)) {
          return v.map(x => Number(x)).filter(n => Number.isFinite(n) && n > 0);
        }
        if (typeof v === 'string') {
          return v.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
        }
        return [];
      };
      const variants = parseVariants(parsed.imageVariants);
      return {
        webp: parsed.imageWebp as boolean ?? DEFAULT_IMAGE_SETTINGS.webp,
        avif: parsed.imageAvif as boolean ?? DEFAULT_IMAGE_SETTINGS.avif,
        thumbnail: parsed.imageThumbnail as boolean ?? DEFAULT_IMAGE_SETTINGS.thumbnail,
        variants: variants.length > 0 ? variants : DEFAULT_IMAGE_SETTINGS.variants,
        blurhash: parsed.imageBlurhash as boolean ?? DEFAULT_IMAGE_SETTINGS.blurhash,
        stripExif: parsed.imageStripExif as boolean ?? DEFAULT_IMAGE_SETTINGS.stripExif,
        progressive: parsed.imageProgressive as boolean ?? DEFAULT_IMAGE_SETTINGS.progressive,
        defaultQuality: typeof parsed.imageDefaultQuality === 'number'
          ? parsed.imageDefaultQuality
          : typeof parsed.imageDefaultQuality === 'string' && parsed.imageDefaultQuality
            ? Number(parsed.imageDefaultQuality) || DEFAULT_IMAGE_SETTINGS.defaultQuality
            : DEFAULT_IMAGE_SETTINGS.defaultQuality,
        keepOriginal: parsed.imageKeepOriginal as boolean ?? DEFAULT_IMAGE_SETTINGS.keepOriginal,
      };
    } catch {
      return { ...DEFAULT_IMAGE_SETTINGS };
    }
  }

  async generate(
    input: GenerateImageInput,
    opts?: { corrId?: string; onProgress?: (progress: number, message: string) => void },
  ): Promise<InfraResult<GenerateImageResult>> {
    const startedAt = Date.now();
    const corrId = opts?.corrId;
    const onProgress = opts?.onProgress;
    const modelId = input.model ?? this.getModel();
    const scope = input.scope ?? 'user';
    const settings = this.getImageSettings();
    const log = (msg: string) => this.logger.info(`[ImageManager]${corrId ? ` [${corrId}]` : ''} [${modelId}] ${msg}`);

    // 사용자 명령이 우선, 없으면 설정된 기본값 폴백 — 둘 다 없으면 핸들러 기본값 사용
    const size = input.size ?? this.getDefaultSize() ?? undefined;
    const quality = input.quality ?? this.getDefaultQuality() ?? undefined;
    log(`generate 시작: prompt=${input.prompt.slice(0, 100)}${input.prompt.length > 100 ? '…' : ''} size=${size ?? 'handler-default'} quality=${quality ?? 'handler-default'}`);

    // 진행도 보고 — Core 가 StatusManager 와 연결. ImageManager 는 콜백 호출만.
    onProgress?.(0.05, '이미지 생성 시작...');

    // 1) 이미지 생성
    const genRes = await this.imageGen.generate({ ...input, size, quality, model: modelId }, { corrId, model: modelId });
    if (!genRes.success || !genRes.data) {
      const errorMsg = genRes.error || '이미지 생성 실패';
      this.logger.error(`[ImageManager]${corrId ? ` [${corrId}]` : ''} [${modelId}] 생성 실패: ${errorMsg}`);
      // 실패도 갤러리에 기록 — 사용자가 prompt 보고 재시도하거나 삭제 가능.
      // 메타만 status='error' 로 저장 (binary 없음).
      await this.media.saveErrorRecord({
        filenameHint: input.filenameHint,
        scope,
        prompt: input.prompt,
        model: modelId,
        size,
        quality,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.focusPoint ? { focusPoint: input.focusPoint } : {}),
        errorMsg,
      });
      return { success: false, error: errorMsg };
    }
    const genResult = genRes.data;
    const genMs = Date.now() - startedAt;
    log(`binary 수신 (${genMs}ms, ${genResult.binary.length} bytes, ${genResult.contentType})`);
    onProgress?.(0.55, `이미지 받음 (${(genMs / 1000).toFixed(0)}초). 후처리 중...`);

    // 1.5) aspectRatio 지정 시 attention crop 으로 base binary 교체
    //  - 이후 모든 variants/thumbnail/blurhash 가 cropped base 에서 파생되어 일관성 유지
    //  - source 가 이미 타겟 비율과 거의 같으면 (epsilon 0.01) skip
    let baseBinary: Buffer = Buffer.isBuffer(genResult.binary) ? genResult.binary : Buffer.from(genResult.binary);
    let baseContentType = genResult.contentType;
    let appliedAspectRatio: string | undefined;
    const focusPoint = input.focusPoint ?? 'attention';
    if (input.aspectRatio) {
      const parsed = parseAspectRatio(input.aspectRatio);
      if (!parsed) {
        log(`aspectRatio 파싱 실패 (${input.aspectRatio}) — 원본 비율 유지`);
      } else {
        const [rw, rh] = parsed;
        const metaForCrop = await this.processor.getMetadata(baseBinary);
        const ow = metaForCrop.success ? metaForCrop.data?.width : undefined;
        const oh = metaForCrop.success ? metaForCrop.data?.height : undefined;
        if (ow && oh) {
          const target = computeCropDims(ow, oh, rw, rh);
          const diff = Math.abs((ow / oh) - (rw / rh));
          if (diff < 0.01) {
            log(`aspectRatio ${input.aspectRatio} — 원본과 거의 동일, crop skip`);
            appliedAspectRatio = input.aspectRatio;
          } else {
            const cropRes = await this.processor.process(baseBinary, {
              width: target.width,
              height: target.height,
              fit: 'cover',
              position: focusPoint,
              stripMetadata: settings.stripExif,
            });
            if (cropRes.success && cropRes.data) {
              baseBinary = cropRes.data;
              // crop 은 PNG 포맷 유지 (format 미지정)
              appliedAspectRatio = input.aspectRatio;
              log(`aspectRatio crop 적용: ${ow}×${oh} → ${target.width}×${target.height} (${input.aspectRatio}, ${typeof focusPoint === 'string' ? focusPoint : 'xy'})`);
            } else {
              log(`crop 실패 (${cropRes.error}) — 원본 유지`);
            }
          }
        }
      }
    }

    // 2) 원본(또는 crop 된) base 저장 — 메타에 prompt/model/size/quality/aspectRatio 포함
    const saveRes = await this.media.save(baseBinary, baseContentType, {
      filenameHint: input.filenameHint,
      scope,
      prompt: input.prompt,
      revisedPrompt: genResult.revisedPrompt,
      model: modelId,
      size,
      quality,
      ...(appliedAspectRatio ? { aspectRatio: appliedAspectRatio, focusPoint } : {}),
    });
    if (!saveRes.success || !saveRes.data) {
      this.logger.error(`[ImageManager]${corrId ? ` [${corrId}]` : ''} 저장 실패: ${saveRes.error}`);
      return { success: false, error: saveRes.error || '이미지 저장 실패' };
    }
    const saved = saveRes.data;
    onProgress?.(0.75, 'variants 생성 중...');

    // 3) 메타데이터 파싱 — baseBinary 기준 (crop 이 적용됐으면 cropped 치수)
    const metaRes = await this.processor.getMetadata(baseBinary);
    const originalWidth = metaRes.success ? metaRes.data?.width : undefined;
    const originalHeight = metaRes.success ? metaRes.data?.height : undefined;

    // 4) variants 병렬 생성 — SEO 설정 기반
    const variants: MediaVariant[] = [];
    let thumbnailUrl: string | undefined;
    let blurhash: string | undefined;

    // 4-1) 원본 크기 WebP/AVIF (settings 활성 시)
    const fullFormats: Array<'webp' | 'avif'> = [];
    if (settings.webp) fullFormats.push('webp');
    if (settings.avif) fullFormats.push('avif');
    for (const format of fullFormats) {
      const buf = await this.processor.process(baseBinary, {
        format,
        quality: settings.defaultQuality,
        progressive: settings.progressive,
        stripMetadata: settings.stripExif,
      });
      if (!buf.success || !buf.data) continue;
      const suffix = 'full';
      const vRes = await this.media.saveVariant(saved.slug, scope, `${suffix}`, format, buf.data, {
        width: originalWidth ?? 0,
        height: originalHeight,
        format,
        bytes: buf.data.length,
      });
      if (vRes.success && vRes.data) {
        variants.push({
          width: originalWidth ?? 0,
          height: originalHeight,
          format,
          url: vRes.data,
          bytes: buf.data.length,
        });
      }
    }

    // 4-2) 반응형 variants — 원본보다 작은 width 만
    for (const w of settings.variants) {
      if (originalWidth && w >= originalWidth) continue; // 원본보다 크게는 안 만듦
      const perWidthFormats: Array<'webp' | 'avif'> = [];
      if (settings.webp) perWidthFormats.push('webp');
      if (settings.avif) perWidthFormats.push('avif');
      for (const format of perWidthFormats) {
        const buf = await this.processor.process(baseBinary, {
          width: w,
          fit: 'inside',
          format,
          quality: settings.defaultQuality,
          progressive: settings.progressive,
          stripMetadata: settings.stripExif,
        });
        if (!buf.success || !buf.data) continue;
        const vRes = await this.media.saveVariant(saved.slug, scope, `${w}w`, format, buf.data, {
          width: w,
          format,
          bytes: buf.data.length,
        });
        if (vRes.success && vRes.data) {
          variants.push({
            width: w,
            format,
            url: vRes.data,
            bytes: buf.data.length,
          });
        }
      }
    }

    // 4-3) 썸네일 (256px webp)
    if (settings.thumbnail) {
      const buf = await this.processor.process(baseBinary, {
        width: 256,
        fit: 'inside',
        format: 'webp',
        quality: 80,
        stripMetadata: settings.stripExif,
      });
      if (buf.success && buf.data) {
        const vRes = await this.media.saveVariant(saved.slug, scope, 'thumb', 'webp', buf.data, {
          width: 256,
          format: 'webp',
          bytes: buf.data.length,
        });
        if (vRes.success && vRes.data) thumbnailUrl = vRes.data;
      }
    }

    // 4-4) blurhash (LQIP)
    if (settings.blurhash) {
      const bh = await this.processor.blurhash(baseBinary);
      if (bh.success && bh.data) blurhash = bh.data;
    }
    onProgress?.(0.95, '메타데이터 업데이트 중...');

    // 5) 메타 JSON 업데이트 — variants·thumbnailUrl·blurhash·width/height 반영
    await this.media.updateMeta(saved.slug, scope, {
      width: originalWidth,
      height: originalHeight,
      ...(variants.length > 0 ? { variants } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(blurhash ? { blurhash } : {}),
    });

    const totalMs = Date.now() - startedAt;
    log(`완료 (${totalMs}ms, slug=${saved.slug}, variants=${variants.length}${thumbnailUrl ? ', thumb' : ''}${blurhash ? ', blurhash' : ''})`);

    return {
      success: true,
      data: {
        url: saved.url,
        thumbnailUrl,
        variants: variants.length > 0 ? variants : undefined,
        blurhash,
        width: originalWidth ?? genResult.width,
        height: originalHeight ?? genResult.height,
        slug: saved.slug,
        revisedPrompt: genResult.revisedPrompt,
        modelId,
        ...(appliedAspectRatio ? { aspectRatio: appliedAspectRatio } : {}),
      },
    };
  }
}
