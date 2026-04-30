/**
 * MediaManager — 미디어 도메인 단일 매니저.
 *
 * 책임:
 *   1) 이미지 생성 오케스트레이션 + 후처리 파이프라인 (이전 ImageManager.generate)
 *   2) 미디어 CRUD (read/list/remove/stat) — IMediaPort thin wrapper
 *   3) 갤러리 재생성 (regenerateImageBySlug) — 기존 메타에서 prompt/model/aspectRatio 그대로
 *   4) 외부 노출 안전성 (isMediaReady) — og:image 등 SNS 캐싱 보호용
 *   5) 이미지 모델·기본 size/quality 설정 (Vault)
 *   6) SEO 이미지 후처리 설정 (variants, blurhash, thumbnail 등)
 *
 * 향후 확장: 동영상 (generateVideo), 오디오 등도 같은 매니저에서 — generateImage 와 일관 인터페이스.
 *
 * BIBLE 준수:
 *   - SSE 발행 X (Core facade 의 책임 — generateImage/regenerateImage/removeMedia 결과로 emit)
 *   - 매니저 간 직접 호출 X — Core 가 statusMgr 와 연결
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
import { parseMediaUrl } from '../../lib/media-url';

const VK_IMAGE_MODEL = 'system:image-model';
const VK_IMAGE_SIZE = 'system:image-size';
const VK_IMAGE_QUALITY = 'system:image-quality';

/** "1024x1024" / "1024" / undefined → [width, height]. 기본 1024x1024 (placeholder 용 — 백그라운드에서 실제 크기로 교체됨). */
function parseSizeHint(size?: string): [number, number] {
  if (!size) return [1024, 1024];
  const m = size.match(/^(\d+)x(\d+)$/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  const single = parseInt(size, 10);
  if (!isNaN(single) && single > 0) return [single, single];
  return [1024, 1024];
}

export interface SeoImageSettings {
  /** WebP variant 생성 — 대부분 브라우저 지원, 원본보다 25~35% 작음 */
  webp: boolean;
  /** AVIF variant 생성 — 최신 포맷, WebP 보다 20% 더 작음. 구형 브라우저 미지원 */
  avif: boolean;
  /** 썸네일 256px 생성 */
  thumbnail: boolean;
  /** 반응형 variants 의 width 목록 — 각 width 마다 webp/avif 쌍 생성 */
  variants: number[];
  /** blurhash LQIP — 로딩 중 부드러운 블러 표시 */
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

export interface GenerateImageInput extends Omit<ImageGenOpts, 'referenceImage'> {
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
  /** 참조 이미지 (image-to-image 변환) — 사용자/AI 입력 형식.
   *  - slug: 갤러리 미디어 slug (가장 흔한 케이스, AI 가 search_media 결과의 slug 전달)
   *  - url: 외부 URL (https://...) 또는 절대/상대 미디어 경로
   *  - base64: base64 인코딩 raw binary (data: URI prefix 허용)
   *  MediaManager 가 binary 로 resolve 후 ImageGenOpts.referenceImage 로 변환. */
  referenceImage?: {
    slug?: string;
    url?: string;
    base64?: string;
  };
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
  /** 이미지 1장 비용 USD — config.pricing 기반. 구독 모드 (CLI Codex) 는 미설정.
   *  Core facade 가 받아서 recordLlmCost 호출 → 비용 통계에 누적. */
  costUsd?: number;
}

export class MediaManager {
  constructor(
    private imageGen: IImageGenPort,
    private media: IMediaPort,
    private processor: IImageProcessorPort,
    private vault: IVaultPort,
    private logger: ILogPort,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  //  이미지 모델·기본값 (Vault 영속)
  // ══════════════════════════════════════════════════════════════════════════

  getImageModel(): string {
    const stored = this.vault.getSecret(VK_IMAGE_MODEL);
    if (stored) return stored;
    return this.imageGen.getModelId();
  }

  setImageModel(modelId: string): InfraResult<void> {
    const ok = this.vault.setSecret(VK_IMAGE_MODEL, modelId);
    return ok ? { success: true, data: undefined } : { success: false, error: 'Vault 저장 실패' };
  }

  getImageDefaultSize(): string | null {
    return this.vault.getSecret(VK_IMAGE_SIZE);
  }
  setImageDefaultSize(size: string | null): InfraResult<void> {
    const ok = size === null
      ? this.vault.deleteSecret(VK_IMAGE_SIZE)
      : this.vault.setSecret(VK_IMAGE_SIZE, size);
    return ok ? { success: true, data: undefined } : { success: false, error: 'Vault 저장 실패' };
  }
  getImageDefaultQuality(): string | null {
    return this.vault.getSecret(VK_IMAGE_QUALITY);
  }
  setImageDefaultQuality(quality: string | null): InfraResult<void> {
    const ok = quality === null
      ? this.vault.deleteSecret(VK_IMAGE_QUALITY)
      : this.vault.setSecret(VK_IMAGE_QUALITY, quality);
    return ok ? { success: true, data: undefined } : { success: false, error: 'Vault 저장 실패' };
  }

  listImageModels(): ImageModelInfo[] {
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

  // ══════════════════════════════════════════════════════════════════════════
  //  미디어 CRUD (IMediaPort thin wrapper — 도메인 로직 추가 시 여기 확장)
  // ══════════════════════════════════════════════════════════════════════════

  /** /user/media/<slug>.<ext> 파일 서빙용 — slug 로 binary + contentType 반환 */
  read(slug: string) { return this.media.read(slug); }

  /** 갤러리용 미디어 목록 — scope/검색/페이징 */
  list(opts?: { scope?: 'user' | 'system' | 'all'; limit?: number; offset?: number; search?: string }) {
    return this.media.list(opts);
  }

  /** 메타 단독 조회 (binary 없이) */
  stat(slug: string) { return this.media.stat(slug); }

  /** 갤러리에서 수동 삭제 (도메인 단순 — Core 가 SSE emit) */
  async remove(slug: string) { return this.media.remove(slug); }

  /** og:image 등 외부 노출 안전성 판단.
   *  미디어 URL 이 아니면 항상 true (외부 URL 은 우리 책임 X).
   *  미디어 URL 이면 status='done' 이고 원본 binary 존재 (bytes>0) 일 때만 ready.
   *  rendering / error / 미생성 placeholder 는 false → caller 가 자동 OG 폴백.
   *  legacy (status 미설정) 는 'done' 으로 간주. */
  async isMediaReady(url: string | undefined | null): Promise<boolean> {
    if (!url) return false;
    const parsed = parseMediaUrl(url);
    if (!parsed) return true;  // 외부 URL — 통과
    const stat = await this.media.stat(parsed.slug).catch(() => null);
    if (!stat?.success || !stat.data) return false;
    const record = stat.data;
    const status = record.status ?? 'done';
    if (status !== 'done') return false;
    if (!record.bytes || record.bytes <= 0) return false;
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  이미지 생성·재생성
  // ══════════════════════════════════════════════════════════════════════════

  /** 갤러리에서 재생성 — 기존 메타의 prompt/model/size/quality/aspectRatio 등 그대로 재실행.
   *  성공 시 새 slug 가 발급되고 기존 slug 정리는 호출자(Core) 가 수행 (SSE emit 과 같이).
   *  prompt 가 없는 레거시 레코드는 재생성 불가 → error 반환. */
  async regenerateImageBySlug(
    slug: string,
    opts?: { onProgress?: (progress: number, message: string) => void },
  ): Promise<InfraResult<GenerateImageResult & { regenFrom: string }>> {
    const stat = await this.media.stat(slug);
    if (!stat.success) return { success: false, error: stat.error || '메타 조회 실패' };
    const record = stat.data;
    if (!record) return { success: false, error: '미디어를 찾을 수 없습니다.' };
    if (!record.prompt) return { success: false, error: '프롬프트 정보가 없어 재생성할 수 없습니다.' };

    const input: GenerateImageInput = {
      prompt: record.prompt,
      ...(record.model ? { model: record.model } : {}),
      ...(record.size ? { size: record.size } : {}),
      ...(record.quality ? { quality: record.quality } : {}),
      ...(record.filenameHint ? { filenameHint: record.filenameHint } : {}),
      ...(record.scope ? { scope: record.scope } : {}),
      ...(record.aspectRatio ? { aspectRatio: record.aspectRatio } : {}),
      ...(record.focusPoint ? { focusPoint: record.focusPoint } : {}),
    };
    const res = await this.generateImage(input, opts);
    if (!res.success || !res.data) return res as InfraResult<GenerateImageResult & { regenFrom: string }>;
    return { success: true, data: { ...res.data, regenFrom: slug } };
  }

  /** 비동기 image_gen 시작 — 즉시 placeholder 저장 + slug/url 반환, 실제 생성은 백그라운드.
   *  AI image_gen 도구가 이걸 호출 → 즉시 URL 받아 page spec 박고 save_page 발행 가능 (60-90s await X).
   *  사용자 페이지 reload 시 placeholder → 실제 이미지로 자동 swap (디스크 파일 교체).
   *  채팅 이미지 모드 (입력창 토글) 는 sync 유지 — 이건 page/post AI 흐름 전용.
   *
   *  콜백:
   *   - onComplete: 백그라운드 완료 시 — Core 가 gallery:refresh emit 에 활용
   *   - onError: 백그라운드 실패 시 — Core 가 sse error emit 에 활용 */
  async startGenerate(
    input: GenerateImageInput,
    opts?: {
      corrId?: string;
      onComplete?: (result: GenerateImageResult) => void;
      onError?: (err: string) => void;
    },
  ): Promise<InfraResult<{ slug: string; url: string }>> {
    const corrId = opts?.corrId;
    const scope = input.scope ?? 'user';
    const log = (msg: string) => this.logger.info(`[MediaManager]${corrId ? ` [${corrId}]` : ''} ${msg}`);
    // placeholder 크기 — input.size 우선, 없으면 기본 1024x1024 (정사각). aspectRatio 지정돼도 일단 정사각으로 박고
    // 백그라운드 generation 후 finalizeBase 시 실제 크기로 교체됨.
    const [phW, phH] = parseSizeHint(input.size);
    const phRes = await this.processor.createPlaceholder(phW, phH);
    if (!phRes.success || !phRes.data) {
      return { success: false, error: phRes.error || 'placeholder 생성 실패' };
    }
    // placeholder save — slug 발급. status='done' 으로 박히지만 직후 'rendering' 으로 덮어씀.
    const saveRes = await this.media.save(phRes.data, 'image/png', {
      filenameHint: input.filenameHint,
      scope,
      prompt: input.prompt,
      model: input.model ?? this.getImageModel(),
      ...(input.size ? { size: input.size } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      source: 'ai-generated',
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.focusPoint ? { focusPoint: input.focusPoint } : {}),
    });
    if (!saveRes.success || !saveRes.data) {
      return { success: false, error: saveRes.error || 'placeholder 저장 실패' };
    }
    const { slug, url } = saveRes.data;
    // status='rendering' 으로 마킹 — 갤러리 UI 가 spinner + 빨간 테두리 분기 (커밋 2c0a5c1 박힘)
    await this.media.updateMeta(slug, scope, { status: 'rendering' });
    log(`startGenerate: placeholder 저장 (slug=${slug}, url=${url}) — 백그라운드 생성 시작`);
    // 백그라운드 — generateImage 가 existingSlug 모드로 finalize.
    // setImmediate 로 뿌려서 caller 즉시 반환 (await X). 실패 시 status='error' 자동 마킹.
    setImmediate(() => {
      this.generateImage(input, { corrId, existingSlug: slug })
        .then(res => {
          if (res.success && res.data) {
            opts?.onComplete?.(res.data);
          } else {
            const errMsg = res.error || '백그라운드 생성 실패';
            this.media.updateMeta(slug, scope, { status: 'error', errorMsg: errMsg }).catch(() => {});
            opts?.onError?.(errMsg);
          }
        })
        .catch(err => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(`[MediaManager]${corrId ? ` [${corrId}]` : ''} 백그라운드 generateImage 예외: ${errMsg}`);
          this.media.updateMeta(slug, scope, { status: 'error', errorMsg: errMsg }).catch(() => {});
          opts?.onError?.(errMsg);
        });
    });
    return { success: true, data: { slug, url } };
  }

  /** AI image_gen 도구 → Core.generateImage → 이 메서드 → 생성 + 후처리 + 저장.
   *  StatusManager·SSE emit 은 Core 가 wrap. 본 메서드는 도메인 로직만.
   *  existingSlug 지정 시 — 새 slug 발급 X, 기존 placeholder 파일을 finalizeBase 로 교체 (비동기 패턴 완료 단계). */
  async generateImage(
    input: GenerateImageInput,
    opts?: { corrId?: string; onProgress?: (progress: number, message: string) => void; existingSlug?: string },
  ): Promise<InfraResult<GenerateImageResult>> {
    const startedAt = Date.now();
    const corrId = opts?.corrId;
    const onProgress = opts?.onProgress;
    const modelId = input.model ?? this.getImageModel();
    const scope = input.scope ?? 'user';
    const settings = this.getImageSettings();
    const log = (msg: string) => this.logger.info(`[MediaManager]${corrId ? ` [${corrId}]` : ''} [${modelId}] ${msg}`);

    // 사용자 명령이 우선, 없으면 설정된 기본값 폴백 — 둘 다 없으면 핸들러 기본값 사용
    const size = input.size ?? this.getImageDefaultSize() ?? undefined;
    const quality = input.quality ?? this.getImageDefaultQuality() ?? undefined;
    log(`generateImage 시작: prompt=${input.prompt.slice(0, 100)}${input.prompt.length > 100 ? '…' : ''} size=${size ?? 'handler-default'} quality=${quality ?? 'handler-default'}`);

    // 진행도 보고 — Core 가 StatusManager 와 연결. MediaManager 는 콜백 호출만.
    onProgress?.(0.05, '이미지 생성 시작...');

    // 0.5) referenceImage resolve (image-to-image) — slug/url/base64 → binary
    //      slug: 갤러리 read / 미디어 URL: parseMediaUrl → slug → read / 외부 URL: fetch / base64: decode
    //      resolve 실패 시 reference 무시하고 prompt 만으로 진행 (사용자 의도는 잃지만 호출 자체는 실행)
    const referenceImage = await this.resolveReferenceImage(input.referenceImage);
    if (input.referenceImage && !referenceImage) {
      log(`referenceImage resolve 실패 (slug=${input.referenceImage.slug ?? '-'} url=${input.referenceImage.url ?? '-'}) — 무시하고 prompt 만으로 생성`);
    } else if (referenceImage) {
      log(`referenceImage resolved (${referenceImage.binary.length} bytes, ${referenceImage.contentType})`);
    }

    // 1) 이미지 생성 — input 의 referenceImage (slug/url/base64) 는 ImageGenOpts 와 형 다름 → 분리 후
    //    resolved binary 형태로 교체. eslint-disable-line 으로 underscore 변수 의도 표시.
    const { referenceImage: _refIn, ...inputRest } = input; // eslint-disable-line @typescript-eslint/no-unused-vars
    const genRes = await this.imageGen.generate(
      { ...inputRest, size, quality, model: modelId, ...(referenceImage ? { referenceImage } : {}) },
      { corrId, model: modelId },
    );
    if (!genRes.success || !genRes.data) {
      const errorMsg = genRes.error || '이미지 생성 실패';
      this.logger.error(`[MediaManager]${corrId ? ` [${corrId}]` : ''} [${modelId}] 생성 실패: ${errorMsg}`);
      // 실패도 갤러리에 기록 — 사용자가 prompt 보고 재시도하거나 삭제 가능.
      // 메타만 status='error' 로 저장 (binary 없음).
      await this.media.saveErrorRecord({
        filenameHint: input.filenameHint,
        scope,
        prompt: input.prompt,
        model: modelId,
        size,
        quality,
        source: 'ai-generated',
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

    // 2) 원본(또는 crop 된) base 저장 또는 placeholder 교체 (existingSlug 모드).
    //    - 신규 (existingSlug 미지정): media.save 로 새 slug 발급 + 메타 신설
    //    - 비동기 finalize (existingSlug 지정): media.finalizeBase 로 placeholder 덮어쓰기 + meta 업데이트.
    //      이때 prompt·model·size 등은 startGenerate 가 이미 박아둔 상태 — 여기선 revisedPrompt 만 추가 갱신.
    let saved: { slug: string; url: string };
    if (opts?.existingSlug) {
      const fbRes = await this.media.finalizeBase(opts.existingSlug, scope, baseBinary, baseContentType);
      if (!fbRes.success) {
        this.logger.error(`[MediaManager]${corrId ? ` [${corrId}]` : ''} finalizeBase 실패: ${fbRes.error}`);
        return { success: false, error: fbRes.error || 'placeholder 교체 실패' };
      }
      // ext 결정 (finalizeBase 내부 로직과 동일) — URL 재구성용
      const finalExt = baseContentType.includes('jpeg') || baseContentType.includes('jpg') ? 'jpg'
        : baseContentType.includes('webp') ? 'webp'
        : baseContentType.includes('avif') ? 'avif'
        : 'png';
      saved = { slug: opts.existingSlug, url: `/${scope}/media/${opts.existingSlug}.${finalExt}` };
      // revisedPrompt 만 추가 갱신 (나머지 메타는 startGenerate 가 박았음). status 는 마지막 updateMeta 에서 'done'.
      if (genResult.revisedPrompt) {
        await this.media.updateMeta(opts.existingSlug, scope, { revisedPrompt: genResult.revisedPrompt });
      }
    } else {
      const saveRes = await this.media.save(baseBinary, baseContentType, {
        filenameHint: input.filenameHint,
        scope,
        prompt: input.prompt,
        revisedPrompt: genResult.revisedPrompt,
        model: modelId,
        size,
        quality,
        source: 'ai-generated',
        ...(appliedAspectRatio ? { aspectRatio: appliedAspectRatio, focusPoint } : {}),
      });
      if (!saveRes.success || !saveRes.data) {
        this.logger.error(`[MediaManager]${corrId ? ` [${corrId}]` : ''} 저장 실패: ${saveRes.error}`);
        return { success: false, error: saveRes.error || '이미지 저장 실패' };
      }
      saved = saveRes.data;
    }
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

    // 5) 메타 JSON 업데이트 — variants·thumbnailUrl·blurhash·width/height 반영.
    //    status 'done' 도 명시 — 비동기 finalize 의 placeholder('rendering' 마킹) 도 여기서 'done' 으로 전환됨.
    await this.media.updateMeta(saved.slug, scope, {
      status: 'done',
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
        ...(typeof genResult.costUsd === 'number' ? { costUsd: genResult.costUsd } : {}),
      },
    };
  }

  /** 참조 이미지 resolve — slug / url (미디어 또는 외부) / base64 (data URI 또는 raw) → binary.
   *  generateImage 가 imageGen.generate 호출 전에 1회 호출. 실패 시 null 반환 (caller 에서 reference 무시).
   *  - 일반 로직: 모든 입력 형태 동등 처리. 특정 도메인·확장자 하드코딩 X.
   *  - 미디어 URL 인식은 parseMediaUrl (lib/media-url.ts) 단일 source. */
  private async resolveReferenceImage(
    ref?: { slug?: string; url?: string; base64?: string },
  ): Promise<{ binary: Buffer; contentType: string } | null> {
    if (!ref) return null;
    // 1) base64 — data URI ("data:image/png;base64,XXX") 또는 raw base64. 가장 단순·빠름
    if (ref.base64) {
      const m = ref.base64.match(/^data:(image\/[\w+-]+);base64,(.+)$/);
      if (m) return { binary: Buffer.from(m[2], 'base64'), contentType: m[1] };
      return { binary: Buffer.from(ref.base64, 'base64'), contentType: 'image/png' };
    }
    // 2) slug — 갤러리에서 직접 read (user/system 양쪽 자동 검색)
    if (ref.slug) {
      const r = await this.media.read(ref.slug);
      if (r.success && r.data) return { binary: r.data.binary, contentType: r.data.contentType };
      return null;
    }
    // 3) url — 미디어 URL (`/user/media/...` / `/system/media/...`) 또는 외부 URL
    if (ref.url) {
      const parsed = parseMediaUrl(ref.url);
      if (parsed) {
        const r = await this.media.read(parsed.slug);
        if (r.success && r.data) return { binary: r.data.binary, contentType: r.data.contentType };
        return null;
      }
      if (/^https?:\/\//i.test(ref.url)) {
        try {
          const res = await fetch(ref.url);
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          return { binary: buf, contentType: res.headers.get('content-type') ?? 'image/png' };
        } catch { return null; }
      }
    }
    return null;
  }
}
