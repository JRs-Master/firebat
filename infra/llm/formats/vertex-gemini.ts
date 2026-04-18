/**
 * vertex-gemini format handler
 *
 * Google Cloud Vertex AI (프로덕션/엔터프라이즈) 경유 Gemini 호출.
 * AI Studio와 달리 Service Account JSON + OAuth2 access token 기반 인증.
 *
 * 인증 흐름:
 * - Vault에서 `GOOGLE_SERVICE_ACCOUNT_JSON` (전체 JSON 문자열) 로드
 * - @google/genai SDK의 googleAuthOptions.credentials로 전달 → SDK가 access token 자동 갱신
 * - project / location은 config의 extraHeaders 또는 별도 필드로 읽음
 */
import { GoogleGenAI } from '@google/genai';
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';
import { LLM_TIMEOUT_MS, LLM_TEMPERATURE_JSON, LLM_TEMPERATURE_TEXT } from '../../config';

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

export class VertexGeminiFormat implements FormatHandler {
  private clientCache = new WeakMap<FormatHandlerContext, { saKey: string; project?: string; location?: string; client: GoogleGenAI }>();

  private getClient(ctx: FormatHandlerContext): GoogleGenAI | null {
    const saJson = ctx.resolveApiKey();
    if (!saJson) return null;
    let credentials: Record<string, unknown>;
    try { credentials = JSON.parse(saJson); }
    catch { return null; }
    const project = (credentials.project_id as string | undefined) || (ctx.config.extraHeaders?.['x-vertex-project']);
    const location = ctx.config.extraHeaders?.['x-vertex-location'] || 'us-central1';
    const cached = this.clientCache.get(ctx);
    if (cached && cached.saKey === saJson && cached.project === project && cached.location === location) {
      return cached.client;
    }
    const client = new GoogleGenAI({
      vertexai: true,
      project,
      location,
      googleAuthOptions: { credentials: credentials as any },
    } as Record<string, unknown> as ConstructorParameters<typeof GoogleGenAI>[0]);
    this.clientCache.set(ctx, { saKey: saJson, project, location, client });
    return client;
  }

  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const ai = this.getClient(ctx);
    if (!ai) return { success: false, error: 'Vertex AI 서비스 계정 JSON이 누락되었습니다. 설정(톱니바퀴) → API 키 탭에서 등록해주세요.' };
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
    } catch (e: any) { return { success: false, error: `[VertexAI] ask 실패: ${e.message}` }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const ai = this.getClient(ctx);
    if (!ai) return { success: false, error: 'Vertex AI 서비스 계정 JSON이 누락되었습니다.' };
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
    } catch (e: any) { return { success: false, error: `[VertexAI] askText 실패: ${e.message}` }; }
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[], toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const ai = this.getClient(ctx);
    if (!ai) return { success: false, error: 'Vertex AI 서비스 계정 JSON이 누락되었습니다.' };
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

      // Gemini 공통: enum은 string 배열 + integer/number에 enum 금지
      const adaptSchema = (schema: unknown): unknown => {
        if (!schema || typeof schema !== 'object') return schema;
        if (Array.isArray(schema)) return schema.map(adaptSchema);
        const s = schema as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s)) {
          if (k === 'enum' && Array.isArray(v)) {
            const type = s.type as string | undefined;
            if (type === 'integer' || type === 'number') continue;
            result[k] = v.map(e => String(e));
          } else if (v && typeof v === 'object') {
            result[k] = adaptSchema(v);
          } else { result[k] = v; }
        }
        return result;
      };
      const functionDeclarations = tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: adaptSchema(t.parameters),
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
    } catch (e: any) { return { success: false, error: `[VertexAI] askWithTools 실패: ${e.message}` }; }
  }
}
