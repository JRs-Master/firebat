import { ILlmPort, LlmCallOpts, ChatMessage, LlmJsonResponse, ToolDefinition, ToolExchangeEntry, LlmToolResponse } from '../../core/ports';
import { InfraResult } from '../../core/types';
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_MODEL, LLM_TIMEOUT_MS, LLM_TEMPERATURE_JSON, LLM_TEMPERATURE_TEXT } from '../config';

/** thinkingConfig — Gemini 3+: thinkingLevel (minimal/low/medium/high) */
function buildThinkingConfig(level: string): Record<string, unknown> {
  if (level === 'minimal') return { thinkingLevel: 'minimal' };
  return { includeThoughts: true, thinkingLevel: level };
}

/**
 * Gemini 어댑터 (Google AI Studio 직접 호출)
 *
 * - 싱글톤: API 키를 Vault에서 lazy 로드, 변경 시 자동 재초기화
 * - 요청별 모델 오버라이드: opts.model로 호출마다 다른 모델 사용 가능
 */
export class GeminiAdapter implements ILlmPort {
  private ai: GoogleGenAI | null = null;
  private cachedApiKey: string | null = null;

  constructor(
    private readonly resolveApiKey: () => string | null,
    private readonly defaultModel: string = DEFAULT_MODEL,
  ) {}

  getModelId(): string {
    return this.defaultModel;
  }

