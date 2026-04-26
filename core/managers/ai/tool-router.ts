/**
 * ToolRouter — AI Assistant 도구 선별 + 피드백 학습 루프.
 *
 * AiManager 의 내부 collaborator (외부 import 금지).
 *
 * 책임:
 *   1. selectTools — 사용자 발화에 맞는 도구 좁히기 (Gemini API 만 적용. needs_previous_context 판정은 모든 모델 공통).
 *   2. AI Assistant ON/OFF 라우팅 분기.
 *   3. 피드백 학습 — 직전 라우팅이 negative/positive 면 cache 점수 갱신.
 *   4. turn 종료 시 성공 기록 (recordTurnSuccess) — 도구 결과 안 좋게 끝나면 negative 시 다음 turn 에서 감점.
 *
 * 상태:
 *   - _llmRouter: routerFactory 로 lazy 생성된 IToolRouterPort
 *   - _sessionLastRouting: 대화별 직전 라우팅 (피드백 컨텍스트, 90초 TTL)
 *   - _lastRouteCacheIds: 현재 turn 의 cacheId (tools / components — turn 끝나면 reset)
 *
 * 분리 이유: 라우팅 결정은 prompt 빌드·dispatch 와 독립. AI Assistant ON/OFF 토글 본체.
 */
import type { FirebatCore } from '../../index';
import type { ILogPort, IToolRouterPort, ToolDefinition, ToolRouterFactory } from '../../ports';

const FEEDBACK_WINDOW_MS = 90_000;  // 90초 — 이 안에서만 직전 라우팅 피드백 참조

export interface ToolRouteResult {
  tools: ToolDefinition[];
  needsPreviousContext?: boolean;
}

export class ToolRouter {
  private llmRouter: IToolRouterPort | null = null;
  private sessionLastRouting = new Map<string, { query: string; toolNames: string[]; cacheId: number; ts: number }>();
  private lastRouteCacheIds: { tools?: number; components?: number[] } = {};

  constructor(
    private readonly core: FirebatCore,
    private readonly logger: ILogPort,
    private readonly routerFactory: ToolRouterFactory,
    /** sysmod 도구 → capability 매핑 (Dispatcher 가 채움). selectTools 의 ToolSearch 에 전달. */
    private readonly toolCapabilities: Map<string, string>,
  ) {}

  /** AI Assistant ON/OFF — Vault 'system:ai-router:enabled' 토글 */
  isEnabled(): boolean {
    const val = this.core.getGeminiKey('system:ai-router:enabled');
    return val === 'true' || val === '1';
  }

  /** lazy IToolRouterPort 인스턴스 — AI Assistant 모델로 1회 생성 + 캐싱.
   *  외부에서도 search_components / search_history handler 가 직접 호출. */
  getRouter(modelId?: string): IToolRouterPort {
    const model = modelId ?? this.core.getAiAssistantModel();
    if (!this.llmRouter) {
      this.llmRouter = this.routerFactory(model);
    }
    return this.llmRouter;
  }

