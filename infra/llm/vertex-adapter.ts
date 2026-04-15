import { ILlmPort, LlmCallOpts, ChatMessage, LlmJsonResponse, ToolDefinition, ToolExchangeEntry, LlmToolResponse } from '../../core/ports';
import { InfraResult } from '../../core/types';
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_MODEL, DEFAULT_VERTEX_LOCATION, LLM_TIMEOUT_MS, LLM_TEMPERATURE_JSON, LLM_TEMPERATURE_TEXT } from '../config';

/**
 * Vertex AI 어댑터 (Google Cloud AI Platform)
 *
 * - 싱글톤: API 키를 Vault에서 lazy 로드, 변경 시 자동 재초기화
 * - 요청별 모델 오버라이드: opts.model로 호출마다 다른 모델 사용 가능
 */
export class VertexAiAdapter implements ILlmPort {
  private ai: GoogleGenAI | null = null;
  private cachedApiKey: string | null = null;

  constructor(
    private readonly resolveApiKey: () => string | null,
    private readonly resolveProject: () => string | undefined,
    private readonly resolveLocation: () => string,
    private readonly defaultModel: string = DEFAULT_MODEL,
  ) {}

  getModelId(): string {
    return this.defaultModel;
  }

  /** API 키가 변경되면 클라이언트 재생성, 미설정이면 null */
  private getClient(): GoogleGenAI | null {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return null;
    if (apiKey !== this.cachedApiKey) {
      const project = this.resolveProject();
      const location = this.resolveLocation();
      // @google/genai 타입 정의가 vertexai 옵션을 포함하지 않아 타입 단언 필요
      this.ai = project
        ? new GoogleGenAI({ vertexai: true, project, location, apiKey } as Record<string, unknown> as ConstructorParameters<typeof GoogleGenAI>[0])
        : new GoogleGenAI({ apiKey, vertexai: true } as Record<string, unknown> as ConstructorParameters<typeof GoogleGenAI>[0]);
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
    if (!ai) return { success: false, error: 'Vertex AI API 키가 누락되었습니다. 설정(톱니바퀴)에서 Vertex AI 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      const contents = history.map(h => ({
        role: h.role,
        parts: [{ text: typeof h.content === 'string' && h.content.trim() ? h.content : JSON.stringify(h) }],
      }));
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const supportsThinking = model.includes('2.5');
      const response = await this.withTimeout(
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: systemPrompt || '',
            responseMimeType: 'application/json',
            temperature: LLM_TEMPERATURE_JSON,
            ...(supportsThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
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
      return { success: false, error: `[VertexAI] ask 실패: ${e.message}` };
    }
  }

  async askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history: ChatMessage[] = [], toolExchanges: ToolExchangeEntry[] = [], opts?: LlmCallOpts): Promise<InfraResult<LlmToolResponse>> {
    const ai = this.getClient();
    if (!ai) return { success: false, error: 'Vertex AI API 키가 누락되었습니다. 설정(톱니바퀴)에서 Vertex AI 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      // 대화 히스토리 → contents
      const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = history.map(h => ({
        role: (h.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
        parts: [{ text: typeof h.content === 'string' && h.content.trim() ? h.content : JSON.stringify(h) }],
      }));
      // 사용자 프롬프트
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      // 멀티턴 도구 교환 히스토리 추가 (이전 턴의 호출 → 결과)
      for (const exchange of toolExchanges) {
        // 모델의 도구 호출
        contents.push({
          role: 'model',
          parts: exchange.toolCalls.map(tc => ({
            functionCall: { name: tc.name, args: tc.args },
          })),
        });
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

      const response = await this.withTimeout(
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: systemPrompt,
            temperature: LLM_TEMPERATURE_TEXT,
            tools: [{ functionDeclarations }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            thinkingConfig: { thinkingBudget: 0 },
          } as Record<string, unknown>,
        }),
        LLM_TIMEOUT_MS,
      );

      // 응답 파싱 — 텍스트 파트와 functionCall 파트 분리
      const textParts: string[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      const candidates = (response as unknown as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined;
      if (candidates && candidates.length > 0) {
        const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;
        if (parts) {
          for (const part of parts) {
            if (part.text && typeof part.text === 'string') {
              textParts.push(part.text);
            }
            if (part.functionCall && typeof part.functionCall === 'object') {
              const fc = part.functionCall as Record<string, unknown>;
              toolCalls.push({
                name: fc.name as string,
                args: (fc.args as Record<string, unknown>) ?? {},
              });
            }
          }
        }
      }

      // response.text 폴백 (candidates 파싱 실패 시)
      if (textParts.length === 0 && toolCalls.length === 0) {
        const fallbackText = response.text || '';
        if (fallbackText) textParts.push(fallbackText);
      }

      return {
        success: true,
        data: { text: textParts.join(''), toolCalls },
      };
    } catch (e: any) {
      return { success: false, error: `[VertexAI] askWithTools 실패: ${e.message}` };
    }
  }

  async askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>> {
    const ai = this.getClient();
    if (!ai) return { success: false, error: 'Vertex AI API 키가 누락되었습니다. 설정(톱니바퀴)에서 Vertex AI 키를 입력해주세요.' };

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
      return { success: false, error: `[VertexAI] askText 실패: ${e.message}` };
    }
  }
}
