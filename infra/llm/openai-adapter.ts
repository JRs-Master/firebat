import type { ILlmPort, LlmCallOpts, ChatMessage, LlmJsonResponse, ToolDefinition, ToolExchangeEntry, LlmToolResponse } from '../../core/ports';
import type { InfraResult } from '../../core/types';
import OpenAI from 'openai';
import { DEFAULT_MODEL, LLM_TIMEOUT_MS, LLM_TEMPERATURE_TEXT } from '../config';

/**
 * OpenAI 어댑터 — Responses API (/v1/responses) + Function Calling + Streaming + Vision
 *
 * - 싱글톤: API 키를 Vault에서 lazy 로드, 변경 시 자동 재초기화
 * - 요청별 모델 오버라이드: opts.model로 호출마다 다른 모델 사용 가능
 * - Responses API의 prompt caching / 40~80% 캐시 효율 자동 활용
 * - strict function calling: 스키마 엄격 준수 (JSON 누출/enum 위반 차단)
 */
export class OpenAiAdapter implements ILlmPort {
  private client: OpenAI | null = null;
  private cachedApiKey: string | null = null;

  constructor(
    private readonly resolveApiKey: () => string | null,
    private readonly defaultModel: string = DEFAULT_MODEL,
    // 내부 MCP connector 설정 — Vault에서 토큰+URL lazy 로드
    private readonly resolveMcpConfig?: () => { url: string; token: string } | null,
    // tool_search 지원 여부 (gpt-5.4-mini/gpt-5.4만 지원, nano는 미지원)
    private readonly supportsToolSearch: boolean = true,
  ) {}

  getModelId(): string {
    return this.defaultModel;
  }

  private getClient(): OpenAI | null {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return null;
    if (apiKey !== this.cachedApiKey) {
      this.client = new OpenAI({ apiKey, timeout: LLM_TIMEOUT_MS });
      this.cachedApiKey = apiKey;
    }
    return this.client;
  }

