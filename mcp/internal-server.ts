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

  // ── UI 렌더링 ───────────────────────────────────────────────────────────
  server.tool(
    'render_component',
    '채팅에 인라인 컴포넌트 렌더링. type enum: StockChart, Table, Alert, Card, Grid, Badge, Progress, Header, Text, List, Divider, Countdown, Chart. props는 컴포넌트별 다름.',
    {
      type: z.enum([
        'Header','Text','Image','Divider','Table','Card','Grid','Progress','Badge','Alert','List','Countdown','Chart','StockChart',
      ]).describe('컴포넌트 타입'),
      props: z.record(z.string(), z.any()).optional().describe('컴포넌트 props'),
    },
    async ({ type, props }) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, component: type, props: props ?? {} }) }],
    }),
  );

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
    '사용자/시스템 모듈 실행. path=경로, inputData=입력 JSON',
    { path: z.string(), inputData: z.record(z.string(), z.any()).optional() },
    async ({ path, inputData }) => {
      const r = await core.sandboxExecute(path, inputData ?? {});
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

  // ── 시스템 모듈 동적 노출 ─────────────────────────────────────────────
  // (시스템 모듈은 config.json 기반으로 런타임에 등록됨 — 추후 addSysmodTools(server) 확장)

  return server;
}
