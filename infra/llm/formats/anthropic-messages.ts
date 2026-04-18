/**
 * anthropic-messages format handler
 *
 * Anthropic Claude Messages API (/v1/messages) — tools, streaming, extended thinking, vision.
 * MCP connector 네이티브 지원 (hosted MCP).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';
import { LLM_TIMEOUT_MS } from '../../config';

export class AnthropicMessagesFormat implements FormatHandler {
  private clientCache = new WeakMap<FormatHandlerContext, { key: string; client: Anthropic }>();

  private getClient(ctx: FormatHandlerContext): Anthropic | null {
    const apiKey = ctx.resolveApiKey();
    if (!apiKey) return null;
    const cached = this.clientCache.get(ctx);
    if (cached && cached.key === apiKey) return cached.client;
    const client = new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS });
    this.clientCache.set(ctx, { key: apiKey, client });
    return client;
  }

  private buildMessages(history: ChatMessage[], prompt: string, toolExchanges: ToolExchangeEntry[], opts?: LlmCallOpts): Anthropic.MessageParam[] {
    const msgs: Anthropic.MessageParam[] = [];
    for (const h of history) {
      if (h.role === 'system') continue; // system은 별도 파라미터
      const role: 'user' | 'assistant' = h.role === 'assistant' ? 'assistant' : 'user';
      if (h.image && role === 'user') {
        msgs.push({
          role,
          content: [
            { type: 'image', source: { type: 'base64', media_type: (h.imageMimeType as any) || 'image/jpeg', data: h.image.includes(',') ? h.image.split(',')[1] : h.image } } as any,
            { type: 'text', text: h.content },
          ],
        });
      } else {
        msgs.push({ role, content: h.content });
      }
    }
    // 현재 입력
    if (opts?.image) {
      msgs.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: (opts.imageMimeType as any) || 'image/jpeg', data: opts.image.includes(',') ? opts.image.split(',')[1] : opts.image } } as any,
          { type: 'text', text: prompt },
        ],
      });
    } else {
      msgs.push({ role: 'user', content: prompt });
    }
    // tool exchanges (multi-turn)
    for (const ex of toolExchanges) {
      msgs.push({
        role: 'assistant',
        content: ex.toolCalls.map((tc, i) => ({ type: 'tool_use' as const, id: `toolu_${i}_${Date.now()}`, name: tc.name, input: tc.args })),
      });
      msgs.push({
        role: 'user',
        content: ex.toolResults.map((tr, i) => ({ type: 'tool_result' as const, tool_use_id: `toolu_${i}_${Date.now()}`, content: JSON.stringify(tr.result) })),
      });
    }
    return msgs;
  }

  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const res = await this.askText(prompt, systemPrompt, opts, ctx);
    if (!res.success) return { success: false, error: res.error };
    try { return { success: true, data: JSON.parse(res.data!) as LlmJsonResponse }; }
    catch { return { success: true, data: { thoughts: '', reply: res.data || '', actions: [], suggestions: [] } }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const client = this.getClient(ctx);
    if (!client) return { success: false, error: `${ctx.config.displayName} API 키 누락` };
    try {
      const res = await client.messages.create({
        model: ctx.config.id,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = res.content.map(c => c.type === 'text' ? c.text : '').join('');
      return { success: true, data: text };
    } catch (e: any) { return { success: false, error: `[Claude] askText 실패: ${e.message}` }; }
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[], toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const client = this.getClient(ctx);
    if (!client) return { success: false, error: `${ctx.config.displayName} API 키 누락` };
    try {
      // 내부 MCP connector (Anthropic hosted MCP) — OpenAI와 동일 전략
      // mcpConnector 활성 + 토큰 존재 시: inline tools 배열 생략, MCP 서버 단일 경로만 사용 (중복 방지)
      const mcpConfig = ctx.resolveMcpConfig?.();
      const useMcp = !!(ctx.config.features?.mcpConnector && mcpConfig?.token);
      const mcpServers = useMcp ? [{
        type: 'url' as const,
        url: mcpConfig!.url,
        name: 'firebat-internal',
        authorization_token: mcpConfig!.token,
      }] : undefined;
      // MCP 사용 시 inline tools 스킵 (Firebat 내부 도구는 MCP 서버에서 노출됨)
      const anthropicTools: Anthropic.Tool[] = useMcp ? [] : tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as any,
      }));

      const messages = this.buildMessages(history, prompt, toolExchanges, opts);
      const thinking = ctx.config.features?.extendedThinking && opts?.thinkingLevel !== 'none'
        ? { type: 'enabled' as const, budget_tokens: 5000 }
        : undefined;

      const payload: Anthropic.MessageCreateParams = {
        model: ctx.config.id,
        max_tokens: 8192,
        system: systemPrompt,
        messages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(mcpServers ? ({ mcp_servers: mcpServers } as any) : {}),
      };

      const textParts: string[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      if (opts?.onChunk) {
        const stream = client.messages.stream(payload);
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            const delta: any = event.delta;
            if (delta.type === 'text_delta') {
              textParts.push(delta.text);
              opts.onChunk({ type: 'text', content: delta.text });
            } else if (delta.type === 'thinking_delta') {
              opts.onChunk({ type: 'thinking', content: delta.thinking });
            }
          }
        }
        const final = await stream.finalMessage();
        for (const c of final.content) {
          if (c.type === 'tool_use') toolCalls.push({ name: c.name, args: c.input as Record<string, unknown> });
        }
      } else {
        const res = await client.messages.create({ ...payload, stream: false }) as Anthropic.Message;
        for (const c of res.content) {
          if (c.type === 'text') textParts.push(c.text);
          else if (c.type === 'tool_use') toolCalls.push({ name: c.name, args: c.input as Record<string, unknown> });
        }
      }
      return { success: true, data: { text: textParts.join(''), toolCalls } };
    } catch (e: any) { return { success: false, error: `[Claude] askWithTools 실패: ${e.message}` }; }
  }
}