  /** API 키 변경 시 클라이언트 재생성, 미설정이면 null */
  private getClient(): GoogleGenAI | null {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return null;
    if (apiKey !== this.cachedApiKey) {
      this.ai = new GoogleGenAI({ apiKey });
      this.cachedApiKey = apiKey;
    }
    return this.ai;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`LLM 응답 시간 초과 (${ms / 1000}초)`)), ms)
      ),
    ]);
  }

  async ask(prompt: string, systemPrompt?: string, history: ChatMessage[] = [], opts?: LlmCallOpts): Promise<InfraResult<LlmJsonResponse>> {
    const ai = this.getClient();
    if (!ai) return { success: false, error: 'Gemini API 키가 누락되었습니다. 설정(톱니바퀴)에서 Gemini API 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      const contents = history.map(h => ({
        role: h.role,
        parts: [{ text: typeof h.content === 'string' && h.content.trim() ? h.content : JSON.stringify(h) }],
      }));
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const response = await this.withTimeout(
        ai.models.generateContent({
          model,
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
      try {
        return { success: true, data: JSON.parse(text) as LlmJsonResponse };
      } catch {
        // JSON 파싱 실패 — 빈 응답으로 래핑
        return { success: true, data: { thoughts: '', reply: text, actions: [], suggestions: [] } };
      }
    } catch (e: any) {
      return { success: false, error: `[Gemini] ask 실패: ${e.message}` };
    }
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[] = [], toolExchanges: ToolExchangeEntry[] = [], opts?: LlmCallOpts): Promise<InfraResult<LlmToolResponse>> {
    const ai = this.getClient();
    if (!ai) return { success: false, error: 'Gemini API 키가 누락되었습니다. 설정(톱니바퀴)에서 Gemini API 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      // 대화 히스토리 → contents (이미지 포함)
      const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = history.map(h => {
        const parts: Array<Record<string, unknown>> = [{ text: typeof h.content === 'string' && h.content.trim() ? h.content : JSON.stringify(h) }];
        if (h.image) {
          const base64 = h.image.includes(',') ? h.image.split(',')[1] : h.image;
          const mimeType = h.imageMimeType || (h.image.match(/^data:([^;]+);/)?.[1]) || 'image/jpeg';
          parts.push({ inlineData: { data: base64, mimeType } });
        }
        return { role: (h.role === 'assistant' ? 'model' : 'user') as 'user' | 'model', parts };
      });
      // 사용자 프롬프트 (이미지는 opts.image로 전달)
      const userParts: Array<Record<string, unknown>> = [{ text: prompt }];
      if (opts?.image) {
        const base64 = opts.image.includes(',') ? opts.image.split(',')[1] : opts.image;
        const mimeType = opts.imageMimeType || (opts.image.match(/^data:([^;]+);/)?.[1]) || 'image/jpeg';
        userParts.push({ inlineData: { data: base64, mimeType } });
      }
      contents.push({ role: 'user', parts: userParts });

      // 멀티턴 도구 교환 히스토리 추가 (이전 턴의 호출 → 결과)
      for (const exchange of toolExchanges) {
        // 모델의 도구 호출 — 원본 parts가 있으면 그대로 사용 (thought_signature 보존)
        if (exchange.rawModelParts && Array.isArray(exchange.rawModelParts)) {
          contents.push({
            role: 'model',
            parts: exchange.rawModelParts as Array<Record<string, unknown>>,
          });
        } else {
          contents.push({
            role: 'model',
            parts: exchange.toolCalls.map(tc => ({
              functionCall: { name: tc.name, args: tc.args },
            })),
          });
        }
        // 도구 실행 결과
        contents.push({
          role: 'user',
          parts: exchange.toolResults.map(tr => ({
            functionResponse: { name: tr.name, response: tr.result },
          })),
        });
      }

      // ToolDefinition[] → Gemini functionDeclarations 변환
      const functionDeclarations = tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

      const requestConfig = {
        model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: LLM_TEMPERATURE_TEXT,
          thinkingConfig: buildThinkingConfig(opts?.thinkingLevel ?? 'low'),
          // 도구가 없으면 tools/toolConfig 생략 (빈 배열 전달 시 Vertex AI 400 에러)
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
        // ── 스트리밍 모드 ──
        const stream = await this.withTimeout(
          ai.models.generateContentStream(requestConfig),
          LLM_TIMEOUT_MS,
        );

        const allParts: Record<string, unknown>[] = [];

        for await (const chunk of stream) {
          const candidates = (chunk as unknown as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined;
          if (!candidates?.[0]) continue;
          const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
          if (!parts) continue;

          for (const part of parts) {
            allParts.push(part);
            if (part.text && typeof part.text === 'string') {
              if (part.thought) {
                opts.onChunk({ type: 'thinking', content: part.text });
              } else {
                textParts.push(part.text);
                opts.onChunk({ type: 'text', content: part.text });
              }
            }
            if (part.functionCall && typeof part.functionCall === 'object') {
              const fc = part.functionCall as Record<string, unknown>;
              toolCalls.push({ name: fc.name as string, args: (fc.args as Record<string, unknown>) ?? {} });
            }
          }
        }

        rawModelParts = allParts.length > 0 ? allParts : undefined;
      } else {
        // ── 비스트리밍 모드 (기존) ──
        const response = await this.withTimeout(
          ai.models.generateContent(requestConfig),
          LLM_TIMEOUT_MS,
        );

        const candidates = (response as unknown as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined;
        if (candidates && candidates.length > 0) {
          const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
          if (parts) {
            rawModelParts = parts;
            for (const part of parts) {
              if (part.text && typeof part.text === 'string') {
                if (!part.thought) textParts.push(part.text);
              }
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

      return {
        success: true,
        data: { text: textParts.join(''), toolCalls, rawModelParts },
      };
    } catch (e: any) {
      return { success: false, error: `[Gemini] askWithTools 실패: ${e.message}` };
    }
  }

  async askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>> {
    const ai = this.getClient();
    if (!ai) return { success: false, error: 'Gemini API 키가 누락되었습니다. 설정(톱니바퀴)에서 Gemini API 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      const response = await this.withTimeout(
        ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            systemInstruction: systemPrompt || '',
            temperature: LLM_TEMPERATURE_TEXT,
          },
        }),
        LLM_TIMEOUT_MS,
      );

      return { success: true, data: response.text || '' };
    } catch (e: any) {
      return { success: false, error: `[Gemini] askText 실패: ${e.message}` };
    }
  }
}
