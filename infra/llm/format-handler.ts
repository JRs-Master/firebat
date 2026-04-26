/**
 * LLM Format Handler 인터페이스
 *
 * 각 format (openai-responses / openai-chat / anthropic-messages)은
 * 이 인터페이스를 구현해서 실제 HTTP 호출을 담당한다.
 *
 * ConfigDrivenAdapter는 모델 config를 받아 해당 format handler에 위임.
 */
import type {
  ChatMessage,
  LlmCallOpts,
  LlmJsonResponse,
  LlmToolResponse,
  ToolDefinition,
  ToolExchangeEntry,
} from '../../core/ports';
import type { InfraResult } from '../../core/types';
import type { ModelConfig } from './model-config';

export interface FormatHandlerContext {
  /** 모델 config (endpoint, apiKey Vault key, features 등) */
  config: ModelConfig;
  /** API 키 해석 함수 (Vault에서 지연 로드) */
  resolveApiKey: () => string | null;
  /** 내부 MCP connector 설정 (OpenAI Responses API hosted MCP 용) */
  resolveMcpConfig?: () => { url: string; token: string } | null;
  /** Anthropic prompt caching 토글 — Vault `system:llm:anthropic-cache` 가 'true' 일 때만 marker 박음.
   *  미설정 시 false (cache write 25% 비용 회피). anthropic-messages format 만 참조. */
  resolveAnthropicCache?: () => boolean;
}

export interface FormatHandler {
  ask(
    prompt: string,
    systemPrompt: string | undefined,
    history: ChatMessage[],
    opts: LlmCallOpts | undefined,
    ctx: FormatHandlerContext,
  ): Promise<InfraResult<LlmJsonResponse>>;

  askText(
    prompt: string,
    systemPrompt: string | undefined,
    opts: LlmCallOpts | undefined,
    ctx: FormatHandlerContext,
  ): Promise<InfraResult<string>>;

  askWithTools(
    prompt: string,
    systemPrompt: string,
    tools: ToolDefinition[],
    history: ChatMessage[],
    toolExchanges: ToolExchangeEntry[],
    opts: LlmCallOpts | undefined,
    ctx: FormatHandlerContext,
  ): Promise<InfraResult<LlmToolResponse>>;

  /** 이 format 의 내부 메타 도구 목록 (AI 가 호출하면 안 되는 것들).
   *  CLI 전용 — API 모드는 구현하지 않음 (빈 배열로 간주). */
  getBannedInternalTools?(): string[];
}
