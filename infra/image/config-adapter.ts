/**
 * ImageConfigDrivenAdapter — IImageGenPort 구현체. LLM 의 ConfigDrivenAdapter 와 병렬.
 *
 * 동작:
 * 1. 모델 ID 로 config JSON 해석
 * 2. config.format 에 해당하는 ImageFormatHandler 에 위임
 * 3. handler 가 실제 HTTP 호출 + binary 반환
 *
 * 새 이미지 모델 도입 시:
 * - 기존 format (openai-image 등) 재사용 → configs/*.json 추가만
 * - 신규 format (예: stability-api) → formats/ 에 핸들러 추가 + config
 */
import type {
  IImageGenPort,
  ImageGenOpts,
  ImageGenCallOpts,
  ImageGenResult,
  ImageModelInfo,
} from '../../core/ports';
import type { InfraResult } from '../../core/types';
import type { ImageFormatHandler } from './format-handler';
import type { ImageGenFormat, ImageGenModelConfig, ImageGenRegistry } from './image-config';
import { OpenAIImageFormat } from './formats/openai-image';

export class ImageConfigDrivenAdapter implements IImageGenPort {
  private handlers: Partial<Record<ImageGenFormat, ImageFormatHandler>>;

  constructor(
    private readonly registry: ImageGenRegistry,
    private readonly defaultModelId: string,
    private readonly resolveSecret: (key: string) => string | null,
  ) {
    this.handlers = {
      'openai-image': new OpenAIImageFormat(),
      // 'gemini-native-image': new GeminiNativeImageFormat(),   // v2
      // 'vertex-gemini-image': new VertexGeminiImageFormat(),   // v2
      // 'stability-api': new StabilityApiFormat(),              // v2
      // 'cli-codex-image': new CliCodexImageFormat(),           // v2 (CLI 경로)
      // 'cli-gemini-image': new CliGeminiImageFormat(),         // v2 (CLI 경로)
    };
  }

  getModelId(): string { return this.defaultModelId; }

  listModels(): ImageModelInfo[] {
    return Object.values(this.registry).map(cfg => ({
      id: cfg.id,
      displayName: cfg.displayName,
      provider: cfg.provider,
      format: cfg.format,
      requiresOrganizationVerification: (cfg as unknown as { requiresOrganizationVerification?: boolean }).requiresOrganizationVerification,
    }));
  }

  private resolveConfig(modelId?: string): ImageGenModelConfig | null {
    const id = modelId ?? this.defaultModelId;
    if (!id) return null;
    const direct = this.registry[id];
    if (direct) return direct;
    // prefix 매치 (LLM 어댑터와 동일 패턴)
    for (const cfg of Object.values(this.registry)) {
      if (cfg.id.startsWith(id) || id.startsWith(cfg.id)) return cfg;
    }
    return this.registry[this.defaultModelId] ?? Object.values(this.registry)[0] ?? null;
  }

  async generate(
    opts: ImageGenOpts,
    callOpts?: ImageGenCallOpts,
  ): Promise<InfraResult<ImageGenResult>> {
    const config = this.resolveConfig(opts.model ?? callOpts?.model);
    if (!config) return { success: false, error: '이미지 생성 모델이 설정되지 않았습니다' };
    const handler = this.handlers[config.format];
    if (!handler) return { success: false, error: `지원하지 않는 format: ${config.format}` };
    return handler.generate(opts, callOpts, {
      config,
      resolveApiKey: () => this.resolveSecret(config.apiKeyVaultKey),
    });
  }
}