  /** turn 시작 시 호출 — 도구 선별 + needs_previous_context 판정.
   *  Gemini API: 도구 좁힘. GPT/Claude/CLI: 도구 그대로 (hosted MCP 또는 자체 처리), needs_previous_context 만 활용. */
  async selectTools(
    allTools: ToolDefinition[],
    userQuery: string,
    modelId: string,
    sessionUsedToolNames: Set<string>,
    conversationId?: string,
  ): Promise<ToolRouteResult> {
    if (!userQuery.trim()) return { tools: allTools };

    // 도구 필터링은 Gemini API 만 (CLI 는 자체 처리, hosted MCP 는 서버측)
    // needs_previous_context 판정은 모든 모델 공통 (router ON 시) — history 자동 주입용
    const isGeminiApi = modelId.startsWith('gemini-');

    const { ALWAYS_INCLUDE } = await import('../../../infra/llm/tool-search-index');

    // 1. Self-learning LLM 라우터 경로 (토글 on)
    if (this.isEnabled()) {
      try {
        const router = this.getRouter();

        // 세션 내 직전 라우팅 → 피드백 판정용 컨텍스트
        const prev = conversationId ? this.sessionLastRouting.get(conversationId) : undefined;
        const recentContext = prev && (Date.now() - prev.ts) < FEEDBACK_WINDOW_MS
          ? { previousQuery: prev.query, previousNames: prev.toolNames }
          : undefined;

        const result = await router.routeTools(userQuery, allTools, [...ALWAYS_INCLUDE, ...sessionUsedToolNames], recentContext);

        // 피드백 반영 — LLM 이 직전 라우팅을 negative 로 판정하면 감점
        if (prev && result.previousFeedback === 'negative' && prev.cacheId >= 0) {
          await router.recordFailure(prev.cacheId, 2);
          this.logger.info(`[LLMRouter] 유저 피드백 negative → cacheId=${prev.cacheId} 감점`);
        } else if (prev && result.previousFeedback === 'positive' && prev.cacheId >= 0) {
          await router.recordSuccess(prev.cacheId);
        }

        this.lastRouteCacheIds.tools = result.cacheId >= 0 ? result.cacheId : undefined;

        // 세션 기록 갱신
        if (conversationId && result.cacheId >= 0) {
          this.sessionLastRouting.set(conversationId, {
            query: userQuery,
            toolNames: [...result.names].filter(n => !ALWAYS_INCLUDE.has(n)),
            cacheId: result.cacheId,
            ts: Date.now(),
          });
        }

        // Gemini API 만 도구 필터링 적용. 다른 모델은 모든 도구 유지 (router 는 history 판정용으로만)
        if (isGeminiApi) {
          const allowed = new Set(result.names);
          const selected = allTools.filter(t => allowed.has(t.name));
          this.logger.info(`[LLMRouter] ${selected.length}/${allTools.length}개 선택 (${result.source}, cacheId=${result.cacheId}${result.previousFeedback ? `, fb=${result.previousFeedback}` : ''}${result.needsPreviousContext ? ', +prev' : ''})`);
          return {
            tools: selected.length > 0 ? selected : allTools,
            needsPreviousContext: result.needsPreviousContext,
          };
        }
        // GPT/Claude API (hosted MCP), CLI 는 도구 그대로 + needs_previous_context 만 활용
        this.logger.info(`[LLMRouter] (${modelId}) needs_previous_context=${result.needsPreviousContext} (도구 필터링 스킵 — 비-Gemini)`);
        return {
          tools: allTools,
          needsPreviousContext: result.needsPreviousContext,
        };
      } catch (e) {
        this.logger.warn(`[LLMRouter] 실패, 벡터 폴백: ${(e as Error).message}`);
      }
    }

    // 2. 벡터 폴백 (토글 off 이거나 LLM 실패 시) — Gemini API 만 적용
    if (!isGeminiApi) return { tools: allTools };
    try {
      const { ToolSearchIndex } = await import('../../../infra/llm/tool-search-index');
      const capabilityOf = (name: string) => this.toolCapabilities.get(name);
      const { selectedToolNames, matchedCategories } = await ToolSearchIndex.query(userQuery, allTools, {
        topCategories: 3,
        topToolsPerCategory: 5,
        capabilityOf,
      });

      const allowed = new Set([...ALWAYS_INCLUDE, ...selectedToolNames, ...sessionUsedToolNames]);
      const selected = allTools.filter(t => allowed.has(t.name));
      const catSummary = matchedCategories.map(c => `${c.id}:${c.score.toFixed(2)}`).join(',');
      this.logger.info(`[ToolSearch] ${selected.length}/${allTools.length}개 선택 (categories=[${catSummary}], session=${sessionUsedToolNames.size})`);
      return { tools: selected.length > 0 ? selected : allTools };
    } catch (e) {
      this.logger.warn(`[ToolSearch] 검색 실패, 전체 도구 폴백: ${(e as Error).message}`);
      return { tools: allTools };
    }
  }

  /** search_components handler 가 호출 — 컴포넌트 라우팅 결과 cacheId 누적. turn 끝나면 reset. */
  recordComponentsCacheId(cacheId: number): void {
    if (cacheId < 0) return;
    this.lastRouteCacheIds.components = [...(this.lastRouteCacheIds.components ?? []), cacheId];
  }

  /** turn 종료 시 호출 — 보수적 감점 정책 (AI 가 실제 사용한 카테고리만 success).
   *  - toolsUsed: AI 가 라우팅된 도구 중 1개라도 호출했으면 true → tools cache success.
   *  - renderUsed: AI 가 render / render_* 1개라도 호출했으면 true → components cache success.
   *  감점은 다음 turn 의 previousFeedback='negative' 가 자동 처리. */
  async recordTurnSuccess(opts: { toolsUsed: boolean; renderUsed: boolean }): Promise<void> {
    if (!this.llmRouter) {
      this.lastRouteCacheIds = {};
      return;
    }
    try {
      const toolsCacheId = this.lastRouteCacheIds.tools;
      if (typeof toolsCacheId === 'number' && toolsCacheId >= 0 && opts.toolsUsed) {
        await this.llmRouter.recordSuccess(toolsCacheId);
      }
      if (opts.renderUsed) {
        for (const cid of this.lastRouteCacheIds.components ?? []) {
          await this.llmRouter.recordSuccess(cid);
        }
      }
    } catch {
      // 기록 실패 무시
    }
    this.lastRouteCacheIds = {};
  }
}
