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
    // tool exchanges (multi-turn) — tool_use_id는 assistant/user 메시지 간 반드시 일치
    toolExchanges.forEach((ex, exIdx) => {
      const useIds = ex.toolCalls.map((_, i) => `toolu_${exIdx}_${i}`);
      msgs.push({
        role: 'assistant',
        content: ex.toolCalls.map((tc, i) => ({ type: 'tool_use' as const, id: useIds[i], name: tc.name, input: tc.args })),
      });
      msgs.push({
        role: 'user',
        content: ex.toolResults.map((tr, i) => ({ type: 'tool_result' as const, tool_use_id: useIds[i] ?? `toolu_${exIdx}_${i}`, content: JSON.stringify(tr.result) })),
      });
    });
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
      // MCP connector: 공식 스펙 (2025-11-20) — mcp_servers 는 연결 정의만, 도구 설정은 tools 배열의 mcp_toolset 객체
      const mcpConfig = ctx.resolveMcpConfig?.();
      const useMcp = !!(ctx.config.features?.mcpConnector && mcpConfig?.token);
      const MCP_SERVER_NAME = 'firebat-internal';
      const mcpServers = useMcp ? [{
        type: 'url' as const,
        url: mcpConfig!.url,
        name: MCP_SERVER_NAME,
        authorization_token: mcpConfig!.token,
      }] : undefined;

      // inline tools (MCP 미사용 시) + MCPToolset (MCP 사용 시). 둘은 배타적으로 택일해야 호환.
      const inlineTools: Anthropic.Tool[] = useMcp ? [] : tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as any,
        ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));
      const mcpToolsets = useMcp ? [{ type: 'mcp_toolset' as const, mcp_server_name: MCP_SERVER_NAME }] : [];
      const combinedTools: any[] = [...inlineTools, ...mcpToolsets];

      const messages = this.buildMessages(history, prompt, toolExchanges, opts);
      const budgetMap: Record<string, number> = {
        low: 4000, medium: 10000, high: 20000, xhigh: 32000, max: 64000,
      };
      const level = opts?.thinkingLevel ?? 'medium';
      const budget = budgetMap[level];
      const thinking = ctx.config.features?.extendedThinking && level !== 'none' && budget
        ? { type: 'enabled' as const, budget_tokens: budget }
        : undefined;

      const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = systemPrompt
        ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
        : [];

      // max_tokens: Claude 4 시리즈는 최대 64K output 지원. 분석 응답 truncation 방지.
      const maxTokens = 32000;

      const betas = useMcp ? ['mcp-client-2025-11-20'] : undefined;
      // Extended thinking 활성 시 temperature 무시됨 (Anthropic 공식 제약). 아니면 opts 값 사용.
      const tempValue = typeof opts?.temperature === 'number' ? opts.temperature : undefined;
      const payload: any = {
        model: ctx.config.id,
        max_tokens: maxTokens,
        ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
        messages,
        ...(combinedTools.length > 0 ? { tools: combinedTools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(tempValue !== undefined && !thinking ? { temperature: tempValue } : {}),
        ...(mcpServers ? { mcp_servers: mcpServers } : {}),
        ...(betas ? { betas } : {}),
      };

      const textParts: string[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      // MCP 경유 호출은 beta namespace 필수 (client.beta.messages.*)
      const api = useMcp ? client.beta.messages : client.messages;

      if (opts?.onChunk) {
        const stream = (api as any).stream(payload);
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
        for (const c of final.content as any[]) {
          if (c.type === 'tool_use' || c.type === 'mcp_tool_use') {
            toolCalls.push({ name: c.name, args: (c.input as Record<string, unknown>) ?? {} });
          }
        }
      } else {
        const res = await (api as any).create({ ...payload, stream: false });
        for (const c of res.content as any[]) {
          if (c.type === 'text') textParts.push(c.text);
          else if (c.type === 'tool_use' || c.type === 'mcp_tool_use') {
            toolCalls.push({ name: c.name, args: (c.input as Record<string, unknown>) ?? {} });
          }
        }
      }
      return { success: true, data: { text: textParts.join(''), toolCalls } };
    } catch (e: any) { return { success: false, error: `[Claude] askWithTools 실패: ${e.message}` }; }
  }
}