  /** ChatMessage[] + 현재 prompt + toolExchanges → Responses API input 배열 */
  private buildInput(
    history: ChatMessage[],
    prompt: string,
    currentImage: string | undefined,
    currentImageMimeType: string | undefined,
    toolExchanges: ToolExchangeEntry[],
  ): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];

    // 대화 히스토리
    for (const h of history) {
      const role = h.role === 'assistant' ? 'assistant' : h.role === 'system' ? 'system' : 'user';
      if (h.image && role === 'user') {
        const imageUrl = h.image.startsWith('data:')
          ? h.image
          : `data:${h.imageMimeType || 'image/jpeg'};base64,${h.image}`;
        input.push({
          role,
          content: [
            { type: 'input_text', text: h.content },
            { type: 'input_image', image_url: imageUrl },
          ],
        });
      } else {
        input.push({ role, content: h.content });
      }
    }

    // 현재 사용자 입력 (이미지 포함)
    if (currentImage) {
      const imageUrl = currentImage.startsWith('data:')
        ? currentImage
        : `data:${currentImageMimeType || 'image/jpeg'};base64,${currentImage}`;
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageUrl },
        ],
      });
    } else {
      input.push({ role: 'user', content: prompt });
    }

    // 멀티턴 도구 교환: function_call + function_call_output (결과 8000자 제한으로 토큰 폭발 방지)
    const MAX_RESULT_LEN = 8000;
    const trimResult = (r: unknown): string => {
      const s = JSON.stringify(r ?? {});
      return s.length > MAX_RESULT_LEN
        ? s.slice(0, MAX_RESULT_LEN) + `...[${s.length - MAX_RESULT_LEN}자 생략]`
        : s;
    };
    for (const exchange of toolExchanges) {
      exchange.toolCalls.forEach((tc, idx) => {
        const callId = `call_${idx}_${exchange.toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`;
        input.push({
          type: 'function_call',
          call_id: callId,
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        });
        const tr = exchange.toolResults[idx];
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: trimResult(tr?.result),
        });
      });
    }

    return input;
  }

  async ask(prompt: string, systemPrompt?: string, history: ChatMessage[] = [], opts?: LlmCallOpts): Promise<InfraResult<LlmJsonResponse>> {
    const client = this.getClient();
    if (!client) return { success: false, error: 'OpenAI API 키가 누락되었습니다. 설정에서 OpenAI API 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      const response = await (client.responses.create as any)({
        model,
        instructions: systemPrompt,
        input: [{ role: 'user', content: prompt }],
        text: { format: { type: 'json_object' } },
      });
      const text = (response as any).output_text || '';
      try {
        return { success: true, data: JSON.parse(text) as LlmJsonResponse };
      } catch {
        return { success: true, data: { thoughts: '', reply: text, actions: [], suggestions: [] } };
      }
    } catch (e: any) {
      return { success: false, error: `[OpenAI] ask 실패: ${e.message}` };
    }
  }

  async askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>> {
    const client = this.getClient();
    if (!client) return { success: false, error: 'OpenAI API 키가 누락되었습니다. 설정에서 OpenAI API 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      const response = await (client.responses.create as any)({
        model,
        instructions: systemPrompt,
        input: [{ role: 'user', content: prompt }],
      });
      return { success: true, data: (response as any).output_text || '' };
    } catch (e: any) {
      return { success: false, error: `[OpenAI] askText 실패: ${e.message}` };
    }
  }

  async askWithTools(
    prompt: string,
    systemPrompt: string,
    tools: ToolDefinition[],
    history: ChatMessage[] = [],
    toolExchanges: ToolExchangeEntry[] = [],
    opts?: LlmCallOpts,
  ): Promise<InfraResult<LlmToolResponse>> {
    const client = this.getClient();
    if (!client) return { success: false, error: 'OpenAI API 키가 누락되었습니다. 설정에서 OpenAI API 키를 입력해주세요.' };

    const model = opts?.model ?? this.defaultModel;
    try {
      // previous_response_id 사용 시 history·toolExchanges 재전송 불필요 — OpenAI 서버가 상태 유지
      const usingPrevResponse = !!opts?.previousResponseId;
      const input = usingPrevResponse
        ? this.buildInput([], prompt, opts?.image, opts?.imageMimeType, [])
        : this.buildInput(history, prompt, opts?.image, opts?.imageMimeType, toolExchanges);

      // MCP connector 설정 확인 — 있으면 MCP 단일 사용 (인라인 중복 방지), 없으면 인라인 폴백
      const mcpConfig = this.resolveMcpConfig?.();
      let openaiTools: Array<Record<string, unknown>>;
      if (mcpConfig?.token) {
        // Tool Search + MCP 조합: OpenAI가 쿼리별 관련 도구만 동적 로드 (gpt-5.4+ mini 이상)
        // tool_search는 defer_loading: true인 도구들을 대상으로 검색/로드
        // nano는 tool_search 미지원 → 전체 도구 로드 (defer_loading 제거)
        const mcpTool: Record<string, unknown> = {
          type: 'mcp',
          server_label: 'firebat-internal',
          server_description: 'Firebat 내부 도구 (페이지/파일/모듈/스케줄/시스템 모듈/UI 컴포넌트 렌더)',
          server_url: mcpConfig.url,
          authorization: mcpConfig.token,
          require_approval: 'never',
        };
        if (this.supportsToolSearch) {
          openaiTools = [{ type: 'tool_search' }, { ...mcpTool, defer_loading: true }];
        } else {
          openaiTools = [mcpTool]; // nano: tool_search 없이 MCP 단독
        }
      } else {
        openaiTools = tools.map(t => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters as unknown as Record<string, unknown>,
          ...(t.strict ? { strict: true } : {}),
        }));
      }

      // GPT-5.4/o 시리즈는 temperature/top_p 미지원 — 모델 prefix로 조건부 제외
      const isReasoningModel = /^(gpt-5|o[1-9])/i.test(model);
      // opts.thinkingLevel (minimal/low/medium/high) → reasoning.effort 매핑
      const effortValue: 'minimal' | 'low' | 'medium' | 'high' | 'none' =
        (opts?.thinkingLevel as any) || 'medium';
      // 24시간 확장 캐시 (gpt-5/gpt-4.1+에서만 유효)
      const supportsExtendedCache = /^(gpt-5|gpt-4\.1)/i.test(model);
      const payload: Record<string, unknown> = {
        model,
        instructions: systemPrompt,
        input,
        ...(isReasoningModel ? {} : { temperature: LLM_TEMPERATURE_TEXT }),
        ...(openaiTools.length > 0 ? { tools: openaiTools, tool_choice: 'auto' } : {}),
        ...(isReasoningModel ? { reasoning: { effort: effortValue, summary: 'auto' } } : {}),
        prompt_cache_key: 'firebat-admin',
        ...(supportsExtendedCache ? { prompt_cache_retention: '24h' } : {}),
        ...(opts?.previousResponseId ? { previous_response_id: opts.previousResponseId } : {}),
      };

      const textParts: string[] = [];
      const toolCalls: Array<{ name: string; args: Record<string, unknown>; preExecutedResult?: Record<string, unknown> }> = [];
      let responseId: string | undefined;

      // 429 Rate limit 재시도 헬퍼 (최대 2회, 응답의 retry-after 값 따라 대기)
      const callWithRetry = async (p: Record<string, unknown>, retry = 2): Promise<any> => {
        try {
          return await (client.responses.create as any)(p);
        } catch (e: any) {
          const msg = e?.message || '';
          const match = msg.match(/try again in ([\d.]+)s/i);
          if (retry > 0 && (e?.status === 429 || /429/.test(msg))) {
            const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 200 : 2000;
            await new Promise(r => setTimeout(r, waitMs));
            return callWithRetry(p, retry - 1);
          }
          throw e;
        }
      };

      if (opts?.onChunk) {
        // ── 스트리밍 모드: responses.create({stream:true}) ──
        const stream = await callWithRetry({ ...payload, stream: true });
        const toolCallAcc: Record<string, { name: string; args: string }> = {};

        for await (const event of stream as AsyncIterable<any>) {
          const t = event.type as string;
          // 응답 생성 시작 — response.id 포착 (previous_response_id용)
          if (t === 'response.created' && event.response?.id) {
            responseId = event.response.id as string;
          }
          else if (t === 'response.completed' && event.response?.id) {
            responseId = event.response.id as string;
          }
          // 텍스트 delta
          else if (t === 'response.output_text.delta' && typeof event.delta === 'string') {
            textParts.push(event.delta);
            opts.onChunk({ type: 'text', content: event.delta });
          }
          // thinking/reasoning delta (GPT-5.4 시리즈 reasoning summary)
          else if ((t === 'response.reasoning.delta' || t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') && typeof event.delta === 'string') {
            opts.onChunk({ type: 'thinking', content: event.delta });
          }
          // function_call 아이템 추가됨 (arguments 스트리밍 전에 name/id 고정)
          else if (t === 'response.output_item.added' && event.item?.type === 'function_call') {
            const callId = event.item.call_id || event.item.id;
            toolCallAcc[callId] = { name: event.item.name || '', args: '' };
          }
          // function_call arguments delta
          else if (t === 'response.function_call_arguments.delta') {
            const callId = event.call_id || event.item_id;
            if (callId && toolCallAcc[callId]) {
              toolCallAcc[callId].args += event.delta as string;
            }
          }
          // function_call 완료
          else if (t === 'response.function_call_arguments.done') {
            const callId = event.call_id || event.item_id;
            if (callId && toolCallAcc[callId]) {
              toolCallAcc[callId].args = event.arguments as string || toolCallAcc[callId].args;
            }
          }
          // MCP call 완료 — OpenAI가 내부적으로 MCP 서버 호출하고 결과까지 받아옴
          else if (t === 'response.output_item.done' && event.item?.type === 'mcp_call') {
            const item = event.item;
            let args: Record<string, unknown> = {};
            try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? {}); } catch {}
            let output: unknown = item.output;
            try { if (typeof output === 'string') output = JSON.parse(output); } catch {}
            toolCalls.push({
              name: item.name as string,
              args,
              preExecutedResult: (output as Record<string, unknown>) ?? { success: true },
            });
          }
        }

        for (const callId of Object.keys(toolCallAcc)) {
          const acc = toolCallAcc[callId];
          try {
            toolCalls.push({ name: acc.name, args: acc.args ? JSON.parse(acc.args) : {} });
          } catch {
            toolCalls.push({ name: acc.name, args: {} });
          }
        }
      } else {
        // ── 비스트리밍 모드 ──
        const response = await callWithRetry(payload);
        if (response?.id) responseId = response.id as string;
        const output = response.output as Array<Record<string, any>> | undefined;
        if (output) {
          for (const item of output) {
            if (item.type === 'message') {
              const content = item.content as Array<Record<string, any>> | undefined;
              if (content) {
                for (const c of content) {
                  if (c.type === 'output_text' && typeof c.text === 'string') {
                    textParts.push(c.text);
                  }
                }
              }
            } else if (item.type === 'function_call') {
              try {
                toolCalls.push({
                  name: item.name as string,
                  args: item.arguments ? JSON.parse(item.arguments as string) : {},
                });
              } catch {
                toolCalls.push({ name: item.name as string, args: {} });
              }
            } else if (item.type === 'mcp_call') {
              // OpenAI가 MCP connector로 이미 호출하고 결과 받음
              let args: Record<string, unknown> = {};
              try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? {}); } catch {}
              let output: unknown = item.output;
              try { if (typeof output === 'string') output = JSON.parse(output); } catch {}
              toolCalls.push({
                name: item.name as string,
                args,
                preExecutedResult: (output as Record<string, unknown>) ?? { success: true },
              });
            }
          }
        }
      }

      return {
        success: true,
        data: { text: textParts.join(''), toolCalls, ...(responseId ? { responseId } : {}) },
      };
    } catch (e: any) {
      return { success: false, error: `[OpenAI] askWithTools 실패: ${e.message}` };
    }
  }
}
