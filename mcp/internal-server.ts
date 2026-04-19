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
    labels: z.array(z.string()),
    data: z.array(z.number()),
    title: z.string().optional(),
    subtitle: z.string().optional().describe('부제목 (데이터 출처·기간 등)'),
    unit: z.string().optional().describe('값 단위 (예: "원", "%", "건")'),
    color: z.enum(['blue','green','red','purple','orange','teal','pink','yellow','slate']).optional().describe('bar/line 단일 색상 (기본 blue)'),
    palette: z.enum(['default','pastel','mono-blue','mono-green','red-green','earth']).optional().describe('pie/doughnut 색상 팔레트'),
    showValues: z.boolean().optional().describe('bar 값 inline 표시 (기본 true)'),
  }, '간단 차트 (막대/선/원). 다중 시리즈·애노테이션 필요시 render_html + echarts 사용.');

  makeRender('render_metric', 'Metric', {
    label: z.string().describe('지표명 (예: "현재가", "PER")'),
    value: z.union([z.string(), z.number()]).describe('대표 수치'),
    unit: z.string().optional().describe('단위 (원, %, 배 등)'),
    delta: z.union([z.string(), z.number()]).optional().describe('증감치 (예: -1500, "-0.69%")'),
    deltaType: z.enum(['up','down','neutral']).optional().describe('up=빨강, down=파랑, neutral=회색'),
    subLabel: z.string().optional().describe('보조 설명 (예: "전일 대비")'),
    icon: z.string().optional().describe('이모지 아이콘 (예: "📈")'),
  }, '단일 지표 카드. 라벨+값+증감. Grid 안에 여러 개 배치하면 KPI 대시보드.');

  makeRender('render_timeline', 'Timeline', {
    items: z.array(z.object({
      date: z.string(),
      title: z.string(),
      description: z.string().optional(),
      type: z.enum(['default','success','warning','error']).optional(),
    })),
  }, '연대기 / 이벤트 타임라인. 일정·이력·단계별 진행 표시.');

  makeRender('render_compare', 'Compare', {
    title: z.string().optional(),
    left: z.object({ label: z.string(), items: z.array(z.object({ key: z.string(), value: z.string() })) }),
    right: z.object({ label: z.string(), items: z.array(z.object({ key: z.string(), value: z.string() })) }),
  }, 'A vs B 대조 표. 두 대상 항목별 비교.');

  makeRender('render_key_value', 'KeyValue', {
    title: z.string().optional(),
    items: z.array(z.object({
      key: z.string(),
      value: z.union([z.string(), z.number()]),
      highlight: z.boolean().optional(),
    })),
    columns: z.number().optional().describe('1/2/3 (기본 2)'),
  }, '라벨:값 구조적 나열. 종목 정보·제품 스펙 등.');

  makeRender('render_status_badge', 'StatusBadge', {
    items: z.array(z.object({
      label: z.string(),
      status: z.enum(['positive','negative','neutral','warning','info']),
    })),
  }, '의미 기반 상태 뱃지 세트. 예: "정배열"(positive), "과열"(warning), "중립"(neutral).');
  makeRender('render_image', 'Image', {
    src: z.string(), alt: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
  }, '이미지.');
  makeRender('render_card', 'Card', { children: z.array(z.any()) }, '카드.');
  makeRender('render_grid', 'Grid', { columns: z.number(), children: z.array(z.any()) }, '그리드.');

  const CDN_MAP: Record<string, string> = {
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

  server.tool(
    'render_html',
    '자유 HTML 인라인 렌더링 (iframe). 정형 UI는 render_component 우선. CDN 필요 시 libraries 배열에 명시 — 자동으로 <head>에 script/link 태그 삽입됨.',
    {
      html: z.string().describe('HTML 본문 또는 완전한 HTML'),
      height: z.string().optional().describe('iframe 높이 (기본 400px)'),
      libraries: z.array(z.enum(['d3','mermaid','leaflet','threejs','animejs','tailwindcss','katex','hljs','marked','cytoscape','mathjax','p5','lottie','datatables','swiper','echarts'])).optional().describe('사용할 CDN 라이브러리. 선택 시 script/link 태그가 HTML에 자동 주입.'),
    },
    async ({ html, height, libraries }) => {
      // CDN 라이브러리 자동 삽입 (API 모드 executeToolCall 과 동일 로직)
      let finalHtml = html;
      if (libraries && libraries.length > 0) {
        const cdnTags = libraries.map(l => CDN_MAP[l]).filter(Boolean).join('\n');
        if (cdnTags) {
          if (finalHtml.includes('</head>')) {
            finalHtml = finalHtml.replace('</head>', `${cdnTags}\n</head>`);
          } else if (finalHtml.includes('<body')) {
            finalHtml = finalHtml.replace(/<body/i, `${cdnTags}\n<body`);
          } else {
            finalHtml = `${cdnTags}\n${finalHtml}`;
          }
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, htmlContent: finalHtml, htmlHeight: height ?? '400px' }) }],
      };
    },
  );

  server.tool(
    'suggest',
    '사용자에게 선택지 제시. string=버튼, {type:"input",label,placeholder}=입력, {type:"toggle",label,options}=다중 선택.',
    { suggestions: z.array(z.any()).describe('선택지 배열') },
    async ({ suggestions }) => ({
      // suggestions 를 tool_result 에 포함해서 CLI 핸들러가 추출 → Firebat UI 로 전달
      content: [{ type: 'text', text: JSON.stringify({ success: true, displayed: true, suggestions }) }],
    }),
  );

  // ── 페이지 ──────────────────────────────────────────────────────────────
  server.tool(
    'list_pages',
    `등록된 모든 페이지 메타데이터 목록.
반환: [{slug, title, status, project?, visibility?, updatedAt?}]
사용 시점: 페이지 전체 현황 확인, 특정 slug 존재 여부 파악.`,
    {},
    async () => {
      const r = await core.listPages();
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? r.data : { error: r.error }) }] };
    },
  );

  server.tool(
    'get_page',
    `특정 slug 페이지의 전체 PageSpec JSON 조회.
반환: {slug, head?, body: [{type, props}], project?, _visibility?}
사용 시점: 기존 페이지 수정 전 구조 확인, 템플릿 참고.`,
    { slug: z.string().describe('페이지 slug (kebab-case, 한글 허용)') },
    async ({ slug }) => {
      const r = await core.getPage(slug);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? r.data : { error: r.error }) }] };
    },
  );

  server.tool(
    'save_page',
    `페이지 저장 (upsert). spec은 **반드시 아래 PageSpec JSON** 문자열:
{
  "slug": "kebab-case",
  "status": "published",
  "project": "project-name",
  "head": {"title": "...", "description": "...", "keywords": [...]},
  "body": [{"type": "Html", "props": {"content": "<전체 HTML>"}}]
}
규칙:
- body는 컴포넌트 배열. Html 컴포넌트가 주. props.content에 HTML+CSS+JS.
- {title, html} 같은 자체 형식 절대 금지.
- Html content는 iframe sandbox(allow-scripts)에서 실행.`,
    {
      slug: z.string().describe('페이지 slug'),
      spec: z.string().describe('PageSpec JSON 문자열 전체'),
    },
    async ({ slug, spec }) => {
      // 승인 대기 — 기존 페이지 덮어쓰기 방지 + 의도 확인
      const { createPending } = await import('../lib/pending-tools');
      const planId = createPending('save_page', { slug, spec }, `페이지 저장: /${slug}`);
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, pending: true, planId, summary: `페이지 저장: /${slug}`,
        message: '사용자 승인 대기 중입니다. Firebat UI 에서 승인 버튼 클릭 시 실제 저장됩니다.',
      }) }] };
    },
  );

  server.tool(
    'delete_page',
    `페이지 영구 삭제 (사용자 확인 후에만).
주의: 복구 불가. 프로젝트 전체 삭제는 별도 도구.`,
    { slug: z.string().describe('삭제할 페이지 slug') },
    async ({ slug }) => {
      const { createPending } = await import('../lib/pending-tools');
      const planId = createPending('delete_page', { slug }, `페이지 삭제: /${slug}`);
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, pending: true, planId, summary: `페이지 삭제: /${slug}`,
        message: '사용자 승인 대기 중입니다.',
      }) }] };
    },
  );

  // ── 파일 ────────────────────────────────────────────────────────────────
  server.tool(
    'read_file',
    `파일 텍스트 내용 읽기.
허용: user/, docs/, system/modules/
금지: core/, infra/, app/, data/
사용 시점: 기존 코드 검토, 문서 참조, 디버깅.`,
    { path: z.string().describe('파일 경로. 예: user/modules/bmi/main.py') },
    async ({ path }) => {
      const r = await core.readFile(path);
      return { content: [{ type: 'text', text: r.success ? r.data! : `실패: ${r.error}` }] };
    },
  );

  server.tool(
    'write_file',
    `파일 쓰기 (user/ 영역만). 부모 디렉토리 자동 생성.
**모듈 작성 시 필수 준수:**
- 경로: user/modules/{모듈명}/main.py 또는 index.mjs
- config.json 필수: {"name", "type":"utility", "runtime":"python"|"node", "project":"모듈명", "packages":[], "secrets":[], "input":{}, "output":{}}
- I/O: stdin으로 {correlationId, data:{...}} JSON → stdout 마지막 줄 {"success":true,"data":{...}}
- Python: True/False/None (JSON의 true/false/null 아님)
- 시크릿은 os.environ["KEY"] (Python) / process.env["KEY"] (Node)
- 프로젝트명 = 모듈 폴더명 = 페이지 slug 통일 권장`,
    {
      path: z.string().describe('파일 경로. 예: user/modules/bmi/main.py, user/modules/bmi/config.json'),
      content: z.string().describe('파일 내용 전체'),
    },
    async ({ path, content }) => {
      const r = await core.writeFile(path, content);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true } : { error: r.error }) }] };
    },
  );

  server.tool(
    'delete_file',
    `파일/디렉토리 영구 삭제 (user/ 영역만). 복구 불가.
디렉토리 삭제 시 하위 전체 삭제.`,
    { path: z.string().describe('삭제 경로') },
    async ({ path }) => {
      const { createPending } = await import('../lib/pending-tools');
      const planId = createPending('delete_file', { path }, `파일 삭제: ${path}`);
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, pending: true, planId, summary: `파일 삭제: ${path}`,
        message: '사용자 승인 대기 중입니다.',
      }) }] };
    },
  );

  server.tool(
    'list_dir',
    `디렉토리 항목 목록.
반환: [{name, isDirectory}]
사용 시점: 프로젝트 구조 파악, 파일 존재 확인.`,
    { path: z.string().describe('디렉토리 경로. 예: user/modules') },
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
    `가벼운 HTTP 요청 (JSON/HTML 응답 반환).
반환: {status, headers, data}
사용 시점: 공개 API 호출, 간단한 웹 fetch.
시스템 모듈 우선: 특정 서비스(주식/네이버/카카오 등)는 sysmod_* 도구가 더 적합.`,
    {
      url: z.string().describe('전체 URL (https://...)'),
      method: z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']).optional().describe('기본 GET'),
      headers: z.record(z.string(), z.string()).optional().describe('요청 헤더'),
      body: z.string().optional().describe('POST/PUT 본문. JSON이면 Content-Type: application/json 헤더 추가'),
    },
    async ({ url, method, headers, body }) => {
      const r = await core.networkFetch(url, { method: method as 'GET', headers, body });
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, data: r.data } : { error: r.error }) }] };
    },
  );

  // ── 스케줄링 ────────────────────────────────────────────────────────────
  server.tool(
    'schedule_task',
    `예약/반복 작업 등록. 3가지 모드 중 하나 선택:
1) cronTime: "분 시 일 월 요일" (예: "0 9 * * 1-5" = 평일 9시) — 영구 반복
2) runAt: ISO 8601 (예: "2026-04-18T15:00:00+09:00") — 특정 시각 1회
3) delaySec: N초 후 1회

targetPath + inputData: 단일 모듈 실행.
pipeline: 복합 작업 (EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION 5가지 스텝 조합).
oneShot: 첫 성공 시 자동 취소 (가격 알림 등 조건부 1회 패턴).
startAt/endAt: cronTime의 유효 기간 (만료 시 자동 해제).

예: {cronTime:"*/5 9-15 * * 1-5", pipeline:[{type:"EXECUTE",path:"system/modules/kiwoom/index.mjs",inputData:{action:"price",symbol:"005930"}},{type:"CONDITION",field:"$prev.price",op:">=",value:217000},{type:"EXECUTE",path:"system/modules/kakao-talk/index.mjs",inputData:{action:"send-me",text:"삼성전자 217000원 도달"}}], oneShot:true}

주의: 시각이 지났으면 사용자에게 바로 실행할지 확인. 자의적 조정 금지.`,
    {
      targetPath: z.string().optional().describe('단일 실행 시 모듈 경로 (pipeline 쓰면 불필요)'),
      cronTime: z.string().optional().describe('크론 표현식'),
      runAt: z.string().optional().describe('ISO 8601 시각'),
      delaySec: z.number().optional().describe('N초 후'),
      startAt: z.string().optional().describe('반복 시작 시각 (ISO 8601)'),
      endAt: z.string().optional().describe('반복 종료 시각 (ISO 8601)'),
      inputData: z.record(z.string(), z.any()).optional().describe('단일 실행 입력'),
      pipeline: z.array(z.any()).optional().describe('파이프라인 스텝 배열'),
      title: z.string().optional().describe('잡 제목 (UI/알림용)'),
      oneShot: z.boolean().optional().describe('첫 성공 시 자동 취소'),
    },
    async (args) => {
      // 승인 대기 — 실제 등록은 UI 승인 후. 한 번 Pending 에 올려놓고 AI 에겐 대기 중임을 알림.
      // cli-claude-code.ts 핸들러가 tool_result 를 파싱해 Firebat UI pendingActions 로 전달.
      const { createPending } = await import('../lib/pending-tools');
      const title = args.title || '예약 등록';
      const when = args.cronTime ? `cron: ${args.cronTime}`
        : args.runAt ? `1회: ${args.runAt}`
        : args.delaySec != null ? `${args.delaySec}초 후`
        : '시각 미지정';
      const summary = `${title} (${when})`;
      const planId = createPending('schedule_task', args as Record<string, unknown>, summary);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true, pending: true, planId, summary,
          message: '사용자 승인 대기 중입니다. Firebat UI 에서 승인 버튼 클릭 시 실제 등록됩니다.',
        }) }],
      };
    },
  );

  server.tool(
    'cancel_task',
    `예약/반복 작업 영구 해제. 실행 중이면 다음 발화 전 중단.
사용자가 명시적으로 해제 요청한 경우만. 복구 불가.`,
    { jobId: z.string().describe('해제할 잡 ID (list_tasks로 확인)') },
    async ({ jobId }) => {
      const r = await core.cancelCronJob(jobId);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true } : { error: r.error }) }] };
    },
  );

  server.tool(
    'list_tasks',
    `등록된 예약/반복 작업 전체 목록.
반환: [{jobId, targetPath, title?, mode:'cron'|'once'|'delay', cronTime?, runAt?, delaySec?, inputData?, pipeline?, createdAt}]`,
    {},
    async () => {
      const jobs = core.listCronJobs();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, cronJobs: jobs }) }] };
    },
  );

  server.tool(
    'run_task',
    `파이프라인 즉시 실행 (예약 아님). 5가지 스텝 타입을 순차 실행:
- EXECUTE: {type:"EXECUTE", path:"system/modules/xxx/index.mjs", inputData:{...}}
- MCP_CALL: {type:"MCP_CALL", server:"gmail", tool:"send_email", arguments:{...}} — 외부 MCP 서버
- NETWORK_REQUEST: {type:"NETWORK_REQUEST", url:"https://...", method:"GET"}
- LLM_TRANSFORM: {type:"LLM_TRANSFORM", instruction:"이 데이터를 요약해줘"}
- CONDITION: {type:"CONDITION", field:"$prev.price", op:">=", value:1000} — false면 중단

$prev 치환: 이전 단계 결과에서 값 가져오기. 예: "$prev.url", "$prev.text".
inputMap: {"url":"$prev.url"} 형태로 매핑 가능.
사용자에게 결과 보여줄 때는 마지막을 LLM_TRANSFORM으로 끝내라.`,
    { pipeline: z.array(z.any()).describe('파이프라인 스텝 배열') },
    async ({ pipeline }) => {
      const r = await core.runTask(pipeline as import('../core/ports').PipelineStep[]);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, data: r.data } : { error: r.error }) }] };
    },
  );

  // ── 시크릿/외부 MCP ───────────────────────────────────────────────────
  server.tool(
    'request_secret',
    `사용자에게 API 키/시크릿 입력 요청. 프론트엔드에 입력창 표시, 사용자가 입력하면 Vault에 저장.
사용 시점: 모듈 실행에 필요한 시크릿이 Vault에 없을 때 (모듈이 'secret missing' 에러 반환 시).
중요: AI는 시크릿 값을 절대 모름. 입력은 사용자↔Vault 직접. AI는 요청만.
name은 kebab-case (KIWOOM_APP_KEY → kiwoom-app-key). 모듈 config.json의 secrets 배열 이름과 일치.`,
    {
      name: z.string().describe('시크릿 키 이름 (kebab-case). 예: "openai-api-key"'),
      prompt: z.string().optional().describe('사용자에게 보여줄 안내 메시지'),
      helpUrl: z.string().optional().describe('키 발급 안내 URL (예: OpenAI 키 발급 페이지)'),
    },
    async ({ name, prompt, helpUrl }) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, requestSecret: true, name, prompt, helpUrl }) }],
    }),
  );

  server.tool(
    'mcp_call',
    `외부 MCP 서버(Gmail/Slack/커스텀 등) 도구 호출.
Firebat 내장 기능이 아닌 외부 서비스 연동 전용. 시스템 모듈은 sysmod_* 사용, 내부 기능은 이 MCP의 다른 도구 사용.
arguments는 대상 도구의 inputSchema에 맞춰 작성.`,
    {
      server: z.string().describe('외부 MCP 서버 이름'),
      tool: z.string().describe('해당 서버의 도구 이름'),
      arguments: z.record(z.string(), z.any()).optional().describe('도구 inputSchema 준수한 인자'),
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
          const inputProps: Record<string, { description?: string; type?: string; enum?: unknown[] }> = config.input?.properties ?? {};
          const requiredList: string[] = config.input?.required ?? [];
          // JSON Schema 타입 → zod 변환 (required는 최소값 강제로 빈 값 차단)
          const toZodType = (prop: { type?: string; enum?: unknown[] }, isRequired: boolean): z.ZodTypeAny => {
            const t = prop.type;
            let base: z.ZodTypeAny;
            if (t === 'string') {
              base = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : (isRequired ? z.string().min(1) : z.string());
            } else if (t === 'number' || t === 'integer') {
              base = z.number();
            } else if (t === 'boolean') {
              base = z.boolean();
            } else if (t === 'array') {
              base = z.array(z.any());
            } else if (t === 'object') {
              base = z.record(z.string(), z.any());
            } else {
              base = z.any();
            }
            return base;
          };
          const zodShape: Record<string, z.ZodTypeAny> = {};
          for (const [key, prop] of Object.entries(inputProps)) {
            const desc = prop.description || '';
            const isRequired = requiredList.includes(key);
            const zt = toZodType(prop, isRequired).describe(desc);
            zodShape[key] = isRequired ? zt : zt.optional();
          }

          // 상세 설명 (capability, 입력 필드 enum/타입, 반환 필드, 필요 시크릿 등)
          const capHint = config.capability ? `\ncapability: ${config.capability} (${config.providerType || '?'})` : '';
          const inputHint = Object.keys(inputProps).length > 0
            ? '\n입력 필드: ' + Object.entries(inputProps)
                .map(([k, v]) => `${k}${requiredList.includes(k) ? '*' : ''}: ${v.type || 'any'}${v.enum ? ` (enum: ${(v.enum as unknown[]).slice(0, 8).join('/')}${(v.enum as unknown[]).length > 8 ? '...' : ''})` : ''}${v.description ? ` — ${v.description}` : ''}`)
                .slice(0, 10).join('; ')
            : '';
          const outputHint = config.output?.properties
            ? '\n반환 필드: ' + Object.keys(config.output.properties).slice(0, 8).join(', ')
            : '';
          const secretHint = config.secrets?.length ? `\n필요 시크릿: ${config.secrets.join(', ')} (미설정 시 request_secret 호출)` : '';
          const description = `[시스템 모듈] ${config.description || modName}${capHint}${inputHint}${outputHint}${secretHint}`;

          server.tool(
            toolName,
            description,
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
