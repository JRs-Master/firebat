/**
 * Firebat Internal MCP Server — LLM 통신용
 *
 * OpenAI Responses API (hosted MCP), Claude API 등 외부 LLM이
 * Firebat의 전체 도구 세트에 접근할 수 있도록 Core 메서드를 MCP 도구로 노출한다.
 *
 * 외부용(mcp/server.ts)과 별도 엔드포인트(/api/mcp-internal)로 분리.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FirebatCore } from '../core/index';

export function createInternalMcpServer(core: FirebatCore): McpServer {
  const server = new McpServer({ name: 'firebat-internal', version: '0.1.0' });

  // ── UI 렌더링 — 14개 render_* 도구 ────────────────────────────────────
  const makeRender = (name: string, component: string, schema: Record<string, z.ZodTypeAny>, desc: string) => {
    server.tool(name, desc, schema, async (args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, component, props: args }) }],
    }));
  };

  makeRender('render_stock_chart', 'StockChart', {
    symbol: z.string(), title: z.string(), data: z.array(z.any()),
    indicators: z.array(z.enum(['MA5','MA10','MA20','MA60'])).optional(),
    buyPoints: z.array(z.any()).optional(), sellPoints: z.array(z.any()).optional(),
  }, '주식 시세 차트 (일봉/분봉). data는 OHLCV 배열.');
  makeRender('render_table', 'Table', {
    headers: z.array(z.string()), rows: z.array(z.array(z.string())),
  }, '표. 수치 3개 이상 시 필수.');
  makeRender('render_alert', 'Alert', {
    message: z.string(),
    type: z.enum(['info','warn','error','success']),
    title: z.string().optional(),
  }, '알림/주의/경고 박스.');
  makeRender('render_badge', 'Badge', { text: z.string(), color: z.string() }, '작은 태그/뱃지.');
  makeRender('render_progress', 'Progress', {
    value: z.number(), max: z.number().optional(), label: z.string().optional(), color: z.string().optional(),
  }, '진행률 바.');
  makeRender('render_header', 'Header', { text: z.string(), level: z.number().optional() }, '섹션 제목.');
  makeRender('render_text', 'Text', { content: z.string() }, '본문 텍스트 블록.');
  makeRender('render_list', 'List', { items: z.array(z.string()), ordered: z.boolean().optional() }, '목록.');
  makeRender('render_divider', 'Divider', {}, '섹션 구분선.');
  makeRender('render_countdown', 'Countdown', { targetDate: z.string(), label: z.string().optional() }, '카운트다운.');
  makeRender('render_chart', 'Chart', {
    chartType: z.enum(['bar','line','pie','doughnut']),
    labels: z.array(z.string()), data: z.array(z.number()), title: z.string().optional(),
  }, '간단 차트 (막대/선/원).');
  makeRender('render_image', 'Image', {
    src: z.string(), alt: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
  }, '이미지.');
  makeRender('render_card', 'Card', { children: z.array(z.any()) }, '카드.');
  makeRender('render_grid', 'Grid', { columns: z.number(), children: z.array(z.any()) }, '그리드.');

  server.tool(
    'render_html',
    '자유 HTML 인라인 렌더링 (iframe). 정형 UI는 render_component 우선. CDN 필요 시 libraries로 선택.',
    {
      html: z.string().describe('HTML 본문 또는 완전한 HTML'),
      height: z.string().optional().describe('iframe 높이 (기본 400px)'),
      libraries: z.array(z.enum(['d3','mermaid','leaflet','threejs','animejs','tailwindcss','katex','hljs','marked','cytoscape','mathjax','p5','lottie','datatables','swiper'])).optional(),
    },
    async ({ html, height }) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, htmlContent: html, htmlHeight: height ?? '400px' }) }],
    }),
  );

  server.tool(
    'suggest',
    '사용자에게 선택지 제시. string=버튼, {type:"input",label,placeholder}=입력, {type:"toggle",label,options}=다중 선택.',
    { suggestions: z.array(z.any()).describe('선택지 배열') },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, displayed: true }) }],
    }),
  );

  // ── 페이지 ──────────────────────────────────────────────────────────────
  server.tool(
    'list_pages',
    '등록된 페이지 목록 조회',
    {},
    async () => {
      const r = await core.listPages();
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? r.data : { error: r.error }) }] };
    },
  );

  server.tool(
    'get_page',
    '페이지 PageSpec 조회',
    { slug: z.string() },
    async ({ slug }) => {
      const r = await core.getPage(slug);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? r.data : { error: r.error }) }] };
    },
  );

  server.tool(
    'save_page',
    '페이지 저장 (upsert). spec은 PageSpec JSON 문자열.',
    { slug: z.string(), spec: z.string() },
    async ({ slug, spec }) => {
      const r = await core.savePage(slug, spec);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, slug, url: `/${slug}` } : { error: r.error }) }] };
    },
  );

  server.tool(
    'delete_page',
    '페이지 삭제',
    { slug: z.string() },
    async ({ slug }) => {
      const r = await core.deletePage(slug);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true } : { error: r.error }) }] };
    },
  );

  // ── 파일 ────────────────────────────────────────────────────────────────
  server.tool(
    'read_file',
    '파일 읽기 (user/, docs/, system/modules/ 영역)',
    { path: z.string() },
    async ({ path }) => {
      const r = await core.readFile(path);
      return { content: [{ type: 'text', text: r.success ? r.data! : `실패: ${r.error}` }] };
    },
  );

  server.tool(
    'write_file',
    '파일 쓰기 (user/ 영역만). 부모 디렉토리 자동 생성.',
    { path: z.string(), content: z.string() },
    async ({ path, content }) => {
      const r = await core.writeFile(path, content);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true } : { error: r.error }) }] };
    },
  );

  server.tool(
    'delete_file',
    '파일/디렉토리 삭제 (user/ 영역만)',
    { path: z.string() },
    async ({ path }) => {
      const r = await core.deleteFile(path);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true } : { error: r.error }) }] };
    },
  );

  server.tool(
    'list_dir',
    '디렉토리 내 항목 목록',
    { path: z.string() },
    async ({ path }) => {
      const r = await core.getFileTree(path);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
  );

  // ── 실행 ────────────────────────────────────────────────────────────────
  server.tool(
    'execute',
    '⚠️ 시스템 모듈은 이 도구 대신 **sysmod_*** (예: sysmod_kiwoom) 를 사용하라. 이 도구는 user/modules/ 사용자 정의 모듈 실행 전용. inputData 필수 (빈 객체 금지).',
    {
      path: z.string().describe('user/modules/*/index.* 경로'),
      inputData: z.record(z.string(), z.any()).describe('모듈 입력 JSON (반드시 실제 값 포함)'),
    },
    async ({ path, inputData }) => {
      if (!inputData || Object.keys(inputData).length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'inputData 빈 객체 금지. 모듈 입력 필드를 실제 값으로 채워라. 시스템 모듈이면 sysmod_* 사용.' }) }] };
      }
      const r = await core.sandboxExecute(path, inputData);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, data: r.data } : { error: r.error }) }] };
    },
  );

  server.tool(
    'network_request',
    'HTTP 요청',
    {
      url: z.string(),
      method: z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    },
    async ({ url, method, headers, body }) => {
      const r = await core.networkFetch(url, { method: method as 'GET', headers, body });
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, data: r.data } : { error: r.error }) }] };
    },
  );

  // ── 스케줄링 ────────────────────────────────────────────────────────────
  server.tool(
    'schedule_task',
    '예약 작업 등록. cronTime(반복), runAt(1회, ISO 8601), delaySec(N초 후) 중 하나. pipeline 배열로 복합 작업.',
    {
      targetPath: z.string().optional(),
      cronTime: z.string().optional(),
      runAt: z.string().optional(),
      delaySec: z.number().optional(),
      startAt: z.string().optional(),
      endAt: z.string().optional(),
      inputData: z.record(z.string(), z.any()).optional(),
      pipeline: z.array(z.any()).optional(),
      title: z.string().optional(),
      oneShot: z.boolean().optional().describe('첫 성공 시 자동 취소'),
    },
    async (args) => {
      const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const r = await core.scheduleCronJob(jobId, args.targetPath ?? '', {
        cronTime: args.cronTime,
        runAt: args.runAt,
        delaySec: args.delaySec,
        startAt: args.startAt,
        endAt: args.endAt,
        inputData: args.inputData,
        pipeline: args.pipeline as import('../core/ports').PipelineStep[] | undefined,
        title: args.title,
        oneShot: args.oneShot,
      });
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, jobId } : { error: r.error }) }] };
    },
  );

  server.tool(
    'cancel_task',
    '예약 작업 취소',
    { jobId: z.string() },
    async ({ jobId }) => {
      const r = await core.cancelCronJob(jobId);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true } : { error: r.error }) }] };
    },
  );

  server.tool(
    'list_tasks',
    '등록된 크론 잡 목록',
    {},
    async () => {
      const jobs = core.listCronJobs();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, cronJobs: jobs }) }] };
    },
  );

  server.tool(
    'run_task',
    '파이프라인 즉시 실행 (EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION 5종)',
    { pipeline: z.array(z.any()).describe('파이프라인 단계 배열') },
    async ({ pipeline }) => {
      const r = await core.runTask(pipeline as import('../core/ports').PipelineStep[]);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, data: r.data } : { error: r.error }) }] };
    },
  );

  // ── 시크릿/외부 MCP ───────────────────────────────────────────────────
  server.tool(
    'request_secret',
    '사용자에게 API 키 입력 요청. name은 kebab-case.',
    { name: z.string(), prompt: z.string().optional(), helpUrl: z.string().optional() },
    async ({ name, prompt, helpUrl }) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, requestSecret: true, name, prompt, helpUrl }) }],
    }),
  );

  server.tool(
    'mcp_call',
    '외부 MCP 서버 도구 호출',
    {
      server: z.string().describe('MCP 서버 이름'),
      tool: z.string().describe('도구 이름'),
      arguments: z.record(z.string(), z.any()).optional(),
    },
    async ({ server: srv, tool, arguments: args }) => {
      const r = await core.callMcpTool(srv, tool, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, data: r.data } : { error: r.error }) }] };
    },
  );

  // ── 시스템 모듈 동적 노출 (config.json 기반) ─────────────────────────
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const modulesDir = path.join(process.cwd(), 'system/modules');
    if (fs.existsSync(modulesDir)) {
      const modules = fs.readdirSync(modulesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const modName of modules) {
        const configPath = path.join(modulesDir, modName, 'config.json');
        if (!fs.existsSync(configPath)) continue;
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const entryFiles = ['index.mjs', 'index.js', 'main.py'];
          let entryPath: string | null = null;
          for (const ef of entryFiles) {
            const p = path.join(modulesDir, modName, ef);
            if (fs.existsSync(p)) { entryPath = `system/modules/${modName}/${ef}`; break; }
          }
          if (!entryPath) continue;

          const toolName = `sysmod_${modName.replace(/-/g, '_')}`;
          // config.json의 input.properties를 zod shape으로 평탄화 (AI가 args wrapper 없이 직접 필드 전달)
          const inputProps: Record<string, { description?: string; type?: string }> = config.input?.properties ?? {};
          const requiredList: string[] = config.input?.required ?? [];
          const zodShape: Record<string, z.ZodTypeAny> = {};
          for (const [key, prop] of Object.entries(inputProps)) {
            const desc = prop.description || '';
            zodShape[key] = requiredList.includes(key)
              ? z.any().describe(desc)
              : z.any().optional().describe(desc);
          }

          server.tool(
            toolName,
            config.description || `시스템 모듈: ${modName}`,
            zodShape,
            async (args: Record<string, unknown>) => {
              const execPath = entryPath!;
              const r = await core.sandboxExecute(execPath, args ?? {});
              if (!r.success) return { content: [{ type: 'text', text: JSON.stringify({ error: r.error }) }] };
              if (r.data?.success === false) return { content: [{ type: 'text', text: JSON.stringify(r.data) }] };
              return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: r.data }) }] };
            },
          );
        } catch { /* 해당 모듈 건너뜀 */ }
      }
    }
  } catch { /* 시스템 모듈 스캔 실패 무시 */ }

  return server;
}
