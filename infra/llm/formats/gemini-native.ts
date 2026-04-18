/**
 * gemini-native format handler
 *
 * Google Gemini AI Studio — @google/genai SDK로 네이티브 호출.
 * (OpenAI-compat 프록시 대신 Gemini 고유 형식 사용 → function calling 멀티턴 안정적)
 *
 * 인증: API Key만 (Vertex와 달리 OAuth 불필요)
 */
import { GoogleGenAI } from '@google/genai';
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';
import { LLM_TIMEOUT_MS, LLM_TEMPERATURE_JSON, LLM_TEMPERATURE_TEXT } from '../../config';
import { adaptSchemaForGemini } from './_gemini-shared';

function buildThinkingConfig(level: string): Record<string, unknown> {
  if (level === 'minimal') return { thinkingLevel: 'minimal' };
  return { includeThoughts: true, thinkingLevel: level };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`LLM 응답 시간 초과 (${ms / 1000}초)`)), ms)),
  ]);
}

export class GeminiNativeFormat implements FormatHandler {
  private clientCache = new WeakMap<FormatHandlerContext, { apiKey: string; client: GoogleGenAI }>();

  private getClient(ctx: FormatHandlerContext): GoogleGenAI | null {
    const apiKey = ctx.resolveApiKey();
    if (!apiKey) return null;
    const cached = this.clientCache.get(ctx);
    if (cached && cached.apiKey === apiKey) return cached.client;
    const client = new GoogleGenAI({ apiKey });
    this.clientCache.set(ctx, { apiKey, client });
    return client;
  }

  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const ai = this.getClient(ctx);
    if (!ai) return { success: false, error: 'Gemini API 키가 누락되었습니다.' };
    try {
      const contents = history.map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof h.content === 'string' && h.content.trim() ? h.content : JSON.stringify(h) }],
      }));
      contents.push({ role: 'user', parts: [{ text: prompt }] });
      const response = await withTimeout(
        ai.models.generateContent({
          model: ctx.config.id,
          contents,
          config: {
            systemInstruction: systemPrompt || '',
            responseMimeType: 'application/json',
            temperature: LLM_TEMPERATURE_JSON,
          },
        }),
        LLM_TIMEOUT_MS,
      );
      const text = response.text || '';
      try { return { success: true, data: JSON.parse(text) as LlmJsonResponse }; }
      catch { return { success: true, data: { thoughts: '', reply: text, actions: [], suggestions: [] } }; }
    } catch (e: any) { return { success: false, error: `[Gemini] ask 실패: ${e.message}` }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const ai = this.getClient(ctx);
    if (!ai) return { success: false, error: 'Gemini API 키가 누락되었습니다.' };
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: ctx.config.id,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { systemInstruction: systemPrompt || '', temperature: LLM_TEMPERATURE_TEXT },
        }),
        LLM_TIMEOUT_MS,
      );
      return { success: true, data: response.text || '' };
    } catch (e: any) { return { success: false, error: `[Gemini] askText 실패: ${e.message}` }; }
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[], toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const ai = this.getClient(ctx);
    if (!ai) return { success: false, error: 'Gemini API 키가 누락되었습니다.' };
    try {
      const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = history.map(h => {
        const parts: Array<Record<string, unknown>> = [{ text: typeof h.content === 'string' && h.content.trim() ? h.content : JSON.stringify(h) }];
        if (h.image) {
          const base64 = h.image.includes(',') ? h.image.split(',')[1] : h.image;
          const mimeType = h.imageMimeType || (h.image.match(/^data:([^;]+);/)?.[1]) || 'image/jpeg';
          parts.push({ inlineData: { data: base64, mimeType } });
        }
        return { role: (h.role === 'assistant' ? 'model' : 'user') as 'user' | 'model', parts };
      });
      const userParts: Array<Record<string, unknown>> = [{ text: prompt }];
      if (opts?.image) {
        const base64 = opts.image.includes(',') ? opts.image.split(',')[1] : opts.image;
        const mimeType = opts.imageMimeType || (opts.image.match(/^data:([^;]+);/)?.[1]) || 'image/jpeg';
        userParts.push({ inlineData: { data: base64, mimeType } });
      }
      contents.push({ role: 'user', parts: userParts });

      // 멀티턴 도구 교환 — Gemini 네이티브 형식으로 전달 (functionCall/functionResponse)
      for (const ex of toolExchanges) {
        if (ex.rawModelParts && Array.isArray(ex.rawModelParts)) {
          contents.push({ role: 'model', parts: ex.rawModelParts as Array<Record<string, unknown>> });
        } else {
          contents.push({
            role: 'model',
            parts: ex.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.args } })),
          });
        }
        contents.push({
          role: 'user',
          parts: ex.toolResults.map(tr => ({ functionResponse: { name: tr.name, response: tr.result } })),
        });
      }

      const functionDeclarations = tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: adaptSchemaForGemini(t.parameters),
      }));

      const requestConfig = {
        model: ctx.config.id,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: LLM_TEMPERATURE_TEXT,
          ...(ctx.config.features?.thinking ? { thinkingConfig: buildThinkingConfig(opts?.thinkingLevel ?? 'low') } : {}),
          ...(functionDeclarations.length > 0 ? {
            tools: [{ functionDeclarations }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          } : {}),
        } as Record<string, unknown>,
      };

      const textParts: string[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let rawModelParts: unknown[] | undefined;

      if (opts?.onChunk) {
        const stream = await withTimeout(ai.models.generateContentStream(requestConfig), LLM_TIMEOUT_MS);
        const allParts: Record<string, unknown>[] = [];
        for await (const chunk of stream) {
          const candidates = (chunk as unknown as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined;
          if (!candidates?.[0]) continue;
          const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
          if (!parts) continue;
          for (const part of parts) {
            allParts.push(part);
            if (part.text && typeof part.text === 'string') {
              if (part.thought) opts.onChunk({ type: 'thinking', content: part.text });
              else { textParts.push(part.text); opts.onChunk({ type: 'text', content: part.text }); }
            }
            if (part.functionCall && typeof part.functionCall === 'object') {
              const fc = part.functionCall as Record<string, unknown>;
              toolCalls.push({ name: fc.name as string, args: (fc.args as Record<string, unknown>) ?? {} });
            }
          }
        }
        rawModelParts = allParts.length > 0 ? allParts : undefined;
      } else {
        const response = await withTimeout(ai.models.generateContent(requestConfig), LLM_TIMEOUT_MS);
        const candidates = (response as unknown as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined;
        if (candidates && candidates.length > 0) {
          const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
          if (parts) {
            rawModelParts = parts;
            for (const part of parts) {
              if (part.text && typeof part.text === 'string' && !part.thought) textParts.push(part.text);
              if (part.functionCall && typeof part.functionCall === 'object') {
                const fc = part.functionCall as Record<string, unknown>;
                toolCalls.push({ name: fc.name as string, args: (fc.args as Record<string, unknown>) ?? {} });
              }
            }
          }
        }
        if (textParts.length === 0 && toolCalls.length === 0) {
          const fallbackText = response.text || '';
          if (fallbackText) textParts.push(fallbackText);
        }
      }

      return { success: true, data: { text: textParts.join(''), toolCalls, rawModelParts } };
    } catch (e: any) { return { success: false, error: `[Gemini] askWithTools 실패: ${e.message}` }; }
  }
}
