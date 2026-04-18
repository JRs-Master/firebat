/**
 * openai-responses format handler
 *
 * OpenAI Responses API (/v1/responses) 기반. GPT-5.4 / o 시리즈 등이 이 format 사용.
 * 지원 기능: MCP connector, strict tools, reasoning, previous_response_id, tool_search, 24h cache.
 *
 * 현재는 기존 OpenAiAdapter의 풍부한 기능을 재활용하기 위해 내부적으로 OpenAiAdapter 인스턴스 사용.
 * 추후 전면 이관 예정.
 */
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';
import { OpenAiAdapter } from '../openai-adapter';

export class OpenAIResponsesFormat implements FormatHandler {
  // 기존 OpenAiAdapter 재사용 — (resolveApiKey, resolveMcpConfig) 동일한 signature
  private adapterCache = new WeakMap<FormatHandlerContext, OpenAiAdapter>();

  private getAdapter(ctx: FormatHandlerContext): OpenAiAdapter {
    let a = this.adapterCache.get(ctx);
    if (!a) {
      const supportsToolSearch = !!ctx.config.features?.toolSearch;
      a = new OpenAiAdapter(ctx.resolveApiKey, ctx.config.id, ctx.resolveMcpConfig, supportsToolSearch);
      this.adapterCache.set(ctx, a);
    }
    return a;
  }

  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const a = this.getAdapter(ctx);
    return a.ask(prompt, systemPrompt, history, { ...opts, model: ctx.config.id });
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const a = this.getAdapter(ctx);
    return a.askText(prompt, systemPrompt, { ...opts, model: ctx.config.id });
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[], toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const a = this.getAdapter(ctx);
    return a.askWithTools(prompt, systemPrompt, tools, history, toolExchanges, { ...opts, model: ctx.config.id });
  }
}
