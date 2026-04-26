import type { FirebatCore, AiRequestOpts } from '../index';
import type { ILlmPort, ILogPort, LlmCallOpts, LlmChunk, ChatMessage, PageListItem, ToolDefinition, JsonSchema, ToolCall, ToolResult, ToolExchangeEntry, IDatabasePort, IToolRouterPort, ToolRouterFactory } from '../ports';
import { CoreResult, type InfraResult } from '../types';
import { sanitizeBlock, sanitizeReply, isValidBlock, extractMarkdownStructure } from '../utils/sanitize';
import { RENDER_TOOL_MAP, normalizeRenderName } from '../../lib/render-map';
import { trimToolResult, slimResultForLLM } from './ai/result-processor';
import { HistoryResolver } from './ai/history-resolver';
import { PromptBuilder } from './ai/prompt-builder';
import { ToolRouter } from './ai/tool-router';
import { IMAGE_GEN_DESCRIPTION } from '../../lib/image-gen-prompt';

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
  /** AI 가 호출한 identifier (서버명·모듈명·sysmod_*·full path) → 실제 dispatch target.
   *  AI 가 도구 호출 일관성 부족해도 backend 가 자동 보정 (kakao_talk → system/modules/kakao-talk/index.mjs 등). */
  private _callTargetCache: { map: Map<string, { kind: 'mcp'; server: string } | { kind: 'execute'; path: string }>; ts: number } | null = null;
  private static readonly CALL_TARGET_TTL = 60_000;

  /** 현재 turn 의 직전 user 쿼리 — search_history 쿼리 맥락 보강용 */
  private _currentTurnPrevUserQuery = '';

  /** 내부 collaborator — AI 도메인 분리 (ResultProcessor / HistoryResolver / PromptBuilder / ToolRouter / ...) */
  private readonly history: HistoryResolver;
  private readonly promptBuilder: PromptBuilder;
  private readonly toolRouter: ToolRouter;

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
    for (const def of this.getCoreToolDefinitions()) {
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
    for (const renderTool of this.buildRenderTools()) {
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
    const MAX_TOOL_TURNS = 10;
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
    const systemPrompt = await this.promptBuilder.build(currentModel);

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

    // 플랜모드 ON = "사용자 협의 모드". 작업 종류별로 협의 방식이 다름:
    //   - 분석/조사/리포트류 → propose_plan 카드
    //   - 앱/페이지/모듈 생성 → 3단계 suggest (기능 → 디자인 → 구현)
    //   - 예외 0건 (인사·단답도 plan 카드 강제)
    // 시스템 프롬프트 맨 앞에 prepend 해서 우선순위 보장.
    const planModePrefix = opts?.planMode === true
      ? `# ⚡ 플랜모드 ON — 사용자 협의 모드 (다른 모든 규칙보다 우선)

사용자가 플랜모드를 켰습니다. **첫 응답은 작업 종류에 맞는 협의 도구만 호출하고 즉시 턴 종료**.

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
- **예외 0건** — 사용자가 토글 ON 한 이상 모든 요청에 plan 카드. "단순 조회·인사라 plan 불필요" 같은 자체 판단 **절대 금지**.

**오직 직전 plan 의 ✓실행 직후 follow-up (planExecuteId 동봉된 턴) 만 plan 카드 없이 실제 작업 진행.**

## 절대 규칙
- 위 협의 도구 호출 후 **즉시 턴 종료** — 다른 도구·텍스트 응답 금지
- "단답이라 plan 불필요" / "단순 정치 뉴스라 plan 필요 없었어요" 같은 변명 금지 — **모든 요청에 plan**
- SVG vs Canvas 같은 기술적 접근 먼저 묻기 금지 (3단계 스킵)
- 긴 텍스트 설명으로 제안 나열 금지 — 반드시 suggest UI 선택지로
- 시스템 프롬프트 다른 곳의 propose_plan / 3단계 예외 규칙 모두 무력화

─────────────────────────────────────

`
      : '';
    // 도구 정의 빌드 (캐시 활용). 실제 LLM 전송 방식(MCP connector vs 인라인)은 어댑터가 결정.
    const allToolsRaw = await this.buildToolDefinitions();
    // AI Assistant ON 시: backend 가 자동 search_history 처리 → User AI 도구 목록에서 제외 (중복 방지)
    // 플랜 토글: ON = 무조건 plan 강제 (시스템 프롬프트로), OFF = AI 자유 판단 (도구 그대로 유지)
    const allTools = this.toolRouter.isEnabled()
      ? allToolsRaw.filter(t => t.name !== 'search_history')
      : allToolsRaw;
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
      // 최종 응답 턴 (toolExchanges 가 쌓여있는 상태 = 이번에 tool_choice:none 기대) 은 0.7.
      // turn 번호만으로 안 건 불확실해서 "이전 턴에 도구 호출이 있었나" 기준:
      //  - 아직 도구 호출 기록 없음 → 이번 턴도 도구 호출 가능성 높음 (낮은 temp)
      //  - 도구 호출이 이미 있었음 → 이번엔 summarize turn 일 가능성 (높은 temp)
      // Heuristic 이라 완벽치 않지만 실험적으로 효과 있음.
      const dynamicTemp = toolExchanges.length === 0 ? 0.2 : 0.7;
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
      // 플랜모드 ON: 첫 턴(toolExchanges 비어있을 때) 의 user 프롬프트 앞에 한 줄 hint 추가 — Gemini 가 시스템 프롬프트 무시 시 fallback
      const promptForLlm = (opts?.planMode === true && toolExchanges.length === 0)
        ? `[플랜모드 ON — 모든 요청에 propose_plan 먼저 호출 (예외 0건, 인사·단답도 plan). 앱 만들기만 suggest 3단계. 호출 후 즉시 턴 종료]\n\n${prompt}`
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

        // 사전검증 — AI가 스스로 재시도할 수 있도록 UI에는 노출하지 않고 tool 결과로만 피드백
        const approvalPeek = await this.checkNeedsApproval(tc);
        let preValidError: string | null = null;
        if (approvalPeek) preValidError = this.preValidatePendingArgs(tc);

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
              result = await this.executeToolCall(tc, opts);
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
  private async checkNeedsApproval(tc: ToolCall): Promise<{ summary: string } | null> {
    switch (tc.name) {
      case 'write_file': {
        const path = (tc.args as { path?: string }).path;
        if (!path) return null;
        const exists = await this.core.readFile(path);
        if (!exists.success) return null; // 새 파일은 즉시 작성
        return { summary: `파일 수정: ${path}` };
      }
      case 'save_page': {
        const slug = (tc.args as { slug?: string }).slug;
        if (!slug) return null;
        const exists = await this.core.getPage(slug);
        if (!exists.success) return null; // 새 페이지는 즉시 저장
        return { summary: `페이지 수정: /${slug}` };
      }
      case 'delete_file': {
        const path = (tc.args as { path?: string }).path;
        return { summary: `파일 삭제: ${path ?? '(unknown)'}` };
      }
      case 'delete_page': {
        const slug = (tc.args as { slug?: string }).slug;
        return { summary: `페이지 삭제: /${slug ?? '(unknown)'}` };
      }
      case 'schedule_task': {
        const args = tc.args as { title?: string; cronTime?: string; runAt?: string; delaySec?: number };
        const when = args.cronTime ?? args.runAt ?? (args.delaySec != null ? `${args.delaySec}초 후` : '');
        return { summary: `예약 등록: ${args.title ?? '(제목 없음)'} (${when})` };
      }
      default:
        return null;
    }
  }

  /** 승인 대기 도구 인자 사전 검증 — 실패 시 에러 메시지 반환 */
  private preValidatePendingArgs(tc: ToolCall): string | null {
    const args = tc.args as Record<string, unknown>;
    switch (tc.name) {
      case 'schedule_task': {
        const hasTarget = typeof args.targetPath === 'string' && (args.targetPath as string).trim() !== '';
        const hasPipeline = Array.isArray(args.pipeline) && (args.pipeline as unknown[]).length > 0;
        if (!hasTarget && !hasPipeline) {
          return 'schedule_task 인자 누락: targetPath 또는 pipeline 중 하나는 반드시 지정해야 합니다.';
        }
        const hasWhen = !!args.cronTime || !!args.runAt || args.delaySec != null;
        if (!hasWhen) return 'schedule_task 인자 누락: cronTime / runAt / delaySec 중 하나는 반드시 지정해야 합니다.';
        // 파이프라인 있으면 각 step의 필수 필드까지 검증 (type 누락 등)
        if (hasPipeline) {
          const pipeline = args.pipeline as unknown[];
          for (let i = 0; i < pipeline.length; i++) {
            const step = pipeline[i] as Record<string, unknown> | null;
            if (!step || typeof step !== 'object') return `[Step ${i + 1}] step이 객체가 아닙니다.`;
            const t = step.type;
            if (!t || typeof t !== 'string') return `[Step ${i + 1}] type 누락 — EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION 중 하나를 지정하세요.`;
            if (!['EXECUTE', 'MCP_CALL', 'NETWORK_REQUEST', 'LLM_TRANSFORM', 'CONDITION'].includes(t)) {
              return `[Step ${i + 1}] 알 수 없는 type: ${t}`;
            }
            if (t === 'EXECUTE') {
              if (!step.path) return `[Step ${i + 1}] EXECUTE에 path 필수 (예: system/modules/kakao-talk/index.mjs).`;
              const id = step.inputData as Record<string, unknown> | undefined;
              if (!id || typeof id !== 'object' || Object.keys(id).length === 0) {
                return `[Step ${i + 1}] EXECUTE 인자 오류: 모듈 실행 파라미터는 step 평면이 아니라 inputData 객체에 넣어야 합니다. 잘못: {type:"EXECUTE",path:"...",action:"price",symbol:"..."} · 올바름: {type:"EXECUTE",path:"...",inputData:{action:"price",symbol:"..."}}`;
              }
            }
            if (t === 'MCP_CALL' && (!step.server || !step.tool)) return `[Step ${i + 1}] MCP_CALL에 server, tool 필수.`;
            if (t === 'NETWORK_REQUEST' && !step.url) return `[Step ${i + 1}] NETWORK_REQUEST에 url 필수.`;
            if (t === 'LLM_TRANSFORM' && !step.instruction) return `[Step ${i + 1}] LLM_TRANSFORM에 instruction 필수.`;
            if (t === 'CONDITION' && (!step.field || !step.op)) return `[Step ${i + 1}] CONDITION에 field, op 필수.`;
          }
        }
        return null;
      }
      case 'write_file': {
        if (typeof args.path !== 'string' || !(args.path as string).trim()) return 'write_file 인자 누락: path 필수.';
        if (args.content == null) return 'write_file 인자 누락: content 필수.';
        return null;
      }
      case 'save_page': {
        if (typeof args.slug !== 'string' || !(args.slug as string).trim()) return 'save_page 인자 누락: slug 필수.';
        if (!args.spec || typeof args.spec !== 'object') return 'save_page 인자 누락: spec 필수.';
        return null;
      }
      default:
        return null;
    }
  }

  /** 단일 도구 호출 실행 — 결과를 Record<string, unknown>로 반환 */
  private async executeToolCall(tc: ToolCall, opts?: AiRequestOpts): Promise<Record<string, unknown>> {
    try {
      // 1) ToolManager 등록 도구 — 정적·동적 모두 단일 dispatch.
      if (this.core.getToolDefinition(tc.name)) {
        return await this.core.executeTool(tc.name, tc.args as Record<string, unknown>, {
          conversationId: opts?.conversationId,
          owner: opts?.owner,
          requestOpts: opts as Record<string, unknown> | undefined,
        });
      }
      // 2) render_* 변형 정규화 — AI 가 'table' / 'render-chart' 등으로 불러도 매칭.
      const renderName = normalizeRenderName(tc.name);
      if (renderName && RENDER_TOOL_MAP[renderName]) {
        return { success: true, component: RENDER_TOOL_MAP[renderName], props: tc.args as Record<string, unknown> };
      }
      // 3) 통합 resolver — sysmod / mcp 자동 분기:
      //    kiwoom / sysmod_kakao-talk / kakao_talk → system module
      //    mcp_firebat_save_page → MCP 서버(firebat) 도구(save_page)
      //    외부 MCP 서버명 → MCP 호출
      const target = await this.resolveCallTarget(tc.name);
      if (target?.kind === 'execute') {
        const res = await this.core.sandboxExecute(target.path, tc.args);
        if (!res.success) return { success: false, error: res.error };
        if (res.data?.success === false) return { success: false, error: JSON.stringify(res.data) };
        return { success: true, data: res.data };
      }
      // mcp_{server}_{tool} 접두사 — server/tool 분리
      if (tc.name.startsWith('mcp_')) {
        const parts = tc.name.slice(4).split('_');
        const server = parts[0];
        const tool = parts.slice(1).join('_');
        const res = await this.core.callMcpTool(server, tool, tc.args);
        return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
      }
      if (target?.kind === 'mcp') {
        return { success: false, error: `MCP 서버 '${target.server}' 호출 시 도구 이름 명시 필요 (예: mcp_${target.server}_{tool} 형태).` };
      }
      return { success: false, error: `알 수 없는 도구: ${tc.name}` };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }


  /**
   * 안전망·보편 도구 2개만 직접 노출 (render_alert/render_callout).
   * 나머지 13개는 component-registry로 이동 — search_components 로 발견하고 render 로 호출.
   */
  private buildRenderTools(): ToolDefinition[] {
    return [
      {
        name: 'render_alert',
        description: '경고·주의·위험 박스(빨강/주황 계열). 리스크·오류·경고 메시지 전용. 일반 정보/팁/강조는 render_callout 사용.',
        strict: true,
        parameters: {
          type: 'object',
          required: ['message', 'type', 'title'],
          additionalProperties: false,
          properties: {
            message: { type: 'string' },
            type: { type: 'string', enum: ['warn', 'error'], description: 'warn=주황(주의/경고), error=빨강(위험/오류)' },
            title: { type: ['string', 'null'], description: '제목 (불필요하면 null)' },
          },
        },
      },
      {
        name: 'render_callout',
        description: '일반 정보/강조 박스. 배경색으로 의미 구분. 경고/위험은 render_alert 사용.',
        strict: true,
        parameters: {
          type: 'object',
          required: ['message', 'type', 'title'],
          additionalProperties: false,
          properties: {
            message: { type: 'string' },
            type: {
              type: 'string',
              enum: ['info', 'success', 'tip', 'accent', 'highlight', 'neutral'],
              description: 'info=파랑(정보), success=초록(완료/긍정 결과), tip=보라(팁/추천), accent=주황(강조/핵심 포인트), highlight=노랑(주목/하이라이트), neutral=회색(일반/참고 메모)',
            },
            title: { type: ['string', 'null'], description: '제목 (불필요하면 null)' },
          },
        },
      },
    ];
  }


  // render_* 도구 매핑은 lib/render-map.ts 단일 source 에서 import (RENDER_TOOL_MAP)

  /** Function Calling 전용 시스템 프롬프트 — 도구·스키마·보안·아키텍처 규칙만.
   *  비서 톤·페르소나·응답 분량 같은 취향 가이드는 모두 제거 — 사용자가 원하면 설정에서 지시. */

  // ══════════════════════════════════════════════════════════════════════════
  //  Function Calling — 도구 정의 빌더
  // ══════════════════════════════════════════════════════════════════════════

  /** 파이프라인 단계 JSON Schema — RUN_TASK, SCHEDULE_TASK에서 재사용 */
  private get pipelineStepSchema(): JsonSchema {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'EXECUTE | MCP_CALL | NETWORK_REQUEST | LLM_TRANSFORM | CONDITION | SAVE_PAGE', enum: ['EXECUTE', 'MCP_CALL', 'NETWORK_REQUEST', 'LLM_TRANSFORM', 'CONDITION', 'SAVE_PAGE'] },
        description: { type: 'string', description: '단계 설명' },
        path: { type: 'string', description: 'EXECUTE: 모듈 경로 (예: system/modules/kiwoom/index.mjs)' },
        inputData: { type: 'object', description: '이 단계의 자체 입력. EXECUTE/SAVE_PAGE 등에서 사용 (예: {action, symbol} 또는 {slug, spec}).', additionalProperties: true },
        inputMap: { type: 'object', description: '$prev 매핑 (예: {"url":"$prev.url"} 또는 SAVE_PAGE 의 {"spec":"$prev"})', additionalProperties: true },
        server: { type: 'string', description: 'MCP_CALL: 서버 이름' },
        tool: { type: 'string', description: 'MCP_CALL: 도구 이름' },
        arguments: { type: 'object', description: 'MCP_CALL: 도구 인자', additionalProperties: true },
        url: { type: 'string', description: 'NETWORK_REQUEST: URL' },
        method: { type: 'string', description: 'NETWORK_REQUEST: HTTP 메서드', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', description: 'NETWORK_REQUEST: HTTP 헤더', additionalProperties: true },
        body: { type: 'string', description: 'NETWORK_REQUEST: 요청 본문' },
        instruction: { type: 'string', description: 'LLM_TRANSFORM: 변환 지시문 (텍스트 변환만 — sysmod_/save_page/image_gen 등 도구명 등장 시 거부됨)' },
        field: { type: 'string', description: 'CONDITION: 검사 대상 ($prev, $prev.price 등)' },
        op: { type: 'string', description: 'CONDITION: 비교 연산자', enum: ['==', '!=', '<', '<=', '>', '>=', 'includes', 'not_includes', 'exists', 'not_exists'] },
        value: { type: 'string', description: 'CONDITION: 비교 값 (숫자 또는 문자열)' },
        slug: { type: 'string', description: 'SAVE_PAGE: 페이지 slug (예: "stock-blog/2026-04-25-close")' },
        spec: { type: 'object', description: 'SAVE_PAGE: PageSpec 객체 (head + body). 보통 inputMap:{spec:"$prev"} 로 직전 LLM_TRANSFORM 결과 매핑.', additionalProperties: true },
        allowOverwrite: { type: 'boolean', description: 'SAVE_PAGE: 같은 slug 페이지 덮어쓰기 허용 (기본 false — 충돌 시 -N 접미사 자동)' },
      },
      required: ['type'],
    };
  }

  /** 정적 Core 액션 도구 정의 — FirebatAction 타입에서 파생 */
  private getCoreToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'write_file',
        description: '파일 생성/덮어쓰기. user/modules/ 내부만 허용.',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', description: '저장할 파일 경로 (예: user/modules/weather/main.py)' },
            content: { type: 'string', description: '파일 내용 전체' },
          },
        },
      },
      {
        name: 'read_file',
        description: '파일 내용 읽기.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '읽을 파일 경로' },
            lines: { type: 'integer', description: '처음 N줄만 읽기 (선택)' },
          },
        },
      },
      {
        name: 'list_dir',
        description: '디렉토리 내 파일/폴더 목록 조회.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '조회할 폴더 경로 (예: user/modules)' },
          },
        },
      },
      {
        name: 'append_file',
        description: '파일 끝에 내용 추가.',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', description: '추가할 파일 경로' },
            content: { type: 'string', description: '추가할 내용' },
          },
        },
      },
      {
        name: 'delete_file',
        description: '파일 또는 폴더 삭제.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '삭제할 경로' },
          },
        },
      },
      {
        name: 'execute',
        description: '모듈 실행. 시스템/사용자 모듈의 경로와 입력 데이터를 전달.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '실행할 모듈 경로 (예: system/modules/firecrawl/index.mjs)' },
            inputData: { type: 'object', description: '모듈 입력 데이터', additionalProperties: true },
          },
        },
      },
      {
        name: 'network_request',
        description: 'HTTP 요청 실행.',
        parameters: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: '요청 URL' },
            method: { type: 'string', description: 'HTTP 메서드', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
            body: { type: 'string', description: '요청 본문 (JSON 문자열)' },
            headers: { type: 'object', description: 'HTTP 헤더', additionalProperties: true },
          },
        },
      },
      {
        name: 'save_page',
        description: `페이지 저장. slug 충돌 시 자동 -2 접미사 (allowOverwrite=false 기본). 사용자 명시적 수정 요청 시만 allowOverwrite=true.`,
        parameters: {
          type: 'object',
          required: ['slug', 'spec'],
          properties: {
            slug: { type: 'string', description: '페이지 URL 슬러그 (kebab-case)' },
            spec: { type: 'object', description: 'PageSpec JSON (slug, head, body 포함)', additionalProperties: true },
            allowOverwrite: { type: 'boolean', description: '기존 페이지 덮어쓰기 허용 (명시적 수정 요청 시만 true)' },
          },
        },
      },
      {
        name: 'delete_page',
        description: '페이지 삭제.',
        parameters: {
          type: 'object',
          required: ['slug'],
          properties: {
            slug: { type: 'string', description: '삭제할 페이지 slug' },
          },
        },
      },
      {
        name: 'list_pages',
        description: 'DB에 저장된 페이지 목록 조회.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'schedule_task',
        description: '모듈/파이프라인 예약 실행 등록. 반복(cronTime), 1회(runAt), 지연(delaySec). 가격 알림 등 "조건 충족 시 1회 알림" 패턴은 cronTime + oneShot:true + CONDITION 스텝 조합.',
        parameters: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', description: '사이드바에 표시할 짧은 이름' },
            targetPath: { type: 'string', description: '단순 모듈 실행 시 경로 (pipeline 미사용 시에만)' },
            inputData: { type: 'object', description: 'targetPath 단일 실행용 입력. pipeline을 쓸 때는 이 필드 사용 금지 — 각 step의 inputData에 넣어라.', additionalProperties: true },
            pipeline: { type: 'array', description: '복합 작업 파이프라인. 각 step은 자체 inputData를 가져야 한다.', items: this.pipelineStepSchema },
            cronTime: { type: 'string', description: '반복 크론 표현식 (예: "0 9 * * *"). 주식 관련 스케줄은 평일 한정 "1-5" 요일 지정 필수.' },
            runAt: { type: 'string', description: '1회 실행 시각 (ISO 8601)' },
            delaySec: { type: 'number', description: 'N초 후 실행' },
            startAt: { type: 'string', description: '시작 시각 (ISO 8601)' },
            endAt: { type: 'string', description: '종료 시각 (ISO 8601)' },
            oneShot: { type: 'boolean', description: '첫 성공 시 자동 취소. 가격 알림 같은 "조건 충족 후 1회만" 케이스는 반드시 true. CONDITION 스텝 미충족 시에는 취소 안 되고 다음 주기에 재시도.' },
          },
        },
      },
      {
        name: 'cancel_task',
        description: '예약된 스케줄 해제.',
        parameters: {
          type: 'object',
          required: ['jobId'],
          properties: {
            jobId: { type: 'string', description: '해제할 잡 ID' },
          },
        },
      },
      {
        name: 'list_tasks',
        description: '등록된 스케줄(크론) 목록 조회.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'database_query',
        description: 'SQL 쿼리 실행.',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'SQL 쿼리 문자열' },
            params: { type: 'array', description: '바인딩 파라미터', items: { type: 'string' } },
          },
        },
      },
      {
        name: 'open_url',
        description: '새 탭에서 URL 열기.',
        parameters: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: 'URL 또는 경로 (예: /bmi-calculator)' },
          },
        },
      },
      {
        name: 'request_secret',
        description: '사용자에게 API 키 입력 요청. 프론트엔드에 입력 UI 표시.',
        parameters: {
          type: 'object',
          required: ['name', 'prompt'],
          properties: {
            name: { type: 'string', description: '시크릿 키 이름 (kebab-case)' },
            prompt: { type: 'string', description: '사용자 안내 메시지' },
            helpUrl: { type: 'string', description: 'API 키 발급 안내 URL (선택)' },
          },
        },
      },
      {
        name: 'run_task',
        description: '파이프라인 즉시 실행. 복합 작업(스크래핑→요약→발송 등)에 사용.',
        parameters: {
          type: 'object',
          required: ['pipeline'],
          properties: {
            pipeline: { type: 'array', description: '실행할 파이프라인 단계 배열', items: this.pipelineStepSchema },
          },
        },
      },
      {
        name: 'mcp_call',
        description: '외부 MCP 서버 도구 호출.',
        parameters: {
          type: 'object',
          required: ['server', 'tool'],
          properties: {
            server: { type: 'string', description: 'MCP 서버 이름 (예: gmail)' },
            tool: { type: 'string', description: '도구 이름' },
            arguments: { type: 'object', description: '도구 인자', additionalProperties: true },
          },
        },
      },
      // ── 14개 render_* 도구 (strict 모드로 스키마 엄격 준수 강제) ──
      ...this.buildRenderTools(),
      {
        name: 'render_html',
        description: '자유 HTML 인라인 렌더링 (iframe). 정형화된 UI(표·차트·리스트 등)는 search_components 로 찾아서 render(name, props) 로 호출. 경고·알림은 render_alert / render_callout 직접 호출. render_html 은 지도/다이어그램/애니메이션/수학식 등 CDN 라이브러리 필요할 때만. CDN 은 libraries 파라미터로 선택.',
        parameters: {
          type: 'object',
          required: ['html'],
          properties: {
            html: { type: 'string', description: '렌더링할 HTML (body 내용 또는 완전한 HTML 문서). libraries에서 선택한 CDN은 자동 삽입됨.' },
            height: { type: 'string', description: 'iframe 높이 (기본 400px). 예: "500px", "60vh"' },
            libraries: {
              type: 'array',
              description: '사용할 CDN 라이브러리 목록. 선택하면 자동으로 <script>/<link> 태그가 HTML <head>에 삽입됨.',
              items: {
                type: 'string',
                enum: ['d3', 'mermaid', 'leaflet', 'threejs', 'animejs', 'tailwindcss', 'katex', 'hljs', 'marked', 'cytoscape', 'mathjax', 'p5', 'lottie', 'datatables', 'swiper'],
              },
            },
          },
        },
      },
      {
        name: 'complete_plan',
        description: `진행 중인 plan 을 종료. 대화에 active_plan_state 가 세팅돼 있어 시스템 프롬프트에 plan 이 주입되고 있을 때 사용.

**호출해야 하는 케이스**:
- plan 의 모든 단계 (3-stage 공동설계·여러 단계 pipeline 등) 를 완료하고 사용자에게 최종 결과 보고한 직후
- 사용자가 plan 을 "이제 됐어", "취소", "그만" 등 종료 의사 표명 시

**호출하면**: conversations.active_plan_state 가 null 로 초기화 → 다음 턴부터 plan 맥락 주입 안 됨 (일반 대화로 돌아감)

**호출 금지**:
- plan 단계가 아직 남아있을 때 (e.g., 기능 선택만 받고 디자인 선택 아직 안 한 경우)
- active_plan_state 주입 안 된 일반 턴에서 (도구 목록에 있어도 호출 불필요)`,
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: '종료 사유 (로그용, 선택). 예: "3-stage 공동설계 완료", "사용자 취소"' },
          },
        },
      },
      {
        name: 'suggest',
        description: '사용자에게 선택지를 제시. 대화형 흐름에서 사용자 결정이 필요할 때 호출.',
        parameters: {
          type: 'object',
          required: ['suggestions'],
          properties: {
            suggestions: {
              type: 'array',
              description: '선택지 배열. 문자열=버튼, {"type":"input","label":"..","placeholder":".."}=입력, {"type":"toggle","label":"..","options":[..]}=다중 선택',
              items: { type: ['object', 'string'] },
            },
          },
        },
      },
      {
        name: 'image_gen',
        description: IMAGE_GEN_DESCRIPTION,
        parameters: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string', description: '이미지 설명 (영어 권장). 스타일·구도·색감·텍스트 힌트 포함.' },
            size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'], description: '출력 크기 (OpenAI gpt-image 만 유효, Gemini 는 무시). 미지정 시 서버 기본값.' },
            quality: { type: 'string', enum: ['low', 'medium', 'high'], description: '품질 (OpenAI 만 유효). low=$0.011 / medium=$0.042 / high=$0.17.' },
            filenameHint: { type: 'string', description: '파일명 힌트 (로그용 선택). 예: "blog-hero-samsung-2026"' },
          },
        },
      },
      {
        name: 'search_history',
        description: `과거 대화 벡터 검색. 사용자가 이전 대화의 데이터·결과를 참조·재활용하려 할 때 호출.

**호출해야 하는 케이스 (예시 — 패턴 인식):**
- "위/이전/방금/그/이거/저거/저번에" 등 지시·연속 표현 (예: "위 분석을 카톡으로", "그 차트 다시", "방금 결과 요약")
- 직전 분석·시각화·표 데이터를 가공·전달·요약 (예: "이거 카톡으로", "표만 다시", "결론만")
- 모델 전환 후 follow-up — Claude 분석 → Gemini 요약 같은 케이스에서 이전 모델의 결과 컨텍스트 가져와야 함

**호출 금지:**
- 인사·잡담·신규 독립 질문 (이전 맥락 불필요)
- AI Assistant ON 시: backend 가 자동으로 컨텍스트 주입하므로 직접 호출 금지 — 도구 목록에서도 제외됨

**옵션:**
- includeBlocks=true: 과거 차트·표 등 컴포넌트 원본 데이터까지 반환 → 재조회 없이 재활용 가능 (요약·재전송 시 권장)
- 현재 대화부터 우선 매칭. limit 기본 5.`,
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '검색할 키워드/문장 (의미 기반 매칭)' },
            limit: { type: 'integer', description: '반환할 최대 결과 수 (기본 5)' },
            includeBlocks: { type: 'boolean', description: '매칭 메시지의 원본 blocks(component/html props 포함) 반환. 과거 차트·표 데이터를 재활용할 때 true. 기본 false (텍스트 프리뷰만).' },
          },
        },
      },
      {
        name: 'search_media',
        description: `갤러리 이미지 검색 — prompt·파일명·모델 단어 매칭. AI 생성·사용자 업로드 모두.
사용 시점:
- "전에 만든 그 차트 이미지", "삼성 이미지 가져와줘" 같이 갤러리에서 특정 이미지 찾을 때.
- 이미지 재사용 — 새로 생성하지 않고 기존 자산 활용 (비용 절감).
- 페이지 만들 때 갤러리 자산 인용 ("배경에 우주 이미지 박아줘" → search_media → render_image).

대화 흐름 안에서 이미지 찾기 (이전 turn 의 이미지) 는 search_history 사용 — search_media 는 갤러리 전체 검색.

scope='all' 기본. source: 'ai-generated' (image_gen 결과) / 'upload' (사용자 첨부 저장) 필터.`,
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '검색어 — prompt·filenameHint·model 단어 매칭. 한국어/영어 OK' },
            scope: { type: 'string', enum: ['user', 'system', 'all'], description: 'user(AI 생성·업로드 기본) / system(Firebat 내부) / all. 기본 all' },
            source: { type: 'string', enum: ['ai-generated', 'upload'], description: '출처 필터 — 미지정 시 모두' },
            limit: { type: 'integer', description: '최대 결과 수 (기본 10, 최대 50)' },
          },
        },
      },
      {
        name: 'search_components',
        description: 'UI 컴포넌트 카탈로그 벡터 검색. 표·차트·리스트·카드·카운트다운 등 정형화된 시각화가 필요할 때 호출 → 매칭되는 컴포넌트들의 name·description·propsSchema 반환. 이후 render(name, props) 로 실제 렌더링. render_alert/render_callout은 직접 호출(검색 불필요).',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '원하는 시각화·표현 요구 (예: "주식 차트", "비교 표", "카운트다운 타이머")' },
            limit: { type: 'integer', description: '반환할 최대 컴포넌트 수 (기본 5)' },
          },
        },
      },
      {
        name: 'render',
        description: 'search_components 로 찾은 컴포넌트를 실제 렌더링. name은 search_components 결과의 컴포넌트 이름, props는 해당 컴포넌트의 propsSchema 를 준수. 알 수 없는 name은 에러.',
        parameters: {
          type: 'object',
          required: ['name', 'props'],
          properties: {
            name: { type: 'string', description: '컴포넌트 이름 (예: "stock_chart", "table"). search_components 결과의 name 필드 사용' },
            props: { type: 'object', additionalProperties: true, description: '컴포넌트 propsSchema 에 맞는 인자 객체' },
          },
        },
      },
    ];
  }

  /**
   * 사용자 쿼리 기반 도구 선별 (벡터 검색) — Gemini/Vertex 전용
   * GPT는 hosted MCP + tool_search가 자체 처리, Claude는 hosted MCP라 적용 효과 없음
   *
   * @param allTools 전체 도구 목록
   * @param userQuery 현재 사용자 메시지
   * @param modelId 선택된 모델 ID
   * @param sessionUsedToolNames 같은 세션에서 이미 호출된 도구 (멀티턴 드랍 방지)
   */

  /** AI 가 호출한 identifier → 실제 dispatch target 해석.
   *  매칭 우선순위: 정확한 이름 → snake/kebab 변형 → sysmod_ 접두사 / full path → null
   *  - MCP 서버 명 매칭: { kind:'mcp', server }
   *  - system/user modules 폴더 명 매칭: { kind:'execute', path }
   *  AI 가 server='kakao_talk' / path='kakao-talk' / sysmod_kiwoom 등 다양하게 호출해도 자동 분기. */
  async resolveCallTarget(identifier: string): Promise<{ kind: 'mcp'; server: string } | { kind: 'execute'; path: string } | null> {
    if (!identifier) return null;
    const lookup = (id: string, map: Map<string, { kind: 'mcp'; server: string } | { kind: 'execute'; path: string }>) =>
      map.get(id) ?? map.get(id.replace(/_/g, '-')) ?? map.get(id.replace(/-/g, '_'));
    if (this._callTargetCache && (Date.now() - this._callTargetCache.ts) < AiManager.CALL_TARGET_TTL) {
      const hit = lookup(identifier, this._callTargetCache.map);
      if (hit !== undefined) return hit;
    }
    const map = new Map<string, { kind: 'mcp'; server: string } | { kind: 'execute'; path: string }>();
    // 1) 외부 MCP 서버
    try {
      const mcpServers = this.core.listMcpServers();
      if (Array.isArray(mcpServers)) {
        for (const s of mcpServers) {
          if (!s?.name) continue;
          const target = { kind: 'mcp' as const, server: s.name };
          map.set(s.name, target);
          map.set(s.name.replace(/-/g, '_'), target);
          map.set(s.name.replace(/_/g, '-'), target);
        }
      }
    } catch { /* MCP 미설정 무시 */ }
    // 2) system + user modules
    for (const dir of ['system/modules', 'user/modules']) {
      try {
        const ls = await this.core.listDir(dir);
        if (!ls.success || !ls.data) continue;
        for (const e of ls.data.filter(x => x.isDirectory)) {
          const path = `${dir}/${e.name}/index.mjs`;
          const target = { kind: 'execute' as const, path };
          map.set(e.name, target);
          map.set(e.name.replace(/-/g, '_'), target);
          map.set(e.name.replace(/_/g, '-'), target);
          map.set(`sysmod_${e.name}`, target);
          map.set(`sysmod_${e.name.replace(/-/g, '_')}`, target);
          map.set(path, target);
        }
      } catch { /* 폴더 없음 무시 */ }
    }
    this._callTargetCache = { map, ts: Date.now() };
    return lookup(identifier, map) ?? null;
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
