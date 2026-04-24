/**
 * ImageManager — AI 이미지 생성 오케스트레이션.
 *
 * 역할:
 *  1. Vault 에서 선택된 모델 ID 조회 (기본 provider)
 *  2. IImageGenPort 호출해서 binary 생성
 *  3. IMediaPort 에 저장 → 공개 URL 발급
 *  4. 결과 {url, width, height, ...} 반환 — AI 가 render_image 에 바로 사용
 *
 * 왜 AiManager 와 별도?
 *  - 도메인이 다름 (text vs image), 설정 UI 도 분리
 *  - 공유 지점: prompt 를 텍스트 AI 가 만들어서 이 매니저에 넘기는 흐름만 있음
 *  - LLM 과 동일한 config-adapter 패턴 재사용 (hexagonal 에서 만나면 port 만 다름)
 */
import type { IImageGenPort, IMediaPort, IVaultPort, ILogPort, ImageGenOpts, ImageModelInfo } from '../ports';
import type { InfraResult } from '../types';

const VK_IMAGE_MODEL = 'system:image-model';

export interface GenerateImageInput extends ImageGenOpts {
  /** 저장 시 파일명 힌트 (로그용). 예: "blog-hero-samsung" */
  filenameHint?: string;
}

export interface GenerateImageResult {
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  slug: string;
  revisedPrompt?: string;
  modelId: string;
}

export class ImageManager {
  constructor(
    private imageGen: IImageGenPort,
    private media: IMediaPort,
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

  listModels(): ImageModelInfo[] {
    return this.imageGen.listModels();
  }

  async generate(input: GenerateImageInput, corrId?: string): Promise<InfraResult<GenerateImageResult>> {
    const startedAt = Date.now();
    const modelId = input.model ?? this.getModel();
    const log = (msg: string) => this.logger.info(`[ImageManager]${corrId ? ` [${corrId}]` : ''} [${modelId}] ${msg}`);

    log(`generate 시작: prompt=${input.prompt.slice(0, 100)}${input.prompt.length > 100 ? '…' : ''} size=${input.size ?? 'default'} quality=${input.quality ?? 'default'}`);

    // 1) 이미지 생성 — IImageGenPort → binary
    const genRes = await this.imageGen.generate({ ...input, model: modelId }, { corrId, model: modelId });
    if (!genRes.success || !genRes.data) {
      this.logger.error(`[ImageManager]${corrId ? ` [${corrId}]` : ''} [${modelId}] 생성 실패: ${genRes.error}`);
      return { success: false, error: genRes.error || '이미지 생성 실패' };
    }
    const genResult = genRes.data;
    const genMs = Date.now() - startedAt;
    log(`binary 수신 (${genMs}ms, ${genResult.binary.length} bytes, ${genResult.contentType})`);

    // 2) 서버 저장 — IMediaPort → URL
    const saveRes = await this.media.save(genResult.binary, genResult.contentType, {
      originalName: input.filenameHint,
      thumbnail: true,
      thumbnailWidth: 256,
    });
    if (!saveRes.success || !saveRes.data) {
      this.logger.error(`[ImageManager]${corrId ? ` [${corrId}]` : ''} 저장 실패: ${saveRes.error}`);
      return { success: false, error: saveRes.error || '이미지 저장 실패' };
    }
    const saved = saveRes.data;
    const totalMs = Date.now() - startedAt;
    log(`완료 (${totalMs}ms, slug=${saved.slug}, url=${saved.url})`);

    return {
      success: true,
      data: {
        url: saved.url,
        thumbnailUrl: saved.thumbnailUrl,
        // 생성 시 전달한 size 에서 파싱된 dims 가 있으면 그대로, 없으면 저장 adapter 가 읽은 값 (PNG dim 파서)
        width: genResult.width ?? saved.width,
        height: genResult.height ?? saved.height,
        slug: saved.slug,
        revisedPrompt: genResult.revisedPrompt,
        modelId,
      },
    };
  }
}
