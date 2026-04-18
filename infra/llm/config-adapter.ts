/**
 * ConfigDrivenAdapter — 모델 config 기반 범용 LLM 어댑터
 *
 * 동작:
 * 1. 모델 이름으로 config JSON 로드
 * 2. config.format에 해당하는 handler에 위임
 * 3. handler가 실제 HTTP 요청 처리
 *
 * 새 LLM 도입 시:
 * - 기존 format 사용 → configs/에 JSON 추가만
 * - 신규 format → formats/ 에 handler 추가 + config
 */
import type { ILlmPort, LlmCallOpts, ChatMessage, LlmJsonResponse, ToolDefinition, ToolExchangeEntry, LlmToolResponse } from '../../core/ports';
import type { InfraResult } from '../../core/types';
import type { FormatHandler, FormatHandlerContext } from './format-handler';
import type { ModelConfig, ModelRegistry, LlmFormat } from './model-config';
import { OpenAIResponsesFormat } from './formats/openai-responses';
import { OpenAIChatFormat } from './formats/openai-chat';
import { AnthropicMessagesFormat } from './formats/anthropic-messages';
import { VertexGeminiFormat } from './formats/vertex-gemini';

export class ConfigDrivenAdapter implements ILlmPort {
  private handlers: Record<LlmFormat, FormatHandler>;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly defaultModelId: string,
    private readonly resolveSecret: (key: string) => string | null,
    private readonly resolveMcpConfig?: () => { url: string; token: string } | null,
  ) {
    this.handlers = {
      'openai-responses': new OpenAIResponsesFormat(),
      'openai-chat': new OpenAIChatFormat(),
      'anthropic-messages': new AnthropicMessagesFormat(),
      'vertex-gemini': new VertexGeminiFormat(),
    };
  }

  getModelId(): string { return this.defaultModelId; }

  /** 모델 ID 또는 prefix로 config 해석 */
  private resolveConfig(modelId?: string): ModelConfig {
    const id = modelId ?? this.defaultModelId;
    const direct = this.registry[id];
    if (direct) return direct;
    // prefix 매치 fallback (예: "gemini-3-flash" 요청인데 config id는 "gemini-3-flash-preview")
    for (const cfg of Object.values(this.registry)) {
      if (cfg.id.startsWith(id) || id.startsWith(cfg.id)) return cfg;
    }
    // 기본 모델 fallback
    return this.registry[this.defaultModelId] ?? Object.values(this.registry)[0];
  }

  private buildContext(config: ModelConfig): FormatHandlerContext {
    return {
      config,
      resolveApiKey: () => this.resolveSecret(config.apiKeyVaultKey),
      resolveMcpConfig: this.resolveMcpConfig,
    };
  }

  async ask(prompt: string, systemPrompt?: string, history: ChatMessage[] = [], opts?: LlmCallOpts): Promise<InfraResult<LlmJsonResponse>> {
    const config = this.resolveConfig(opts?.model);
    const handler = this.handlers[config.format];
    if (!handler) return { success: false, error: `지원하지 않는 format: ${config.format}` };
    return handler.ask(prompt, systemPrompt, history, opts, this.buildContext(config));
  }

  async askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>> {
    const config = this.resolveConfig(opts?.model);
    const handler = this.handlers[config.format];
    if (!handler) return { success: false, error: `지원하지 않는 format: ${config.format}` };
    return handler.askText(prompt, systemPrompt, opts, this.buildContext(config));
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[] = [], toolExchanges: ToolExchangeEntry[] = [], opts?: LlmCallOpts): Promise<InfraResult<LlmToolResponse>> {
    const config = this.resolveConfig(opts?.model);
    const handler = this.handlers[config.format];
    if (!handler) return { success: false, error: `지원하지 않는 format: ${config.format}` };
    return handler.askWithTools(prompt, systemPrompt, tools, history, toolExchanges, opts, this.buildContext(config));
  }

  /** UI 용: 등록된 모든 모델 config 목록 */
  getAllModels(): ModelConfig[] { return Object.values(this.registry); }
}
