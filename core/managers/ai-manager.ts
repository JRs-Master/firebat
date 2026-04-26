import type { FirebatCore, AiRequestOpts } from '../index';
import type { ILlmPort, ILogPort, LlmCallOpts, LlmChunk, ChatMessage, ToolDefinition, JsonSchema, ToolResult, ToolExchangeEntry, IDatabasePort, ToolRouterFactory } from '../ports';
import { CoreResult, type InfraResult } from '../types';
import { sanitizeBlock, sanitizeReply, isValidBlock, extractMarkdownStructure } from '../utils/sanitize';
import { RENDER_TOOL_MAP } from '../../lib/render-map';
import { trimToolResult, slimResultForLLM } from './ai/result-processor';
import { HistoryResolver } from './ai/history-resolver';
import { PromptBuilder } from './ai/prompt-builder';
import { ToolRouter } from './ai/tool-router';
import { buildCoreToolDefinitions, RENDER_TOOLS } from './ai/tool-schemas';
import { ToolDispatcher } from './ai/tool-dispatcher';

/** Vertex AI Function Calling은 enum 값이 반드시 string이어야 함 — 재귀 변환 */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'enum' && Array.isArray(v)) {
      result[k] = v.map(e => String(e));
    } else if (Array.isArray(v)) {
      result[k] = v.map(e => (e && typeof e === 'object' ? sanitizeSchema(e as Record<string, unknown>) : e));
    } else if (v && typeof v === 'object') {
      result[k] = sanitizeSchema(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * AI Manager — 창작자
 *
 * 역할:
 *   - 파이어뱃 위에서 돌아가는 모듈과 앱을 생성/수정/디버깅한다.
 *   - 시스템 내부(core/, infra/, app/admin/, app/api/)는 절대 건드리지 않는다.
 *
 * 인프라: ILlmPort (자체 도메인), ILogPort (횡단 관심사)
 * Core 참조: 크로스 도메인 호출 (storage, page, cron, vault, mcp 등)
 */
export class AiManager {
  /** sysmod_{name} → 모듈 경로 매핑 (buildToolDefinitions에서 채움) */
  private readonly _sysmodPaths = new Map<string, string>();
  /** 도구 이름 → capability (ToolSearchIndex 임베딩 힌트로 사용) */
  private readonly _toolCapabilities = new Map<string, string>();


  /** 도구 정의 캐시 (60초 TTL) */
  private _toolsCache: { tools: ToolDefinition[]; ts: number } | null = null;
  private static readonly TOOLS_CACHE_TTL = 60_000;
  /** 현재 turn 의 직전 user 쿼리 — search_history 쿼리 맥락 보강용 */
  private _currentTurnPrevUserQuery = '';

  /** 내부 collaborator — AI 도메인 분리 (ResultProcessor / HistoryResolver / PromptBuilder / ToolRouter / ToolDispatcher / ...) */
  private readonly history: HistoryResolver;
  private readonly promptBuilder: PromptBuilder;
  private readonly toolRouter: ToolRouter;
  private readonly dispatcher: ToolDispatcher;

  constructor(
    private readonly core: FirebatCore,
    private readonly llm: ILlmPort,
    private readonly logger: ILogPort,
    private readonly db: IDatabasePort,
    private readonly routerFactory: ToolRouterFactory,
  ) {
    this.history = new HistoryResolver(core);
    this.promptBuilder = new PromptBuilder(core, llm);
    this.toolRouter = new ToolRouter(core, logger, routerFactory, this._toolCapabilities);
    this.dispatcher = new ToolDispatcher(core);
    // ToolManager 등록 — Step 2 마이그레이션 진행 단계.
    // 등록된 도구는 executeToolCall 첫 줄의 ToolManager 위임으로 자동 dispatch.
    this.registerStaticToolsToManager();
  }

  /** 정적 도구를 Core.ToolManager 에 등록 — 부팅 시 1회. 등록된 도구는 executeToolCall 위임됨.
   *  기존 AiManager.buildToolDefinitions / executeToolCall switch 와 점진 병행 (회귀 방지).
   *  Step 2 마이그레이션:
   *    schema 는 getCoreToolDefinitions() / buildRenderTools() 단일 source 재사용 (중복 X).
   *    handler 는 executeToolCall switch 본문에서 옮긴 것. */
  private registerStaticToolsToManager(): void {
    // 정적 도구의 schema = getCoreToolDefinitions() 단일 source.
    // handler 만 별도 매핑 — executeToolCall switch 의 본문을 옮김.
    const handlers: Record<string, (args: Record<string, unknown>, ctx: import('./tool-manager').ToolExecuteContext) => Promise<Record<string, unknown>>> = {
      // ── File operations ─────────────────────────────────────────────────
      write_file: async (args) => {
        const { path, content } = args as { path: string; content: string };
        if (content == null) return { success: false, error: 'content가 비어 있습니다' };
        const res = await this.core.writeFile(path, content);
        return res.success ? { success: true } : { success: false, error: res.error };
      },
      read_file: async (args) => {
        const { path, lines } = args as { path: string; lines?: number };
        const res = await this.core.readFile(path);
        if (!res.success) return { success: false, error: res.error };
        let text = res.data || '';
        if (lines && text.split('\n').length > lines) {
          text = text.split('\n').slice(0, lines).join('\n') + `\n... (truncated to ${lines} lines)`;
        }
        return { success: true, content: text };
      },
      list_dir: async (args) => {
        const { path } = args as { path: string };
        const res = await this.core.listFiles(path);
        return res.success ? { success: true, items: res.data } : { success: false, error: res.error };
      },
      append_file: async (args) => {
        const { path, content } = args as { path: string; content: string };
        const readRes = await this.core.readFile(path);
        const combined = readRes.success ? readRes.data + '\n' + content : content;
        const res = await this.core.writeFile(path, combined);
        return res.success ? { success: true } : { success: false, error: res.error };
      },
      delete_file: async (args) => {
        const { path } = args as { path: string };
        const res = await this.core.deleteFile(path);
        return res.success ? { success: true } : { success: false, error: res.error };
      },

      // ── Page operations ─────────────────────────────────────────────────
      save_page: async (args) => {
        const { slug, spec, allowOverwrite } = args as { slug: string; spec: Record<string, unknown> | string; allowOverwrite?: boolean };
        const res = await this.core.savePage(slug, spec, { allowOverwrite: !!allowOverwrite });
        if (!res.success) return { success: false, error: res.error };
        const actualSlug = res.data?.slug ?? slug;
        const renamed = !!res.data?.renamed;
        return {
          success: true,
          slug: actualSlug,
          url: `/${actualSlug}`,
          ...(renamed ? { renamed: true, note: `기존 "${slug}" 페이지 보존을 위해 "${actualSlug}" 로 저장됨. 덮어쓰려면 allowOverwrite:true 명시.` } : {}),
        };
      },
      delete_page: async (args) => {
        const { slug } = args as { slug: string };
        const res = await this.core.deletePage(slug);
        return res.success ? { success: true } : { success: false, error: res.error };
      },
      list_pages: async () => {
        const res = await this.core.listPages();
        return res.success ? { success: true, pages: res.data } : { success: false, error: res.error };
      },

      // ── Schedule operations ─────────────────────────────────────────────
      schedule_task: async (args) => {
        const a = args as Record<string, unknown>;
        const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const res = await this.core.scheduleCronJob(jobId, (a.targetPath as string) ?? '', {
          cronTime: a.cronTime as string | undefined,
          runAt: a.runAt as string | undefined,
          delaySec: a.delaySec as number | undefined,
          startAt: a.startAt as string | undefined,
          endAt: a.endAt as string | undefined,
          inputData: a.inputData as Record<string, unknown> | undefined,
          pipeline: a.pipeline as unknown as import('../ports').PipelineStep[] | undefined,
          title: a.title as string | undefined,
          oneShot: a.oneShot as boolean | undefined,
        });
        return res.success ? { success: true, jobId } : { success: false, error: res.error };
      },
      cancel_task: async (args) => {
        const { jobId } = args as { jobId: string };
        const res = await this.core.cancelCronJob(jobId);
        return res.success ? { success: true } : { success: false, error: res.error };
      },
      list_tasks: async () => {
        const jobs = this.core.listCronJobs();
        return { success: true, cronJobs: jobs };
      },
      run_cron_job: async (args) => {
        const { jobId } = args as { jobId: string };
        if (!jobId) return { success: false, error: 'run_cron_job: jobId 필수' };
        const res = await this.core.runCronJobNow(jobId);
        return res.success
          ? { success: true, message: `잡 트리거됨: ${jobId}. cron-logs 에서 결과 확인 (정상 cron 경로 — agent prelude 적용).` }
          : { success: false, error: res.error };
      },
      run_task: async (args) => {
        const a = args as Record<string, unknown>;
        const pipeline = (a.pipeline ?? a.steps ?? a.tasks) as import('../ports').PipelineStep[] | undefined;
        if (!Array.isArray(pipeline) || pipeline.length === 0) {
          return { success: false, error: "run_task 인자 누락: 'pipeline' 배열이 필요합니다. 각 step은 type(EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION) 필수." };
        }
        const taskRes = await this.core.runTask(pipeline);
        return taskRes.success ? { success: true, data: taskRes.data } : { success: false, error: taskRes.error };
      },

      // ── External / Network ──────────────────────────────────────────────
      mcp_call: async (args) => {
        const { server, tool, arguments: a } = args as { server: string; tool: string; arguments?: Record<string, unknown> };
        const res = await this.core.callMcpTool(server, tool, a ?? {});
        return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
      },
      network_request: async (args) => {
        const { url, method, body, headers } = args as { url: string; method?: string; body?: string; headers?: Record<string, string> };
        const res = await this.core.networkFetch(url, { method: method as 'GET', body, headers });
        return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
      },
      execute: async (args) => {
        const { path, inputData } = args as { path: string; inputData?: Record<string, unknown> };
        const res = await this.core.sandboxExecute(path, inputData ?? {});
        if (!res.success) return { success: false, error: res.error };
        if (res.data?.success === false) return { success: false, error: JSON.stringify(res.data) };
        return { success: true, data: res.data };
      },
      database_query: async (args) => {
        const { query, params } = args as { query: string; params?: unknown[] };
        const res = await this.core.queryDatabase(query, params);
        return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
      },

      // ── Meta / UI ───────────────────────────────────────────────────────
      open_url: async (args) => ({ success: true, openUrl: args.url }),
      request_secret: async (args) => ({ success: true, requestSecret: true, name: args.name, prompt: args.prompt, helpUrl: args.helpUrl }),
      suggest: async () => ({ success: true, displayed: true }),
      image_gen: async (args) => {
        const { prompt, size, quality, filenameHint, aspectRatio, focusPoint } = args as {
          prompt: string;
          size?: string;
          quality?: string;
          filenameHint?: string;
          aspectRatio?: string;
          focusPoint?: 'attention' | 'entropy' | 'center';
        };
        const res = await this.core.generateImage({ prompt, size, quality, filenameHint, aspectRatio, focusPoint });
        if (!res.success || !res.data) return { success: false, error: res.error || '이미지 생성 실패' };
        const d = res.data;
        return {
          success: true,
          url: d.url,
          thumbnailUrl: d.thumbnailUrl,
          variants: d.variants,
          blurhash: d.blurhash,
          width: d.width,
          height: d.height,
          slug: d.slug,
          modelId: d.modelId,
          revisedPrompt: d.revisedPrompt,
          aspectRatio: d.aspectRatio,
        };
      },
      complete_plan: async (args, ctx) => {
        const reason = (args as { reason?: string }).reason || 'AI 판단 완료';
        if (ctx.conversationId) {
          const state = await this.core.getActivePlanState(ctx.conversationId);
          if (state && typeof state.planId === 'string') {
            const { deletePlan } = await import('../../lib/plan-store');
            deletePlan(state.planId);
          }
          await this.core.clearActivePlanState(ctx.conversationId);
        }
        this.logger.info(`[AiManager] complete_plan: ${reason}`);
        return { success: true, completed: true, reason };
      },

      // ── Render dispatchers ──────────────────────────────────────────────
      search_components: async (args) => {
        const { query, limit } = args as { query: string; limit?: number };
        const { COMPONENTS } = await import('../../infra/llm/component-registry');
        if (this.toolRouter.isEnabled()) {
          try {
            const router = this.toolRouter.getRouter();
            const catalog = COMPONENTS.map(c => ({ name: c.name, description: c.description }));
            const result = await router.routeComponents(query, catalog);
            this.toolRouter.recordComponentsCacheId(result.cacheId);
            const picked = COMPONENTS.filter(c => result.names.includes(c.name)).slice(0, typeof limit === 'number' ? limit : 5);
            this.logger.info(`[LLMRouter] search_components (${result.source}, cacheId=${result.cacheId}): ${picked.length}개`);
            return { success: true, components: picked.map(c => ({ name: c.name, description: c.description, propsSchema: c.propsSchema })) };
          } catch (e) {
            this.logger.warn(`[LLMRouter] search_components 실패, 벡터 폴백: ${(e as Error).message}`);
          }
        }
        const { ComponentSearchIndex } = await import('../../infra/llm/component-search-index');
        const matches = await ComponentSearchIndex.query(query, { limit: typeof limit === 'number' ? limit : 5 });
        return { success: true, components: matches };
      },
      render: async (args) => {
        const { name, props } = args as { name: string; props?: Record<string, unknown> };
        if (!name) return { success: false, error: 'render: name 파라미터 필수' };
        const { COMPONENTS_BY_NAME } = await import('../../infra/llm/component-registry');
        const def = COMPONENTS_BY_NAME.get(name);
        if (!def) return { success: false, error: `render: 알 수 없는 컴포넌트 "${name}". search_components 로 사용 가능한 이름을 먼저 확인하세요.` };
        return { success: true, component: def.componentType, props: (props ?? {}) as Record<string, unknown> };
      },
      render_html: async (args) => {
        const cdnMap: Record<string, string> = {
          d3: '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>',
          mermaid: '<script src="https://cdn.jsdelivr.net/npm/mermaid@10"></script>',
          leaflet: '<link rel="stylesheet" href="https://unpkg.com/leaflet@1/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1/dist/leaflet.js"></script>',
          threejs: '<script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js"></script>',
          animejs: '<script src="https://cdn.jsdelivr.net/npm/animejs@3/lib/anime.min.js"></script>',
          tailwindcss: '<script src="https://cdn.tailwindcss.com"></script>',
          katex: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"/><script src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js"></script>',
          hljs: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css"/><script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>',
          marked: '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
          cytoscape: '<script src="https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js"></script>',
          mathjax: '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>',
          echarts: '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
          p5: '<script src="https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js"></script>',
          lottie: '<script src="https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie.min.js"></script>',
          datatables: '<link rel="stylesheet" href="https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css"/><script src="https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js"></script><script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>',
          swiper: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css"/><script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
        };
        const libs = (args.libraries as string[] | undefined) || [];
        const cdnTags = libs.map(l => cdnMap[l]).filter(Boolean).join('\n');
        let html = args.html as string;
        if (cdnTags) {
          if (html.includes('</head>')) html = html.replace('</head>', `${cdnTags}\n</head>`);
          else if (html.includes('<body')) html = html.replace(/<body/i, `${cdnTags}\n<body`);
          else html = `${cdnTags}\n${html}`;
        }
        return { success: true, htmlContent: html, htmlHeight: args.height || '400px' };
      },
      search_media: async (args) => {
        const { query, scope, source, limit } = args as { query: string; scope?: 'user' | 'system' | 'all'; source?: 'ai-generated' | 'upload'; limit?: number };
        const cap = typeof limit === 'number' ? Math.min(50, Math.max(1, limit)) : 10;
        const res = await this.core.listMedia({
          scope: scope ?? 'all',
          search: query,
          limit: cap,
          offset: 0,
        });
        if (!res.success) return { success: false, error: res.error };
        const items = (res.data?.items ?? [])
          // source 필터 — listMedia 가 source 필터 미지원이라 도구 단에서 필터.
          // legacy(미설정) = 'ai-generated' 로 간주 (메모리 룰 호환).
          .filter(item => {
            if (!source) return true;
            const s = item.source ?? 'ai-generated';
            return s === source;
          })
          .map(item => ({
            slug: item.slug,
            url: `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`,
            thumbnailUrl: item.thumbnailUrl,
            prompt: item.prompt,
            filenameHint: item.filenameHint,
            model: item.model,
            width: item.width,
            height: item.height,
            createdAt: new Date(item.createdAt).toISOString(),
            source: item.source ?? 'ai-generated',
            ...(item.status && item.status !== 'done' ? { status: item.status, errorMsg: item.errorMsg } : {}),
          }));
        return { success: true, matches: items, count: items.length, total: res.data?.total ?? items.length };
      },
      search_history: async (args, ctx) => {
        const { query, limit, includeBlocks } = args as { query: string; limit?: number; includeBlocks?: boolean };
        const owner = ctx.owner ?? 'admin';
        const topK = typeof limit === 'number' ? limit : 5;

        const prev = this._currentTurnPrevUserQuery;
        let enrichedQuery = prev && prev !== query ? `${query} ${prev}`.slice(0, 500) : query;
        if (this.toolRouter.isEnabled()) {
          try {
            const router = this.toolRouter.getRouter();
            const rewritten = await router.generateSearchQuery(query, prev);
            enrichedQuery = rewritten.query;
          } catch (e) {
            this.logger.warn(`[LLMRouter] generateSearchQuery 실패, 단순 결합 사용: ${(e as Error).message}`);
          }
        }

        const overfetch = this.toolRouter.isEnabled() ? Math.max(topK * 3, 15) : topK;
        const res = await this.core.searchConversationHistory(owner, enrichedQuery, {
          currentConvId: ctx.conversationId,
          limit: overfetch,
          includeBlocks: includeBlocks === true,
        });
        if (!res.success) return { success: false, error: res.error };
        const rawMatches = (res.data ?? []).map(m => ({
          convId: m.convId,
          convTitle: m.convTitle,
          role: m.role,
          preview: m.contentPreview,
          score: Number(m.score.toFixed(3)),
          isCurrentConv: m.convId === ctx.conversationId,
          ...(m.blocks ? { blocks: m.blocks } : {}),
        }));

        let matches = rawMatches.slice(0, topK);
        if (this.toolRouter.isEnabled() && rawMatches.length > topK) {
          try {
            const router = this.toolRouter.getRouter();
            matches = await router.rerankHistory(enrichedQuery, rawMatches, topK);
          } catch (e) {
            this.logger.warn(`[LLMRouter] rerankHistory 실패, 벡터 순서 유지: ${(e as Error).message}`);
          }
        }
        return { success: true, matches, count: matches.length, enrichedQuery: enrichedQuery !== query ? enrichedQuery : undefined };
      },
    };

    // 1) getCoreToolDefinitions() 의 schema 활용 (중복 정의 X). handler 가 등록된 것만 ToolManager 에 추가.
    for (const def of buildCoreToolDefinitions()) {
      const handler = handlers[def.name];
      if (!handler) continue;  // handler 없는 도구는 미등록 → executeToolCall switch 가 그대로 처리
      this.core.registerTool({
        name: def.name,
        source: 'static',
        description: def.description,
        parameters: def.parameters as unknown as Record<string, unknown>,
        handler,
      });
    }

    // 2) render_alert / render_callout — 안전망 도구. Schema 는 buildRenderTools 단일 source 재사용.
    for (const renderTool of RENDER_TOOLS) {
      this.core.registerTool({
        name: renderTool.name,
        source: 'render',
        description: renderTool.description,
        parameters: renderTool.parameters as unknown as Record<string, unknown>,
        handler: async (args) => ({ success: true, component: RENDER_TOOL_MAP[renderTool.name], props: args }),
      });
    }
  }

  /**
   * Vertex AI 파인튜닝용 학습 데이터 기록 — Gemini contents 형식.
   * 전체 멀티턴(user→model functionCall→user functionResponse→...→model text) 저장.
   * 로그 어댑터가 [USER_AI_TRAINING] 접두사를 감지해 data/logs/training-YYYY-MM-DD.jsonl에 분리 저장.
   */
  private trainingLogContents(
    prompt: string,
    toolExchanges: ToolExchangeEntry[],
    finalReply: string,
    history: ChatMessage[] = [],
  ): void {
    try {
      const contents: Array<{ role: string; parts: unknown[] }> = [];

      // 1. 대화 히스토리 (최근 4개만 — 파인튜닝에서는 컨텍스트 최소화)
      const recent = history.slice(-4);
      for (const h of recent) {
        contents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }],
        });
      }

      // 2. 사용자 프롬프트
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      // 3. 멀티턴 도구 교환
      for (const exchange of toolExchanges) {
        const modelParts: unknown[] = exchange.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.args } }));
        contents.push({ role: 'model', parts: modelParts });
        const responseParts: unknown[] = exchange.toolResults.map(tr => ({
          functionResponse: { name: tr.name, response: trimToolResult(tr.result) },
        }));
        contents.push({ role: 'user', parts: responseParts });
      }

      // 4. 최종 텍스트 응답
      if (finalReply) {
        contents.push({ role: 'model', parts: [{ text: finalReply }] });
      }

      this.logger.info(`[USER_AI_TRAINING] ${JSON.stringify({ contents })}`);
    } catch {
      // 학습 로그 실패는 무시 — 서비스에 영향 없음
    }
  }




  // ══════════════════════════════════════════════════════════════════════════
  //  레거시 JSON 모드 (process / planOnly / executePlan / executeAction / buildSystemPrompt)
  //  삭제됨 (v0.1, 2026-04-22). Function Calling 모드 (processWithTools) 로 완전 이관.
  //  기존 API route (chat/route.ts, chat/execute/route.ts) 도 함께 제거.
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  //  Function Calling — 멀티턴 도구 루프
  // ══════════════════════════════════════════════════════════════════════════

  /** Function Calling 기반 AI 처리 — 도구 호출 루프 */
  async processWithTools(
    prompt: string,
    history: ChatMessage[] = [],
    opts?: AiRequestOpts,
    onToolCall?: (info: { name: string; status: 'start' | 'done' | 'error'; error?: string }) => void,
    onChunk?: (chunk: LlmChunk) => void,
  ): Promise<CoreResult> {
    const thinkingLevel = this.core.getAiThinkingLevel();
    const corrId = Math.random().toString(36).slice(2, 10);
    const startTime = Date.now();

    // 도구 흐름: text chunk는 필터링 (깜빡임 방지), thinking chunk만 프론트에 전달.
    // onChunk가 설정되면 스트리밍 모드 활성화 → reasoning 델타도 수신 가능.
    const thinkingOnlyChunk: ((c: LlmChunk) => void) | undefined = onChunk
      ? (c: LlmChunk) => { if (c.type === 'thinking') onChunk(c); }
      : undefined;
    // previousResponseId 추적 — 첫 호출엔 opts.previousResponseId, 멀티턴 루프 내 매 turn 갱신
    let currentResponseId: string | undefined = opts?.previousResponseId;

    // CLI 모드 세션 resume — 대화 ID 있으면 DB 에서 이전 session_id 조회
    // 모델 바뀌었으면 null 반환되어 새 세션으로 시작됨
    const modelForSession = opts?.model ?? this.llm.getModelId();
    let cliResumeSessionId: string | undefined;
    if (opts?.conversationId && modelForSession.startsWith('cli-')) {
      const existing = await this.core.getCliSession(opts.conversationId, modelForSession);
      if (existing) cliResumeSessionId = existing.sessionId;
    }
    // 첫 턴에서 캡처한 session_id 를 DB 영속화
    const onCliSessionId = opts?.conversationId && modelForSession.startsWith('cli-')
      ? (sid: string) => { this.core.setCliSession(opts.conversationId!, sid, modelForSession).catch(() => {}); }
      : undefined;

    const baseLlmOpts: LlmCallOpts = {
      thinkingLevel,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.image ? { image: opts.image } : {}),
      ...(thinkingOnlyChunk ? { onChunk: thinkingOnlyChunk } : {}),
      ...(cliResumeSessionId ? { cliResumeSessionId } : {}),
      ...(onCliSessionId ? { onCliSessionId } : {}),
      ...(opts?.conversationId ? { conversationId: opts.conversationId } : {}),
    };
    // cron agent 는 자율 발행 (사용자 부재) — 데이터 수집 (sysmod 4-6개) + save_page 까지 여유 있게.
    // admin chat 은 사용자가 turn 도달 시 follow-up 가능 → 10 으로 충분.
    const MAX_TOOL_TURNS = opts?.cronAgent ? 25 : 10;
    const modelId = baseLlmOpts?.model ?? this.llm.getModelId();

    const { recentHistory: baseRecentHistory, contextSummary } = await this.history.compressHistoryWithSearch(
      history,
      prompt,
      { owner: opts?.owner, currentConvId: opts?.conversationId },
    );
    // search_history 맥락 보강용 — 직전 user 발화 저장 (compressHistoryWithSearch 가 비워도 history 에서 직접 추출)
    const prevUserMsg = history.filter(h => h.role === 'user').slice(-1)[0];
    this._currentTurnPrevUserQuery = (prevUserMsg?.content || '').trim();
    const currentModel = opts?.model ?? this.llm.getModelId();
    const systemPrompt = await this.promptBuilder.build(currentModel, opts?.cronAgent ? { cronAgent: opts.cronAgent } : undefined);

    // Plan 실행 맥락 — 3군데 경로:
    //  1. 이번 턴에 ✓실행 클릭 (planExecuteId 동봉) → plan 을 conversation 에 저장 후 주입
    //  2. 이번 턴에 ⚙수정 클릭 (planReviseId 동봉) → 재작성 룰 주입 (기존 그대로)
    //  3. 진행 중 plan 있음 (conversations.active_plan_state.planId) → 자동 주입 (multi-turn 지속)
    //
    // plan 은 `complete_plan` 도구가 호출되어야 종료 — 이전처럼 1회 소비(deletePlan) 하지 않음.
    // 3-stage 공동설계 · multi-step plan 실행이 턴 경계를 넘어 이어질 수 있음.
    let planExecuteRule = '';
    if (opts?.planExecuteId) {
      const { getPlan, planToInstruction } = await import('../../lib/plan-store');
      const plan = getPlan(opts.planExecuteId);
      if (plan) {
        const originalRequest = history.filter(h => h.role === 'user').slice(-1)[0]?.content;
        planExecuteRule = `# 🎯 승인된 plan 실행 모드 (다른 모든 규칙보다 우선)\n\n${planToInstruction(plan, originalRequest)}\n\n─────────────────────────────────────\n\n`;
        // conversation 에 저장 — 이후 턴에서도 맥락 유지 (planExecuteId 재전송 불필요)
        if (opts.conversationId) {
          await this.core.setActivePlanState(opts.conversationId, {
            planId: opts.planExecuteId,
            originalRequest,
            startedAt: Date.now(),
          });
        }
        this.logger.info(`[AiManager] [${corrId}] planExecuteId=${opts.planExecuteId} → plan steps 주입 (${plan.steps.length}단계) + conversation.active_plan_state 저장`);
      } else {
        this.logger.warn(`[AiManager] [${corrId}] planExecuteId=${opts.planExecuteId} 만료됨 — 에러 반환`);
        return {
          success: false,
          error: '플랜이 만료됐거나 서버 재시작으로 사라졌습니다. 같은 요청을 다시 보내주세요 (새 플랜 카드가 나옵니다).',
          executedActions: [],
        };
      }
    } else if (opts?.planReviseId) {
      const { getPlan, planToReviseInstruction, deletePlan } = await import('../../lib/plan-store');
      const plan = getPlan(opts.planReviseId);
      if (plan) {
        planExecuteRule = `# ⚙ plan 재작성 모드 (다른 모든 규칙보다 우선)\n\n${planToReviseInstruction(plan, prompt)}\n\n─────────────────────────────────────\n\n`;
        deletePlan(opts.planReviseId); // 재작성 요청은 1회성 — 새 plan 호출되면 새 planId
        this.logger.info(`[AiManager] [${corrId}] planReviseId=${opts.planReviseId} → 재작성 룰 주입 (피드백: ${prompt.slice(0, 50)})`);
      } else {
        this.logger.warn(`[AiManager] [${corrId}] planReviseId=${opts.planReviseId} 만료됨 — 에러 반환`);
        return {
          success: false,
          error: '수정할 플랜이 만료됐거나 서버 재시작으로 사라졌습니다. 같은 요청을 다시 보내 새 플랜을 만들어주세요.',
          executedActions: [],
        };
      }
    } else if (opts?.conversationId) {
      // 진행 중 plan 자동 주입 — 3-stage 공동설계 multi-turn 유지의 핵심
      const activeState = await this.core.getActivePlanState(opts.conversationId);
      if (activeState && typeof activeState.planId === 'string') {
        const { getPlan, planToInstruction } = await import('../../lib/plan-store');
        const plan = getPlan(activeState.planId);
        if (plan) {
          const originalRequest = typeof activeState.originalRequest === 'string' ? activeState.originalRequest : undefined;
          planExecuteRule = `# 🎯 진행 중 plan (이전 턴에서 이어가기)\n\n${planToInstruction(plan, originalRequest)}\n\n**이 plan 의 단계를 모두 완료했으면 \`complete_plan\` 도구를 호출해서 종료하세요.** 완료 안 된 단계 있으면 이어서 진행.\n\n─────────────────────────────────────\n\n`;
          this.logger.info(`[AiManager] [${corrId}] 진행 중 plan 자동 주입 (planId=${activeState.planId}, ${plan.steps.length}단계)`);
        } else {
          // plan-store 에서 만료 → conversation state 도 정리
          await this.core.clearActivePlanState(opts.conversationId);
          this.logger.info(`[AiManager] [${corrId}] 진행 중 plan 만료 — active_plan_state 정리`);
        }
      }
    }

    // 플랜모드 3단계: off / auto / always
    //   - 'off' (false): plan 강제 X. AI 자유 판단
    //   - 'auto': destructive·복합 작업만 plan, 단순 작업은 즉시
    //   - 'always' (true): 모든 요청에 plan 강제 (인사·단답 포함)
    const planModeValue: 'off' | 'auto' | 'always' = (() => {
      const v = opts?.planMode;
      if (v === true || v === 'always') return 'always';
      if (v === 'auto') return 'auto';
      return 'off'; // undefined / false / 'off' → off
    })();

    const planModePrefix = planModeValue === 'always'
      ? `# ⚡ 플랜모드 ALWAYS — 사용자 협의 모드 (다른 모든 규칙보다 우선)

사용자가 플랜모드를 ALWAYS 로 켰습니다. **첫 응답은 작업 종류에 맞는 협의 도구만 호출하고 즉시 턴 종료**.

## 작업 종류별 협의 방식

**앱·게임·페이지·도구 "만들어줘" 요청** → \`suggest\` 3단계 플로우
- 1단계 (기능 선택): suggestions 에 toggle + input + 취소
  예: \`[{"type":"toggle","label":"기능 선택","options":["vs 컴퓨터","스코어보드","애니메이션","효과음"],"defaults":["애니메이션"]},{"type":"input","label":"기능 직접 추가","placeholder":"..."},"취소"]\`
- 2단계 (디자인 선택): 기능 확정 후 suggest 로 스타일 제시
  예: \`["다크 + 네온","밝은 미니멀","레트로",{"type":"input","label":"스타일 직접 입력","placeholder":"..."},"취소"]\`
- 3단계 (구현): 기능+디자인 확정 후 save_page + 필요한 write_file

**그 외 모든 요청** (조회·분석·예측·시각화·요약·스케줄·인사·잡담 전부) → \`propose_plan\` 도구
- 인자: { title (작업 요약), steps (3~6단계 {title, description, tool?}), estimatedTime, risks }
- 호출 후 즉시 턴 종료. 사용자가 "✓ 실행" 누르면 별도 턴에서 실제 작업.
- **예외 0건** — 사용자가 ALWAYS 로 켠 이상 모든 요청에 plan 카드. "단순 조회·인사라 plan 불필요" 같은 자체 판단 **절대 금지**.

**오직 직전 plan 의 ✓실행 직후 follow-up (planExecuteId 동봉된 턴) 만 plan 카드 없이 실제 작업 진행.**

## 절대 규칙
- 위 협의 도구 호출 후 **즉시 턴 종료** — 다른 도구·텍스트 응답 금지
- "단답이라 plan 불필요" 같은 변명 금지 — **모든 요청에 plan**
- SVG vs Canvas 같은 기술적 접근 먼저 묻기 금지 (3단계 스킵)
- 긴 텍스트 설명으로 제안 나열 금지 — 반드시 suggest UI 선택지로
- 시스템 프롬프트 다른 곳의 propose_plan / 3단계 예외 규칙 모두 무력화

─────────────────────────────────────

`
      : planModeValue === 'auto'
      ? `# ⚡ 플랜모드 AUTO — 자동 판단 모드

사용자가 플랜모드를 AUTO 로 켰습니다. 작업 종류에 따라 plan 여부 자동 판단:

## propose_plan 또는 3-stage suggest 호출 (협의 필요)

다음 케이스는 **반드시 협의 후 진행**:
- **앱·페이지·모듈 "만들어줘" 요청** → 3-stage suggest (기능 → 디자인 → 구현)
- **destructive 작업** — save_page (overwrite 위험) / delete_* / schedule_task (24/7 자동) / sysmod_kiwoom buy·sell (실거래)
- **복합 흐름 (3 step+)** — 여러 도구 조합·pipeline 등
- **자동매매·cron 등록** — runAt·cronTime 검증 필수

→ propose_plan 으로 청사진 (title, steps 3~6단계, estimatedTime, risks) 제시 후 ✓실행 대기

## 협의 생략 — 즉시 실행 (단순·read-only)

다음 케이스는 **plan 생략하고 도구 직접 호출**:
- 단발 정보 조회 (시세·날씨·검색·search_history)
- 단일 render_* (차트·표·카드 그리기)
- 단순 대화·인사·단답
- read-only 도구 (search_*, list_*, get_*)
- image_gen (단일 도구, 재생성 가능)

## 판단 룰
- 도구 1개 + read-only → 즉시
- 도구 1개 + destructive → propose_plan
- 도구 2개+ 또는 pipeline → propose_plan
- 모호하면 propose_plan 쪽 (안전 우선)

─────────────────────────────────────

`
      : '';
    // 도구 정의 빌드 (캐시 활용). 실제 LLM 전송 방식(MCP connector vs 인라인)은 어댑터가 결정.
    const allToolsRaw = await this.buildToolDefinitions();
    // AI Assistant ON 시: backend 가 자동 search_history 처리 → User AI 도구 목록에서 제외 (중복 방지)
    // 플랜 토글: ON = 무조건 plan 강제 (시스템 프롬프트로), OFF = AI 자유 판단 (도구 그대로 유지)
    const allToolsAfterRouter = this.toolRouter.isEnabled()
      ? allToolsRaw.filter(t => t.name !== 'search_history')
      : allToolsRaw;
    // cron agent 모드: schedule_task / cancel_task / list_tasks / run_cron_job / propose_plan / complete_plan 차단
    // (recursion 방지 + UI 없는 환경이라 plan 카드 의미 X)
    const allTools = opts?.cronAgent
      ? allToolsAfterRouter.filter(t => !['schedule_task', 'cancel_task', 'list_tasks', 'run_cron_job', 'propose_plan', 'complete_plan'].includes(t.name))
      : allToolsAfterRouter;
    // Gemini/Vertex는 사용자 쿼리로 벡터 검색 → 관련 도구만 선별 (토큰 절감)
    // 다른 프로바이더는 allTools 그대로 반환됨
    const sessionUsedToolNames = new Set<string>();
    const selectResult = await this.toolRouter.selectTools(allTools, prompt, modelId, sessionUsedToolNames, opts?.conversationId);
    const tools = selectResult.tools;

    // 라우터가 이전 턴 맥락 필요하다고 판정 → recent user 1턴 포함
    const recentHistory: ChatMessage[] = selectResult.needsPreviousContext && prevUserMsg
      ? [prevUserMsg]
      : baseRecentHistory;

    // AI Assistant ON + needs_previous_context=true → 자동으로 search_history 실행해 결과 prepend
    // (User AI 가 search_history 도구를 호출하지 않아도 backend 가 컨텍스트 보강)
    let autoHistoryContext = '';
    if (this.toolRouter.isEnabled() && selectResult.needsPreviousContext && opts?.conversationId) {
      try {
        const owner = opts?.owner ?? 'admin';
        const router = this.toolRouter.getRouter();
        const rewritten = await router.generateSearchQuery(prompt, this._currentTurnPrevUserQuery);
        const enrichedQuery = rewritten.query;
        const res = await this.core.searchConversationHistory(owner, enrichedQuery, {
          currentConvId: opts.conversationId,
          limit: 15,
          includeBlocks: true, // 표·차트 데이터까지 포함
        });
        if (res.success && res.data && res.data.length > 0) {
          const rawMatches = res.data.map(m => ({
            convId: m.convId,
            convTitle: m.convTitle,
            role: m.role,
            preview: m.contentPreview,
            score: Number(m.score.toFixed(3)),
            isCurrentConv: m.convId === opts.conversationId,
            ...(m.blocks ? { blocks: m.blocks } : {}),
          }));
          const reranked = rawMatches.length > 5 ? await router.rerankHistory(enrichedQuery, rawMatches, 5).catch(() => rawMatches.slice(0, 5)) : rawMatches.slice(0, 5);
          if (reranked.length > 0) {
            const formatted = reranked.map((m, i) => {
              const blocksInfo = (m as { blocks?: unknown[] }).blocks
                ? `\n   [컴포넌트 데이터: ${JSON.stringify((m as { blocks: unknown[] }).blocks).slice(0, 800)}...]`
                : '';
              return `[${i + 1}] (${m.role}, score=${m.score}${m.isCurrentConv ? ', 현재 대화' : ''}) ${m.preview.slice(0, 300)}${blocksInfo}`;
            }).join('\n\n');
            autoHistoryContext = `\n\n## 자동 로드된 이전 대화 컨텍스트 (router 가 사용자 쿼리 보고 필요 판정)\n검색 쿼리: "${enrichedQuery}"\n${formatted}\n\n위 컨텍스트는 사용자가 "위/이전/그/방금/이거" 같은 참조 표현을 쓴 경우 의미 해소용. 본문 답변은 현재 쿼리에만 집중하되, 데이터 인용·요약 시 위 컨텍스트의 컴포넌트 데이터를 활용.\n`;
            this.logger.info(`[AiManager] [${corrId}] auto search_history → ${reranked.length}개 매치 주입 (query="${enrichedQuery.slice(0, 50)}...")`);
          }
        }
      } catch (e) {
        this.logger.warn(`[AiManager] [${corrId}] auto search_history 실패: ${(e as Error).message}`);
      }
    }

    const finalSystemPrompt = contextSummary
      ? planExecuteRule + planModePrefix + systemPrompt + autoHistoryContext + `\n\n${contextSummary}`
      : planExecuteRule + planModePrefix + systemPrompt + autoHistoryContext;

    const mcpTokenSet = !!this.core.getGeminiKey('system:internal-mcp-token');
    const toolMode = mcpTokenSet ? 'MCP connector' : `인라인 ${tools.length}개${tools.length < allTools.length ? ` (검색 선별: 전체 ${allTools.length})` : ''}`;
    this.logger.info(`[AiManager] [${corrId}] [${modelId}] Function Calling 시작 (${toolMode})`);

    const toolExchanges: ToolExchangeEntry[] = [];
    const executedActions: string[] = [];
    const collectedData: Record<string, unknown>[] = [];
    const pendingActions: Array<{ planId: string; name: string; summary: string; args: Record<string, unknown>; status?: 'past-runat'; originalRunAt?: string }> = [];
    // 인라인 블록 — text/html/component를 순서대로 쌓음 (Claude 스타일 inline 렌더링용)
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'html'; htmlContent: string; htmlHeight?: string }
      | { type: 'component'; name: string; props: Record<string, unknown> }
    > = [];
    let finalReply = '';
    let suggestions: unknown[] = [];

    // 멀티턴 내 도구 선별 캐시 — 세션에서 호출된 도구가 늘어날 때만 재계산
    let turnTools = tools;
    let lastSessionSize = -1;
    // Layer 1·2 가드용 — tool-cache 모듈 lazy import
    const { toolCacheKey, getCachedToolResult, setCachedToolResult } = await import('../../lib/tool-cache');

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      // 이전 턴에 새 도구 사용됐으면 재선별 (이미 사용한 도구는 반드시 포함되어야 AI가 재호출 가능)
      if (sessionUsedToolNames.size > lastSessionSize) {
        const reselect = await this.toolRouter.selectTools(allTools, prompt, modelId, sessionUsedToolNames, opts?.conversationId);
        turnTools = reselect.tools;
        lastSessionSize = sessionUsedToolNames.size;
      }
      const llmStart = Date.now();
      // previousResponseId 있으면 history/toolExchanges 재전송 생략 (OpenAI 서버가 유지)
      // 동적 temperature — 도구 호출 턴 (turn 1 ~ 중간) 은 0.2 (스키마 엄수),
      // 최종 응답 턴 (글쓰기·요약·해설) 은 0.85 — 자연스럽고 풍부한 표현.
      //  - 0.2: 도구 호출 가능성 높을 때 — JSON 스키마 정확 준수
      //  - 0.85: 사용자 노출 텍스트 작성 — 약간 창의적·자연스러운 어휘
      // turn 번호로 판정 — toolExchanges 비어있으면 첫 turn (도구 호출), 쌓여있으면 summarize turn.
      const dynamicTemp = toolExchanges.length === 0 ? 0.2 : 0.85;
      const turnLlmOpts: LlmCallOpts = {
        ...baseLlmOpts,
        temperature: dynamicTemp,
        ...(currentResponseId ? { previousResponseId: currentResponseId } : {}),
      };
      const turnHistory = currentResponseId ? [] : recentHistory;
      // 이전 턴 결과는 aggressive 축약 — 매 턴 누적 재전송되는 토큰 비용 차단.
      //  (sysmod/mcp/network/execute 원본이 멀티턴 루프에서 반복 전송되는 문제 해결)
      //  가장 최근 턴(마지막 push 된 exchange) 은 이미 slim 적용된 상태. 그 이전 엔트리는 재슬림.
      const turnExchanges = currentResponseId
        ? []
        : toolExchanges.map((ex, i) => {
            const isLastEntry = i === toolExchanges.length - 1;
            if (isLastEntry) return ex;
            return {
              ...ex,
              toolResults: ex.toolResults.map(tr => ({
                ...tr,
                result: slimResultForLLM(tr.name, tr.result, true), // aggressive
              })),
            };
          });
      // 플랜모드 hint: Gemini 가 시스템 프롬프트 무시 시 fallback
      const promptForLlm = (toolExchanges.length === 0)
        ? (planModeValue === 'always'
          ? `[플랜모드 ALWAYS — 모든 요청에 propose_plan 먼저 호출 (예외 0건, 인사·단답도 plan). 앱 만들기만 suggest 3단계. 호출 후 즉시 턴 종료]\n\n${prompt}`
          : planModeValue === 'auto'
          ? `[플랜모드 AUTO — destructive·복합 작업만 propose_plan, 단순 read-only 는 즉시 도구 호출. 앱 만들기는 3-stage suggest]\n\n${prompt}`
          : prompt)
        : prompt;
      const llmRes = await this.llm.askWithTools(promptForLlm, finalSystemPrompt, turnTools, turnHistory, turnExchanges, turnLlmOpts);
      const llmMs = Date.now() - llmStart;

      if (!llmRes.success) {
        this.logger.error(`[AiManager] [${corrId}] [${modelId}] LLM 실패 (turn ${turn + 1}, ${llmMs}ms): ${llmRes.error}`);
        return { success: false, executedActions, error: `LLM API 실패: ${llmRes.error}` };
      }

      const { text: rawText, toolCalls, responseId, rawModelParts, internallyUsedTools, renderedBlocks: innerBlocks, pendingActions: innerPending, suggestions: innerSuggestions, usage } = llmRes.data!;
      if (responseId) currentResponseId = responseId; // 다음 턴에 previous_response_id로 재사용
      // LLM 비용 추적 — 어댑터가 usage 채우면 CostManager 에 누적 (Core facade 경유)
      if (usage) this.core.recordLlmCost(usage);
      const text = (rawText || '').trim();
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Turn ${turn + 1} (${llmMs}ms): text=${text.length}자, tools=${toolCalls.length}개${internallyUsedTools?.length ? `, internal=${internallyUsedTools.length}개` : ''}${innerBlocks?.length ? `, blocks=${innerBlocks.length}개` : ''}`);

      // 어댑터가 내부에서 이미 실행한 도구들 (CLI 모드 등) → executedActions + 배지에 반영
      if (internallyUsedTools && internallyUsedTools.length > 0) {
        for (const name of internallyUsedTools) {
          const displayName = name.replace(/^mcp__[^_]+__/, '');
          executedActions.push(displayName);
          onToolCall?.({ name: displayName, status: 'done' });
        }
      }

      // 어댑터가 내부에서 렌더한 블록들 (CLI 모드 render_* 결과) → UI blocks 에 반영
      if (innerBlocks && innerBlocks.length > 0) {
        for (const b of innerBlocks) {
          blocks.push(b);
        }
      }
      // 어댑터가 내부에서 생성한 pending actions (schedule_task/save_page 등) → UI 승인 버튼
      if (innerPending && innerPending.length > 0) {
        for (const pa of innerPending) {
          pendingActions.push({
            planId: pa.planId,
            name: pa.name,
            summary: pa.summary,
            args: pa.args ?? {},
            ...(pa.status === 'past-runat' ? { status: 'past-runat' as const } : {}),
            ...(pa.originalRunAt ? { originalRunAt: pa.originalRunAt } : {}),
          });
          executedActions.push(pa.name);
          onToolCall?.({ name: pa.name, status: 'done' });
        }
      }
      // 어댑터가 내부에서 수집한 suggestions → UI 선택지 버튼
      if (innerSuggestions && innerSuggestions.length > 0) {
        suggestions = innerSuggestions;
      }

      // CLI 모드 (Claude Code CLI, Codex, Gemini CLI) 는 도구 호출을 내부 처리하고 toolCalls=[] 반환 →
      // propose_plan 은 internallyUsedTools 로만 감지 가능. 이 턴이 propose_plan 턴이면 trailing text drop.
      const isProposePlanTurn = toolCalls.some(tc => tc.name === 'propose_plan')
        || (internallyUsedTools || []).some(n => n.replace(/^mcp__[^_]+__/, '') === 'propose_plan');

      // 도구 호출이 없으면 최종 응답
      if (toolCalls.length === 0) {
        if (isProposePlanTurn) {
          // PlanCard + suggestions 로 이미 완전 — "위 카드에서..." 같은 사족 drop
          this.logger.info(`[AiManager] [${corrId}] propose_plan (CLI 내부) 감지 → trailing text drop`);
          finalReply = '';
        } else {
          finalReply = text;
          if (text) blocks.push({ type: 'text', text });
        }
        break;
      }

      // 도구 실행
      const toolResults: ToolResult[] = [];
      // Layer 2 가드 — 같은 turn 안에서 (tool name + args) 동일 호출 차단
      const turnCallSet = new Set<string>();
      for (const tc of toolCalls) {
        sessionUsedToolNames.add(tc.name);
        const argsPreview = JSON.stringify(tc.args).slice(0, 120);
        this.logger.info(`[AiManager] [${corrId}] Tool: ${tc.name} ${argsPreview}`);

        // 사전검증 — AI가 스스로 재시도할 수 있도록 UI에는 노출하지 않고 tool 결과로만 피드백.
        // cron agent 모드: 승인 게이트 우회 — UI 없는 server-side 실행이라 모든 도구 즉시 실행 (save_page 포함).
        const approvalPeek = opts?.cronAgent ? null : await this.dispatcher.checkNeedsApproval(tc);
        let preValidError: string | null = null;
        if (approvalPeek) preValidError = this.dispatcher.preValidatePendingArgs(tc);

        if (preValidError) {
          // UI 미노출: executedActions/onToolCall 스킵, toolResults에만 에러 주입해서 AI가 다음 턴에 재호출하게 함
          const result = { success: false, error: preValidError };
          toolResults.push({ name: tc.name, result });
          this.logger.warn(`[AiManager] [${corrId}] Tool 사전검증 실패 (UI 비노출, 재시도 유도): ${tc.name} — ${preValidError}`);
          continue;
        }

        // 정상 실행 경로 — 이제부터 UI에 노출
        // render(name, props) 의 경우 name 을 배지에 반영 (예: render:stock_chart)
        const displayName = tc.name === 'render' && typeof (tc.args as { name?: unknown })?.name === 'string'
          ? `render:${(tc.args as { name: string }).name}`
          : tc.name;
        executedActions.push(displayName);
        onToolCall?.({ name: displayName, status: 'start' });

        let result: Record<string, unknown>;
        if (approvalPeek) {
          const { createPending } = await import('../../lib/pending-tools');
          const planId = createPending(tc.name, tc.args as Record<string, unknown>, approvalPeek.summary);
          // schedule_task: runAt이 이미 과거면 처음부터 past-runat 상태로 내려서
          // 승인 버튼 대신 즉시보내기/시간변경 버튼이 뜨도록 유도
          let initStatus: 'past-runat' | undefined;
          let originalRunAt: string | undefined;
          if (tc.name === 'schedule_task') {
            const runAt = (tc.args as { runAt?: string }).runAt;
            if (runAt) {
              const t = Date.parse(runAt);
              if (!isNaN(t) && t <= Date.now()) {
                initStatus = 'past-runat';
                originalRunAt = runAt;
              }
            }
          }
          pendingActions.push({ planId, name: tc.name, summary: approvalPeek.summary, args: tc.args as Record<string, unknown>, status: initStatus, originalRunAt });
          result = { success: true, pending: true, planId, message: `'${approvalPeek.summary}' — 사용자 승인 대기 중입니다. 자동으로 실행되지 않았습니다.` };
          this.logger.info(`[AiManager] [${corrId}] Tool 승인 대기: ${tc.name} (planId=${planId}) — ${approvalPeek.summary}${initStatus ? ' [과거 시각 감지 → past-runat]' : ''}`);
        } else if (tc.preExecutedResult) {
          // OpenAI hosted MCP connector가 이미 실행함 — 결과 그대로 사용
          result = tc.preExecutedResult;
          this.logger.info(`[AiManager] [${corrId}] Tool (MCP 서버에서 실행됨): ${tc.name}`);
        } else {
          // Tool retry guard — Layer 1 (cross-turn cache) + Layer 2 (per-turn duplicate)
          // 모든 도구 동일 적용 (도구명 / 인자 형태 무관 일반 로직).
          // AI 가 timeout/error 받고 같은 인자로 retry 해도 백엔드 한 번만 실행 → 비용 폭탄 차단.
          const cacheKey = toolCacheKey(tc.name, tc.args);
          if (turnCallSet.has(cacheKey)) {
            // Layer 2: 이번 턴에 이미 같은 호출 → 즉시 reject (백엔드 도달 안 함)
            result = {
              success: false,
              error: '이번 턴에 같은 인자로 이미 호출된 도구입니다. 직전 결과를 사용하거나 다른 인자로 호출하세요. 같은 호출 retry 금지.',
              duplicateInTurn: true,
            };
            this.logger.warn(`[AiManager] [${corrId}] Tool 중복 호출 차단 (per-turn): ${tc.name}`);
          } else {
            turnCallSet.add(cacheKey);
            const cached = getCachedToolResult(cacheKey);
            if (cached) {
              // Layer 1: cross-turn cache hit (60초 내 같은 호출) → 직전 결과 재사용
              result = { ...cached, fromCache: true };
              this.logger.info(`[AiManager] [${corrId}] Tool cache HIT: ${tc.name} — 직전 결과 재사용 (백엔드 호출 0)`);
            } else {
              result = await this.dispatcher.executeToolCall(tc, opts);
              setCachedToolResult(cacheKey, result);
            }
          }
        }
        toolResults.push({ name: tc.name, result });

        if (result.success === false) {
          this.logger.warn(`[AiManager] [${corrId}] Tool 실패: ${tc.name} — ${(result.error as string || '').slice(0, 200)}`);
          onToolCall?.({ name: tc.name, status: 'error', error: result.error as string });
        } else {
          const resultPreview = JSON.stringify(result).slice(0, 200);
          this.logger.info(`[AiManager] [${corrId}] Tool 결과: ${tc.name} — ${resultPreview}`);
          onToolCall?.({ name: tc.name, status: 'done' });
        }

        // suggest 도구는 args.suggestions, propose_plan 도구는 result.suggestions (plan-confirm 포함)
        if (tc.name === 'suggest' && tc.args.suggestions) {
          suggestions = tc.args.suggestions as unknown[];
        }
        if (tc.name === 'propose_plan' && Array.isArray((result as { suggestions?: unknown[] }).suggestions)) {
          suggestions = (result as { suggestions: unknown[] }).suggestions;
        }
        // render_html 결과 수집 (프론트엔드에서 iframe 렌더링)
        if (tc.name === 'render_html' && result.success !== false && result.htmlContent) {
          collectedData.push({ htmlContent: result.htmlContent, htmlHeight: result.htmlHeight });
        }
      }

      // 중간 턴 text push — 단, 이전 text 블록과 실질적 중복이면 스킵 (signature 기반)
      if (text) {
        const sig = (s: string) => s.replace(/[\d()（）\[\]{}.*_~\-\s,!?:;'"`。、]/g, '');
        const newSig = sig(text);
        const isDup = blocks.some(b => {
          if (b.type !== 'text' || !b.text) return false;
          const ex = b.text.trim();
          if (ex === text || ex.includes(text) || text.includes(ex)) return true;
          const exSig = sig(ex);
          if (newSig.length < 30 || exSig.length < 30) return false;
          const minLen = Math.min(newSig.length, exSig.length);
          const threshold = Math.floor(minLen * 0.7);
          return exSig.slice(0, threshold) === newSig.slice(0, threshold);
        });
        if (!isDup) blocks.push({ type: 'text', text });
      }
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const result = toolResults[i]?.result;
        if (!result || result.success === false) continue;
        if (tc.name === 'render_html' && result.htmlContent) {
          blocks.push({ type: 'html', htmlContent: result.htmlContent as string, htmlHeight: result.htmlHeight as string | undefined });
        } else if ((tc.name === 'render' || RENDER_TOOL_MAP[tc.name]) && result.component) {
          blocks.push({ type: 'component', name: result.component as string, props: (result.props as Record<string, unknown>) ?? {} });
        }
      }

      // 교환 히스토리에 추가 (멀티턴 도구 루프용)
      // rawModelParts 보존: Gemini 3는 functionCall에 thought_signature 필수 → 원본 parts 그대로 재전송해야 400 방지
      // LLM 경로는 slimResultForLLM으로 축약 (render 대용량 props·sysmod 긴 결과는 요약·블록/UI는 이미 blocks에 저장됨)
      const slimResults = toolResults.map(tr => ({ ...tr, result: slimResultForLLM(tr.name, tr.result) }));
      toolExchanges.push({ toolCalls, toolResults: slimResults, rawModelParts });

      // 텍스트 응답이 있으면 누적
      if (text) finalReply = text;

      // propose_plan 호출 시 강제 턴 종료 — 사용자가 ✓실행 누른 뒤에야 다음 작업 진행
      // (PlanCard + suggestions 는 blocks/suggestions 에 이미 적재됨)
      // trailing text 는 PlanCard 와 정보 중복이므로 drop — 위/아래 카드 위치 참조 문구도 자연스레 제거
      // isProposePlanTurn 은 CLI 내부 사용까지 포함 (toolCalls 는 비어도 internallyUsedTools 로 감지됨)
      if (isProposePlanTurn) {
        this.logger.info(`[AiManager] [${corrId}] propose_plan 호출 감지 → trailing text drop + 승인 대기 위해 턴 종료`);
        finalReply = '';
        break;
      }
    }

    // Fallback: MAX_TOOL_TURNS 소진 등으로 최종 턴 도달 못한 경우, 마지막 중간 turn의 text라도 사용
    if (!finalReply && blocks.length > 0) {
      // 이 시점에 finalReply는 마지막 intermediate turn의 text로 세팅됨 (루프 안 `if (text) finalReply = text`)
    }
    if (finalReply && !blocks.some(b => b.type === 'text')) {
      blocks.push({ type: 'text', text: finalReply });
    }

    const totalMs = Date.now() - startTime;
    this.logger.info(`[AiManager] [${corrId}] [${modelId}] Function Calling 완료 (${executedActions.length}개 도구, ${totalMs}ms)`);

    // 라우터 캐시 score — 보수적 감점 (인프라·AI 판단 노이즈 최소화).
    //   성공 조건: AI 가 라우팅된 도구 중 1개라도 호출 + render 1회라도 호출.
    //   감점은 안 함 (유저 명시 피드백은 다음 턴의 selectTools 에서 자동 처리).
    {
      const routedTools = turnTools.map(t => t.name);
      const used = new Set(executedActions);
      const toolsUsed = routedTools.some(n => used.has(n));
      const renderUsed = executedActions.some(a => a === 'render' || a.startsWith('render_'));
      await this.toolRouter.recordTurnSuccess({ toolsUsed, renderUsed });
    }
    // 디버깅용: 최종 응답 전체 로깅 (추후 제거 가능)
    if (finalReply) {
      this.logger.info(`[AiManager] [${corrId}] 최종 응답 전체:\n${finalReply}`);
    }
    // Vertex AI 파인튜닝용 학습 데이터 기록 (전체 멀티턴 contents)
    this.trainingLogContents(prompt, toolExchanges, finalReply, recentHistory);

    // 마크다운 표·헤더 자동 변환 — AI 가 |---| 표 / ## 헤더 그대로 출력하면 backend 가 추출
    // 순서 보존: extractMarkdownStructure 로 segments 분할 → blocks 의 마지막 text 블록을 segments 로 교체
    // workReply: 시스템·history 용 텍스트 (표/헤더 마크다운 유지)
    let workReply = finalReply;
    if (workReply) {
      const { segments } = extractMarkdownStructure(workReply);
      const hasNonText = segments.some(s => s.type !== 'text');
      if (hasNonText) {
        // 마지막 text 블록 제거 후 segments 를 순서대로 push
        const lastTextIdx = blocks.findIndex(b => b.type === 'text');
        const remainingBlocks = lastTextIdx >= 0 ? blocks.filter((_, i) => i !== lastTextIdx) : [...blocks];
        const newBlocks = remainingBlocks.slice();
        let tableCount = 0, headerCount = 0;
        for (const seg of segments) {
          if (seg.type === 'text') {
            newBlocks.push({ type: 'text', text: seg.text });
          } else if (seg.type === 'header') {
            newBlocks.push({ type: 'component', name: 'Header', props: { text: seg.text, level: seg.level } });
            headerCount++;
          } else if (seg.type === 'table') {
            newBlocks.push({ type: 'component', name: 'Table', props: { headers: seg.headers, rows: seg.rows } });
            tableCount++;
          }
        }
        blocks.length = 0;
        blocks.push(...newBlocks);
        this.logger.info(`[AiManager] [${corrId}] 마크다운 자동 변환: 표 ${tableCount}개 + 헤더 ${headerCount}개`);
        // workReply 는 history·sanitizeReply 용으로 text segments 만 합침 (헤더·표는 component 로 별도 push 됐으므로 중복 방지)
        workReply = segments.filter(s => s.type === 'text').map(s => (s as { text: string }).text).join('\n\n');
      }
    }

    // 중앙 sanitize — blocks props 의 text·numeric 필드 자동 정제 (render_text/render_html 은 원본 유지)
    // + isValidBlock 으로 name/text/htmlContent 누락 블록 제거 ('지원되지 않는 컴포넌트 ()' 방지)
    const droppedBlocks = blocks.filter(b => !isValidBlock(b));
    if (droppedBlocks.length > 0) {
      this.logger.warn(`[AiManager] [${corrId}] isValidBlock 으로 ${droppedBlocks.length}개 블록 제거: ${JSON.stringify(droppedBlocks).slice(0, 500)}`);
    }
    const sanitizedBlocks = blocks
      .filter(isValidBlock)
      .map(b => sanitizeBlock(b as Record<string, unknown>));
    // 디버깅: blocks 의 type/name 요약 (props 없이) — 빈 컴포넌트 추적용
    if (sanitizedBlocks.length > 0) {
      const summary = sanitizedBlocks.map((b: any, i: number) => {
        const t = b.type || '?';
        const n = b.name || '';
        const propsKeys = b.props && typeof b.props === 'object' ? Object.keys(b.props).join(',') : '';
        return `[${i}] type=${t} name=${n} propsKeys=${propsKeys}`;
      }).join(' | ');
      this.logger.info(`[AiManager] [${corrId}] sanitized blocks(${sanitizedBlocks.length}): ${summary}`);
    }
    const sanitizedReply = sanitizeReply(workReply);

    const hasData = collectedData.length > 0 || suggestions.length > 0 || pendingActions.length > 0 || sanitizedBlocks.length > 0 || !!currentResponseId;
    return {
      success: true,
      reply: sanitizedReply,
      executedActions,
      data: hasData
        ? {
            ...(suggestions.length > 0 ? { suggestions } : {}),
            ...(collectedData.length > 0 ? { htmlItems: collectedData } : {}),
            ...(pendingActions.length > 0 ? { pendingActions } : {}),
            ...(sanitizedBlocks.length > 0 ? { blocks: sanitizedBlocks } : {}),
            ...(currentResponseId ? { responseId: currentResponseId } : {}),
          }
        : undefined,
    };
  }

  /**
   * 승인 필요 여부 판정 — 위험 도구만 반환, 아니면 null
   *  write_file/save_page: 기존 존재 시만 (덮어쓰기=수정)
   *  delete_file/delete_page/schedule_task: 항상
   */



  /** Core.resolveCallTarget 이 위임 — ToolDispatcher 가 캐시·매칭 로직 보유. */
  async resolveCallTarget(identifier: string): Promise<{ kind: 'mcp'; server: string } | { kind: 'execute'; path: string } | null> {
    return this.dispatcher.resolveCallTarget(identifier);
  }

  /** 동적 도구 정의 빌드 — Core 정적 도구 + MCP 외부 도구 (60초 캐시) */
  async buildToolDefinitions(): Promise<ToolDefinition[]> {
    if (this._toolsCache && (Date.now() - this._toolsCache.ts) < AiManager.TOOLS_CACHE_TTL) {
      return this._toolsCache.tools;
    }

    // 동적 도구 (sysmod_* / mcp_*) 는 매 캐시 갱신 시 ToolManager 에 재등록.
    // 정적 도구는 constructor 의 registerStaticToolsToManager() 에서 1회 등록 (변경 X).
    // 기존 동적 등록 클리어 → 모듈/MCP 추가/삭제 반영
    for (const def of this.core.listTools({ source: ['sysmod', 'mcp'] })) {
      this.core.unregisterTool(def.name);
    }

    // 시스템 모듈 → ToolManager 에 sysmod 도구 등록 (handler = sandboxExecute)
    const sysModules = await this.core.listDir('system/modules');
    if (sysModules.success && sysModules.data) {
      for (const d of sysModules.data.filter(e => e.isDirectory)) {
        const file = await this.core.readFile(`system/modules/${d.name}/config.json`);
        if (!file.success || !file.data) continue;
        try {
          const cfg = JSON.parse(file.data);
          if (cfg.type !== 'module' || !cfg.input) continue;
          const moduleName = cfg.name || d.name;
          if (!this.core.isModuleEnabled(moduleName)) continue;
          const rt = cfg.runtime === 'node' ? 'index.mjs' : cfg.runtime === 'python' ? 'main.py' : 'index.mjs';
          const toolName = `sysmod_${d.name.replace(/-/g, '_')}`;
          const modulePath = `system/modules/${d.name}/${rt}`;
          this.core.registerTool({
            name: toolName,
            source: 'sysmod',
            description: `[시스템 모듈] ${cfg.description || d.name}`,
            parameters: sanitizeSchema(cfg.input) as unknown as Record<string, unknown>,
            handler: async (args) => {
              const res = await this.core.sandboxExecute(modulePath, args);
              if (!res.success) return { success: false, error: res.error };
              if (res.data?.success === false) return { success: false, error: JSON.stringify(res.data) };
              return { success: true, data: res.data };
            },
            meta: { path: modulePath, capability: cfg.capability },
          });
          // 경로 매핑·capability 캐시 (ToolSearchIndex 임베딩 힌트)
          this._sysmodPaths.set(toolName, modulePath);
          if (cfg.capability) this._toolCapabilities.set(toolName, cfg.capability as string);
        } catch { /* config 파싱 실패 — 무시 */ }
      }
    }

    // MCP 외부 도구 → ToolManager 에 등록
    const mcpResult = await this.core.listAllMcpTools();
    if (mcpResult.success && mcpResult.data) {
      for (const t of mcpResult.data) {
        const server = t.server;
        const toolNameOnly = t.name;
        this.core.registerTool({
          name: `mcp_${server}_${toolNameOnly}`,
          source: 'mcp',
          description: `[MCP ${server}] ${t.description}`,
          parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          handler: async (args) => {
            const res = await this.core.callMcpTool(server, toolNameOnly, args);
            return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
          },
          meta: { server, tool: toolNameOnly },
        });
      }
    }

    // LLM 용 도구 정의 = ToolManager 의 모든 활성 도구 (정적 + 동적)
    const built = this.core.buildAiToolDefinitions();
    const tools: ToolDefinition[] = built.map(b => ({
      name: b.name,
      description: b.description,
      parameters: b.parameters as unknown as JsonSchema,
    }));
    this._toolsCache = { tools, ts: Date.now() };
    return tools;
  }

  /** 캐시 무효화 (모듈 추가/삭제/설정 변경 시 호출) — promptBuilder + tools cache 둘 다 */
  invalidateCache(): void {
    this.promptBuilder.invalidate();
    this._toolsCache = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  코드 어시스트
  // ══════════════════════════════════════════════════════════════════════════

  /** 코드 수정 제안 (FileEditor AI 어시스턴트) */
  async codeAssist(params: {
    code: string;
    language: string;
    instruction: string;
    selectedCode?: string;
  }, opts?: AiRequestOpts): Promise<InfraResult<string>> {
    const { code, language, instruction, selectedCode } = params;
    const llmOpts: LlmCallOpts = {};
    if (opts?.model) llmOpts.model = opts.model;
    if (opts?.thinkingLevel) llmOpts.thinkingLevel = opts.thinkingLevel;

    // 사용자 지시를 분석·설명 모드 vs 코드 수정 모드로 분기.
    // "알려줘/설명/분석/검토/리뷰/뭐가 문제/왜" 계열은 설명(마크다운) 반환,
    // 그 외("수정/추가/리팩토링/고쳐줘/만들어줘" 등)는 raw 코드 반환.
    const explainKeywords = ['알려줘', '알려달', '설명', '분석', '검토', '리뷰', '뭐가 문제', '왜', '어떻게', '파악', '평가', 'explain', 'review', 'analyze', 'analyse', 'what does', 'why', 'describe'];
    const lowered = instruction.toLowerCase();
    const isExplainMode = explainKeywords.some(k => instruction.includes(k) || lowered.includes(k.toLowerCase()));

    // 모나코 codeAssist 는 코드 어시스턴트 역할 — 사용자 커스텀 프롬프트(페르소나·톤·도메인) 주입 불가.
    // 코드 품질에 부적절한 영향 차단 (예: '반말 써' 설정이 주석에 박히는 것). 어드민 채팅만 유저 섹션 주입.
    const basePrompt = isExplainMode
      ? [
          '당신은 Monaco 에디터에 통합된 코드 리뷰어입니다.',
          '**도구 호출·파일 I/O 불가** — 오직 응답 텍스트만 반환.',
          '사용자는 코드를 이해하거나 개선점을 알고 싶어합니다. 코드 재작성 금지.',
          '',
          '## 응답 형식',
          '- 한국어 마크다운. bullet points + 짧은 섹션.',
          '- 반드시 구체적 line 번호·함수명·변수명을 언급.',
          '- 원본 코드를 그대로 재출력하지 마라 (사용자는 이미 코드를 보고 있음).',
          '- actionable 관찰만. "좋은 코드입니다" 같은 평가·칭찬 금지.',
          '',
          '## 안전 가이드라인',
          '- destructive 조작(rm -rf, DROP TABLE, git reset --hard 등) 추천 금지.',
          '- 추측 대신 근거 — 확실하지 않은 동작은 "확인 필요" 로 표시.',
          '',
          `## 대상 언어: ${language}`,
        ].join('\n')
      : [
          '당신은 Monaco 에디터에 통합된 코드 어시스턴트입니다.',
          '**도구 호출·파일 I/O 불가** — 오직 응답 텍스트만 반환.',
          '',
          '## 응답 형식',
          '- 오직 raw 코드만. 설명·마크다운 코드펜스(```) 금지.',
          '- 원본 들여쓰기·네이밍·언어 관례 보존.',
          '- 선택 영역이 주어지면 그 부분만 교체, 아니면 파일 전체 재작성.',
          '- 주석은 한국어로 (원본이 영어 주석 유지 중이 아니라면).',
          '',
          '## 안전·품질',
          '- 명백한 버그·엣지 케이스(null/빈 배열/타입 불일치)는 함께 수정.',
          '- 새 외부 의존성 추가 금지 (있는 것 활용).',
          '- destructive 조작·eval·Function constructor 사용 금지.',
          '',
          `## 대상 언어: ${language}`,
        ].join('\n');

    const systemPrompt = basePrompt;

    const context = selectedCode
      ? `Selected code${isExplainMode ? '' : ' (modify this)'}:\n${selectedCode}\n\nFull file for context:\n${code}`
      : `Full file:\n${code}`;

    const result = await this.llm.askText(`Instruction: ${instruction}\n\n${context}`, systemPrompt, llmOpts);
    if (!result.success) return result;

    // 설명 모드에선 마크다운 그대로 유지. 코드 모드에선 코드블록 래퍼 제거.
    const raw = result.data ?? '';
    const cleaned = isExplainMode
      ? raw.trim()
      : raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

    return { success: true, data: cleaned };
  }
}
