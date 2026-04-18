/**
 * openai-chat format handler
 *
 * 표준 OpenAI Chat Completions API — 대부분의 OpenAI-호환 프로바이더가 지원.
 * (Gemini OpenAI-compat 엔드포인트, OpenRouter, OpenAI GPT-4.1 등)
 *
 * Responses API 전용 기능(MCP connector, previous_response_id 등)은 지원 안 함.
 */
import OpenAI from 'openai';
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';
import { LLM_TIMEOUT_MS, LLM_TEMPERATURE_JSON, LLM_TEMPERATURE_TEXT } from '../../config';

export class OpenAIChatFormat implements FormatHandler {
  private clientCache = new WeakMap<FormatHandlerContext, { key: string; client: OpenAI }>();

  private getClient(ctx: FormatHandlerContext): OpenAI | null {
    const apiKey = ctx.resolveApiKey();
    if (!apiKey) return null;
    const cached = this.clientCache.get(ctx);
    if (cached && cached.key === apiKey) return cached.client;
    const client = new OpenAI({
      apiKey,
      baseURL: ctx.config.endpoint.replace(/\/chat\/completions$/, ''),
      timeout: LLM_TIMEOUT_MS,
      defaultHeaders: ctx.config.extraHeaders,
    });
    this.clientCache.set(ctx, { key: apiKey, client });
    return client;
  }

  private toMessages(history: ChatMessage[], prompt: string, opts?: LlmCallOpts): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = history.map(h => {
      const role = h.role === 'assistant' ? 'assistant' : h.role === 'system' ? 'system' : 'user';
      if (h.image && role === 'user') {
        const url = h.image.startsWith('data:') ? h.image : `data:${h.imageMimeType || 'image/jpeg'};base64,${h.image}`;
        return { role: 'user', content: [{ type: 'text', text: h.content }, { type: 'image_url', image_url: { url } }] } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }
      return { role, content: h.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    });
    if (opts?.image) {
      const url = opts.image.startsWith('data:') ? opts.image : `data:${opts.imageMimeType || 'image/jpeg'};base64,${opts.image}`;
      msgs.push({ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }] });
    } else {
      msgs.push({ role: 'user', content: prompt });
    }
    return msgs;
  }

  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const client = this.getClient(ctx);
    if (!client) return { success: false, error: `${ctx.config.displayName} API 키가 누락되었습니다.` };
    try {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push(...this.toMessages(history, prompt, opts));
      const res = await client.chat.completions.create({
        model: ctx.config.id,
        messages,
        ...(ctx.config.features?.temperature !== false ? { temperature: LLM_TEMPERATURE_JSON } : {}),
        response_format: { type: 'json_object' },
      });
      const text = res.choices[0]?.message?.content || '';
      try { return { success: true, data: JSON.parse(text) as LlmJsonResponse }; }
      catch { return { success: true, data: { thoughts: '', reply: text, actions: [], suggestions: [] } }; }
    } catch (e: any) { return { success: false, error: `[${ctx.config.provider}] ask 실패: ${e.message}` }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const client = this.getClient(ctx);
    if (!client) return { success: false, error: `${ctx.config.displayName} API 키가 누락되었습니다.` };
    try {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });
      const res = await client.chat.completions.create({
        model: ctx.config.id, messages,
        ...(ctx.config.features?.temperature !== false ? { temperature: LLM_TEMPERATURE_TEXT } : {}),
      });
      return { success: true, data: res.choices[0]?.message?.content || '' };
    } catch (e: any) { return { success: false, error: `[${ctx.config.provider}] askText 실패: ${e.message}` }; }
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[], toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const client = this.getClient(ctx);
    if (!client) return { success: false, error: `${ctx.config.displayName} API 키가 누락되었습니다.` };
    try {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push(...this.toMessages(history, prompt, opts));
      // 멀티턴 toolExchanges 반영 — tool_call_id는 assistant/tool 메시지 간 반드시 일치해야 함
      // Gemini OpenAI-compat: content:null 거부 → 빈 문자열 사용
      toolExchanges.forEach((ex, exIdx) => {
        const callIds = ex.toolCalls.map((_, i) => `call_${exIdx}_${i}`);
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: ex.toolCalls.map((tc, i) => ({ id: callIds[i], type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
        });
        ex.toolResults.forEach((tr, i) => messages.push({ role: 'tool', tool_call_id: callIds[i] ?? `call_${exIdx}_${i}`, content: JSON.stringify(tr.result) }));
      });
      const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown>, ...(t.strict && ctx.config.features?.strictTools ? { strict: true } : {}) },
      }));
      const payload: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: ctx.config.id,
        messages,
        ...(ctx.config.features?.temperature !== false ? { temperature: LLM_TEMPERATURE_TEXT } : {}),
        ...(openaiTools.length > 0 ? { tools: openaiTools, tool_choice: 'auto' } : {}),
      };

      const textParts: string[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      if (opts?.onChunk) {
        const stream = await client.chat.completions.create({ ...payload, stream: true });
        const acc: Record<number, { name: string; args: string }> = {};
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            textParts.push(delta.content);
            opts.onChunk({ type: 'text', content: delta.content });
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!acc[i]) acc[i] = { name: '', args: '' };
              if (tc.function?.name) acc[i].name = tc.function.name;
              if (tc.function?.arguments) acc[i].args += tc.function.arguments;
            }
          }
        }
        for (const k of Object.keys(acc).sort((a, b) => Number(a) - Number(b))) {
          const a = acc[Number(k)];
          try { toolCalls.push({ name: a.name, args: a.args ? JSON.parse(a.args) : {} }); }
          catch { toolCalls.push({ name: a.name, args: {} }); }
        }
      } else {
        const res = await client.chat.completions.create({ ...payload, stream: false });
        const msg = res.choices[0]?.message;
        if (msg?.content) textParts.push(msg.content);
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.type === 'function') {
              try { toolCalls.push({ name: tc.function.name, args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {} }); }
              catch { toolCalls.push({ name: tc.function.name, args: {} }); }
            }
          }
        }
      }
      return { success: true, data: { text: textParts.join(''), toolCalls } };
    } catch (e: any) {
      // 400 디버깅용 상세 로그 (응답 body + 요청 페이로드)
      const status = e?.status || e?.response?.status;
      const body = e?.error?.message || e?.response?.data || e?.body || e?.error || '';
      const detail = body ? ` | detail: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 500)}` : '';
      const reqDump = status === 400 ? ` | req: ${JSON.stringify({ model: ctx.config.id, toolCount: tools.length, exchangeCount: toolExchanges.length, messageCount: toolExchanges.length * 2 + 1 }).slice(0, 400)}` : '';
      // 추가: 첫 번째 도구 메시지 구조 덤프 (400일 때만)
      const lastExDump = status === 400 && toolExchanges.length > 0
        ? ` | lastExchange: ${JSON.stringify({
            toolCalls: toolExchanges[toolExchanges.length - 1].toolCalls.map(tc => ({ name: tc.name, argsKeys: Object.keys(tc.args || {}) })),
            toolResults: toolExchanges[toolExchanges.length - 1].toolResults.map(tr => ({ name: tr.name, result: JSON.stringify(tr.result).slice(0, 120) })),
          }).slice(0, 500)}`
        : '';
      return { success: false, error: `[${ctx.config.provider}] askWithTools 실패: ${e.message}${detail}${reqDump}${lastExDump}` };
    }
  }
}
