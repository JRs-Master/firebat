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
import { IMAGE_GEN_DESCRIPTION } from '../lib/image-gen-prompt';
import { CDN_LIBRARIES } from '../lib/cdn-libraries';

export function createInternalMcpServer(core: FirebatCore): McpServer {
  const server = new McpServer({ name: 'firebat-internal', version: '0.1.0' });

  // ── UI 렌더링 — ToolManager single source ────────────────────────────
  // render_* 도구는 모두 ToolManager 에 등록됨 (AiManager.registerStaticToolsToManager 가
  // strict 2개 + COMPONENTS 자동 등록). 여기선 그 결과를 read 해서 server.tool() 등록만.
  // 새 컴포넌트는 component-registry.ts 만 수정 → 자동 반영.
  // schema 는 z.any() — 실제 검증은 component-registry 의 propsSchema (frontend) single source.
  for (const def of core.listTools({ source: 'render' })) {
    const props = (def.parameters as { properties?: Record<string, { description?: string }> })?.properties || {};
    const required = new Set((def.parameters as { required?: string[] })?.required || []);
    const schema: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(props)) {
      const desc = v.description || '';
      schema[k] = required.has(k) ? z.any().describe(desc) : z.any().optional().describe(desc);
    }
    server.tool(def.name, def.description, schema, async (args: Record<string, unknown>) => {
      const res = await core.executeTool(def.name, args, {});
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    });
  }
  // 더 이상 makeRender 수동 호출 X — 모든 render_* 는 ToolManager 단일 source.
  // CDN 카탈로그는 lib/cdn-libraries.ts 단일 source. 전용 render_* 컴포넌트로 흡수된 라이브러리
  // (leaflet/mermaid/katex/hljs/cytoscape/lottie/swiper) 는 거기서 이미 제외됨 → render_iframe 우회 차단.
  const CDN_MAP = CDN_LIBRARIES;

  server.tool(
    'render_iframe',
    '한 섹션용 iframe 위젯 (sandbox srcDoc) — **마지막 수단**. 다음은 모두 전용 도구 있음 → render_iframe 쓰면 안 됨: 지도(render_map) / 다이어그램(render_diagram, mermaid) / 수식(render_math, KaTeX) / 코드(render_code, hljs) / 슬라이드(render_slideshow) / Lottie 애니메이션(render_lottie) / 네트워크(render_network) / 표·차트·리스트·헤더·텍스트·이미지 (전용 render_*). render_iframe 은 d3 자유 시각화·threejs 3D·p5 스케치·echarts·animejs 같이 전용 도구 없는 케이스만. iframe 안에서는 AdSense 광고·SEO 인덱싱 차단되니 페이지 본문 통째로 만들지 마라. libraries 배열 명시 시 자동으로 <head>에 script/link 태그 삽입됨.',
    {
      html: z.string().describe('HTML 본문 또는 완전한 HTML'),
      height: z.string().optional().describe('iframe 높이 (기본 400px)'),
      libraries: z.array(z.enum(['d3','threejs','animejs','tailwindcss','marked','mathjax','echarts','p5','datatables'])).optional().describe('사용할 CDN 라이브러리. leaflet/mermaid/katex/hljs/swiper/lottie/cytoscape 는 전용 render_* 컴포넌트로 흡수되어 enum 에서 제외됨.'),
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

  server.tool(
    'propose_plan',
    `복합 다단계 작업 **실행 전** 사용자 승인용 플랜 카드. 호출하면 PlanCard 컴포넌트 + "✓실행/⚙수정/✕취소" 버튼이 렌더되고 파이프라인은 멈춘다 (사용자 '실행' 클릭 후 진행).

**사용 시점**: 진짜 복잡 작업에만.
- 도구 호출이 5회 이상 + 파일 다수 수정이 함께 예상될 때
- 대규모 리팩토링·마이그레이션
- 사용자가 "계획 먼저" 명시 요청
- 사용자 요청에 "리서치 / 리포트 / 심층 분석 / 종합 조사 / 검토 보고서" 같은 **큰 작업 명시 키워드**가 있고 도구 3회 이상 예상될 때
- 장시간·다량 API 호출로 비용·시간 부담이 큰 작업

**쓰지 마라**: 단순 조회, 단일 또는 소수(≤4) 도구 호출로 끝나는 일반 비교·요약, 인사·단답, 단일 페이지 생성(suggest 3단계 사용).`,
    {
      title: z.string().describe('플랜 제목 (간결). 예: "삼성전자 펀더멘털 5단계 분석"'),
      steps: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        tool: z.string().optional(),
      })).describe('실행 단계 순서'),
      estimatedTime: z.string().optional().describe('예상 소요. 예: "2~3분"'),
      risks: z.array(z.string()).optional().describe('주의사항·리스크'),
    },
    async (args) => {
      // planId 발급 + plan-store 저장 → ✓실행 시 backend 가 조회해 다음 턴 prompt 에 강제 주입
      const { storePlan } = await import('../lib/plan-store');
      const planId = 'plan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      storePlan({
        planId,
        title: args.title as string,
        steps: args.steps as Array<{ title: string; description?: string; tool?: string }>,
        estimatedTime: args.estimatedTime as string | undefined,
        risks: args.risks as string[] | undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          component: 'PlanCard',
          props: {
            planId,
            title: args.title,
            steps: args.steps,
            estimatedTime: args.estimatedTime,
            risks: args.risks,
          },
          // ✓실행 → planExecuteId 동봉 / ⚙수정 → input + planReviseId 동봉 → AI 가 plan 재작성
          suggestions: [
            { type: 'plan-confirm', planId, label: '✓ 실행' },
            { type: 'plan-revise', planId, label: '⚙ 수정 제안', placeholder: '예: 1단계 빼고, 차트도 추가해줘' },
            '✕ 취소',
          ],
        }) }],
      };
    },
  );

  // ── 이미지 생성 ──────────────────────────────────────────────────────────
  server.tool(
    'image_gen',
    IMAGE_GEN_DESCRIPTION,
    {
      prompt: z.string().describe('이미지 설명 프롬프트 (영어 권장). 스타일·구도·색감·텍스트 힌트 포함.'),
      size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).optional().describe('출력 크기 (OpenAI gpt-image 계열만 유효, Gemini 는 무시). 미지정 시 서버 기본값.'),
      quality: z.enum(['low', 'medium', 'high']).optional().describe('품질 (OpenAI 만 유효). low=$0.011 / medium=$0.042 / high=$0.17.'),
      filenameHint: z.string().optional().describe('파일명 힌트 (로그용). 예: "blog-hero-samsung-2026"'),
      aspectRatio: z.string().optional().describe('Aspect ratio 후처리 crop — "16:9"(블로그 히어로), "1:1"(소셜), "4:5"(인스타), "3:2"(일반). 지정 시 sharp 가 인물·제품 자동 감지로 해당 비율 crop. OpenAI/Gemini 가 원하는 비율을 안 지원할 때 유용.'),
      focusPoint: z.enum(['attention', 'entropy', 'center']).optional().describe('Crop 전략 (aspectRatio 지정 시만 적용). attention=saliency 자동(기본·권장), entropy=디테일 많은 영역, center=중앙 고정.'),
      referenceImage: z.object({
        slug: z.string().optional().describe('갤러리 미디어 slug (가장 흔한 케이스, search_media 결과의 slug 사용)'),
        url: z.string().optional().describe('미디어 URL (`/user/media/<slug>.<ext>`) 또는 외부 https URL'),
        base64: z.string().optional().describe('base64 또는 data URI (`data:image/png;base64,...`)'),
      }).optional().describe('image-to-image 변환용 참조 이미지 (선택). 사용자가 기존 이미지 변환 요청 시 사용. 자세한 가이드는 도구 description 참조.'),
    },
    async (args) => {
      // **비동기 패턴** — startImageGeneration 즉시 placeholder URL 반환, 실제 생성은 백그라운드.
      // AI 가 60-90s await 안 함 (CLI HTTP timeout 회피) → URL 즉시 받아 page spec 박고 save_page 발행 가능.
      // 사용자가 페이지 reload 하면 placeholder → 실제 이미지로 자동 swap (디스크 파일 교체됨).
      // 이전 sync `core.generateImage` 는 채팅 이미지 모드 (/api/media/generate) 전용으로 유지.
      // referenceImage 지정 시 image-to-image 변환 (MediaManager 가 slug/url/base64 → binary resolve).
      const ref = args.referenceImage as { slug?: string; url?: string; base64?: string } | undefined;
      const res = await core.startImageGeneration({
        prompt: args.prompt as string,
        size: args.size as string | undefined,
        quality: args.quality as string | undefined,
        filenameHint: args.filenameHint as string | undefined,
        aspectRatio: args.aspectRatio as string | undefined,
        focusPoint: args.focusPoint as 'attention' | 'entropy' | 'center' | undefined,
        ...(ref ? { referenceImage: ref } : {}),
      });
      if (!res.success || !res.data) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error || '이미지 생성 시작 실패' }) }] };
      }
      const d = res.data;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          url: d.url,
          slug: d.slug,
          status: 'rendering',
          note: '백그라운드 생성 진행 중 — 페이지에 url 박고 save_page 즉시 발행하라. 사용자가 페이지 보면 placeholder → 실제 이미지로 자동 swap.',
        }) }],
      };
    },
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
    `페이지 저장. PageSpec JSON 문자열:
{"slug":"kebab-case","status":"published","project":"...","head":{"title":"...","description":"...","keywords":[...]},"body":[{"type":"Html","props":{"content":"<HTML>"}}]}

- body 는 컴포넌트 배열, Html 이 주, props.content 에 HTML+CSS+JS
- {title, html} 자체 형식 금지
- Html 은 iframe sandbox(allow-scripts) 에서 실행
- slug 충돌 시 자동 -2 접미사 (allowOverwrite 기본 false). 사용자 명시적 수정 요청 시만 true.
- pending 반환 — 실제 저장은 사용자 승인 후`,
    {
      slug: z.string().describe('페이지 slug'),
      spec: z.string().describe('PageSpec JSON 문자열 전체'),
      allowOverwrite: z.boolean().optional().describe('기존 페이지 덮어쓰기 허용 (사용자 명시적 수정 요청 시에만 true)'),
    },
    async ({ slug, spec, allowOverwrite }) => {
      // cron agent 컨텍스트면 승인 우회 (사용자 부재 자동 발행 — 등록 시점에 이미 승인 받음)
      const cronJobId = (globalThis as Record<string, unknown>)['__firebatCronAgentJobId'];
      if (cronJobId) {
        const r = await core.savePage(slug, spec, { allowOverwrite: !!allowOverwrite });
        if (!r.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: r.error }) }] };
        const actualSlug = r.data?.slug ?? slug;
        const renamed = !!r.data?.renamed;
        return { content: [{ type: 'text', text: JSON.stringify({
          success: true, slug: actualSlug, url: `/${actualSlug}`,
          ...(renamed ? { renamed: true, note: `기존 "${slug}" 보존 → "${actualSlug}" 로 저장` } : {}),
        }) }] };
      }
      // 일반 admin 채팅 — 승인 게이트
      const { createPending } = await import('../lib/pending-tools');
      const planId = createPending('save_page', { slug, spec, allowOverwrite: !!allowOverwrite }, `페이지 저장: /${slug}${allowOverwrite ? ' (덮어쓰기)' : ''}`);
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
    'read_image',
    `이미지·바이너리 파일 base64 로 읽기 (user/ 영역).
사용: 사용자가 업로드한 이미지 분석·파싱, 썸네일 용도. PNG/JPG/WEBP/PDF 등.
응답: { base64, mimeType, size }`,
    { path: z.string().describe('바이너리 파일 경로. 예: user/uploads/chart.png') },
    async ({ path }) => {
      const r = await core.readFileBinary(path);
      if (!r.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: r.error }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...r.data }) }] };
    },
  );

  server.tool(
    'write_file',
    `파일 생성/덮어쓰기 (user/ 영역만). 부모 디렉토리 자동 생성. 부분 수정은 edit_file 사용 (token 절감).
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
    'edit_file',
    `파일 부분 수정 — 정확한 문자열 매칭으로 oldString → newString 교체. **user/ 영역만** (system/core/infra 자동 차단).
- oldString 정확한 매칭 (공백·들여쓰기·줄바꿈 포함). 1글자 다르면 거부.
- oldString 미발견 → 에러
- oldString 중복 매칭 → 기본 거부 (replaceAll:true 명시 필요)
- 새 파일 생성·전체 재작성·5+ 군데 동시 수정 = write_file 사용
- 차단 영역 (system/modules/, core/, infra/, app/admin/ 등) 수정 시도 → canWrite 거부`,
    {
      path: z.string().describe('수정할 파일 경로'),
      oldString: z.string().describe('교체 대상 (정확 매칭 필요)'),
      newString: z.string().describe('대체 문자열 (oldString 과 달라야 함)'),
      replaceAll: z.boolean().optional().describe('true 면 모든 매칭 교체 (기본 false)'),
    },
    async ({ path, oldString, newString, replaceAll }) => {
      if (oldString === newString) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'oldString 과 newString 이 같음' }) }] };
      }
      const readRes = await core.readFile(path);
      if (!readRes.success || readRes.data == null) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: readRes.error || '파일 읽기 실패' }) }] };
      }
      const content = readRes.data;
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'oldString 미발견 — 정확한 공백·줄바꿈 포함 매칭 필요' }) }] };
      }
      if (occurrences > 1 && !replaceAll) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `oldString 이 ${occurrences}군데 매칭됨. replaceAll:true 명시 또는 더 긴 context 추가 필요` }) }] };
      }
      const newContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
      const writeRes = await core.writeFile(path, newContent);
      if (!writeRes.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: writeRes.error }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, replaced: occurrences }) }] };
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
pipeline: 복합 작업 (EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION/SAVE_PAGE 6가지 스텝 조합).
oneShot: 첫 성공 시 자동 취소 (가격 알림 등 조건부 1회 패턴).
startAt/endAt: cronTime의 유효 기간 (만료 시 자동 해제).

**LLM_TRANSFORM 절대 규칙**: instruction 안에 도구 워크플로우(sysmod_/save_page/image_gen 등) 자연어로 적지 마라. validatePipeline 이 거부한다. LLM_TRANSFORM 은 텍스트 변환만 — 도구 호출은 별도 step.

**SAVE_PAGE step (cron 자동 발행 전용)**: 정기 블로그 잡의 마지막 step. pipeline 등록 시점에 사용자 승인이 곧 매 트리거 발행 동의이므로 매 실행마다 재승인 게이트 우회. {type:"SAVE_PAGE", slug:"...", inputMap:{spec:"$prev"}, allowOverwrite:false}.

예 (조건부 알림):
{cronTime:"*/5 9-15 * * 1-5", pipeline:[{type:"EXECUTE",path:"system/modules/kiwoom/index.mjs",inputData:{action:"price",symbol:"005930"}},{type:"CONDITION",field:"$prev.price",op:">=",value:217000},{type:"EXECUTE",path:"system/modules/kakao-talk/index.mjs",inputData:{action:"send-me",text:"삼성전자 217000원 도달"}}], oneShot:true}

예 (정기 블로그 자동 발행 — 평일 16:30 장마감):
{cronTime:"30 16 * * 1-5", pipeline:[
  {type:"EXECUTE",path:"system/modules/kiwoom/index.mjs",inputData:{action:"price",symbol:"KS11"}},
  {type:"EXECUTE",path:"system/modules/kiwoom/index.mjs",inputData:{action:"foreign-trade"}},
  {type:"EXECUTE",path:"system/modules/naver-search/index.mjs",inputData:{action:"news",query:"코스피 마감"}},
  {type:"LLM_TRANSFORM",instruction:"위 데이터로 SEO 블로그 PageSpec JSON 만들어라. 형식: {head:{title,description,keywords},body:[{type:'Html',props:{content:'<완성 HTML>'}}]}. 본문 1000자+, h2 섹션 4개."},
  {type:"SAVE_PAGE",slug:"stock-blog/<오늘날짜>-close",inputMap:{spec:"$prev"}}
]}

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
      executionMode: z.enum(['pipeline', 'agent']).optional().describe('실행 모드 (기본 pipeline). pipeline = 미리 짠 step 결정적 실행 (싸고 결정적). agent = 트리거 시 AI Function Calling 사이클로 agentPrompt 실행 (도구 자유 사용·검증·콘텐츠 생성, 비용 ↑). 블로그·리포트·일정 정리는 agent. 단순 알림·시세는 pipeline.'),
      agentPrompt: z.string().optional().describe('agent 모드 전용 — 트리거 시 AI 에 전달할 자연어 instruction. 잡 목적·필요 데이터·출력 형식 명시. pipeline 모드 시 무시.'),
      runWhen: z.object({
        check: z.object({
          sysmod: z.string(),
          action: z.string(),
          inputData: z.record(z.string(), z.any()).optional(),
        }),
        field: z.string(),
        op: z.enum(['==', '!=', '<', '<=', '>', '>=', 'includes', 'not_includes', 'exists', 'not_exists']),
        value: z.string().optional(),
      }).optional().describe('발화 전 조건 체크 (휴장·가드 등). 미충족 시 skip. 휴장일 enumerate 하드코딩 금지 — sysmod API 동적 호출.'),
      retry: z.object({
        count: z.number(),
        delayMs: z.number().optional(),
      }).optional().describe('자동 retry 정책. 멱등 도구만 사용. 부작용 도구(매수 등)는 금지.'),
      notify: z.object({
        onSuccess: z.object({ sysmod: z.string(), chatId: z.string().optional(), template: z.string().optional() }).optional(),
        onError: z.object({ sysmod: z.string(), chatId: z.string().optional(), template: z.string().optional() }).optional(),
      }).optional().describe('결과 알림 hook (pipeline step 으로 분리하지 말 것). retry 모두 소진 후 최종 상태로만 onError 발동.'),
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
      // 과거 runAt 감지 → 승인 버튼 대신 '즉시 발송 / 시간 변경' UI 유도
      let status: 'past-runat' | undefined;
      let originalRunAt: string | undefined;
      if (args.runAt) {
        const t = Date.parse(args.runAt);
        if (!isNaN(t) && t <= Date.now()) {
          status = 'past-runat';
          originalRunAt = args.runAt;
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true, pending: true, planId, summary,
          ...(status ? { status, originalRunAt } : {}),
          message: status
            ? '요청 시각이 이미 지났습니다. 즉시 실행 또는 새 시각 지정이 필요합니다.'
            : '사용자 승인 대기 중입니다. Firebat UI 에서 승인 버튼 클릭 시 실제 등록됩니다.',
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
    'run_cron_job',
    `기존 등록된 cron 잡 즉시 1회 트리거. 정상 cron 발화와 동일 path —
cron-logs 기록 + agent prelude (블로그 quality 룰) 적용 + retry/notify 동작.

사용자가 "X 잡 한 번 실행해줘" 의뢰 시 list_tasks 로 jobId 찾고 이 도구로 호출.
save_page / schedule_task 직접 호출 X — 그건 cron 우회라 prelude 미적용 + 로그 안 박힘.`,
    { jobId: z.string().describe('실행할 cron 잡 ID (list_tasks 결과의 jobId)') },
    async ({ jobId }) => {
      const r = await core.runCronJobNow(jobId);
      return { content: [{ type: 'text', text: JSON.stringify(r.success ? { success: true, message: '잡 트리거됨. cron-logs 에서 결과 확인.' } : { error: r.error }) }] };
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

  // ── 메모리 시스템 — Entity tier (Phase 1) ─────────────────────────────────
  // CLI 모드 (Claude Code / Codex / Gemini CLI) 에서도 동일 도구 사용 가능.
  // ai-manager handler 와 같은 dispatch — entity 자동 조회·생성, ISO 시각 변환.

  server.tool(
    'save_entity',
    `메모리 시스템 — Entity (추적 대상) 저장. name+type 으로 upsert. type 자유 (stock/company/person/project/concept/event 등).`,
    {
      name: z.string().describe('Entity 정식 명칭'),
      type: z.string().describe('자유 분류 — stock / company / person / project / concept / event'),
      aliases: z.array(z.string()).optional().describe('별칭 (검색 통합 매칭)'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('자유 메타 (ticker / industry 등)'),
    },
    async ({ name, type, aliases, metadata }) => {
      const res = await core.saveEntity({ name, type, aliases, metadata });
      if (!res.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, id: res.data?.id, created: res.data?.created }) }] };
    },
  );

  server.tool(
    'save_entity_fact',
    `메모리 시스템 — Entity 에 fact (시간 stamped 사실) link. 대화 끝나도 보존. entityName 박으면 자동 조회·생성.`,
    {
      entityName: z.string().optional().describe('Entity 이름 — 없으면 자동 생성'),
      entityType: z.string().optional().describe('자동 생성 시 type (기본 "concept")'),
      entityId: z.number().int().optional().describe('Entity ID 직접 지정 (entityName 보다 우선)'),
      content: z.string().describe('사실 본문 — 자연어 1-2 문장. 시간·수치 명시 권장'),
      factType: z.string().optional().describe('recommendation / transaction / analysis / observation / event / report 등 자유'),
      occurredAt: z.string().optional().describe('ISO 8601 (예: "2026-04-15T09:00:00+09:00")'),
      tags: z.array(z.string()).optional(),
      ttlDays: z.number().int().optional().describe('만료 일수 (기본 영구)'),
    },
    async ({ entityName, entityType, entityId, content, factType, occurredAt, tags, ttlDays }) => {
      let resolvedId = entityId;
      if (!resolvedId && entityName) {
        const found = await core.findEntityByName(entityName);
        if (found.success && found.data) {
          resolvedId = found.data.id;
        } else {
          const created = await core.saveEntity({ name: entityName, type: entityType || 'concept' });
          if (!created.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `entity 생성 실패: ${created.error}` }) }] };
          resolvedId = created.data?.id;
        }
      }
      if (!resolvedId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'entityName 또는 entityId 필수' }) }] };
      let occurredAtMs: number | undefined;
      if (occurredAt) {
        const t = new Date(occurredAt).getTime();
        if (Number.isFinite(t)) occurredAtMs = t;
      }
      const res = await core.saveEntityFact({
        entityId: resolvedId, content, factType, occurredAt: occurredAtMs, tags, ttlDays,
      });
      if (!res.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, factId: res.data?.id, entityId: resolvedId }) }] };
    },
  );

  server.tool(
    'search_entities',
    `메모리 시스템 — Entity 검색. semantic (임베딩 cosine + alias) + type/nameLike 필터.`,
    {
      query: z.string().optional().describe('Semantic search 쿼리 (자연어)'),
      type: z.string().optional().describe('Type 필터 (예: "stock" 만)'),
      nameLike: z.string().optional().describe('이름 부분 매칭'),
      limit: z.number().int().optional().describe('최대 결과 수 (기본 10)'),
    },
    async (args) => {
      const res = await core.searchEntities({ query: args.query, type: args.type, nameLike: args.nameLike, limit: args.limit });
      if (!res.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error }) }] };
      const matches = (res.data ?? []).map(e => ({
        id: e.id, name: e.name, type: e.type, aliases: e.aliases, metadata: e.metadata, factCount: e.factCount,
        firstSeen: new Date(e.firstSeen).toISOString(), lastUpdated: new Date(e.lastUpdated).toISOString(),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, matches, count: matches.length }) }] };
    },
  );

  server.tool(
    'get_entity_timeline',
    `메모리 시스템 — Entity 의 fact timeline (시간순). entityName 박으면 자동 조회.`,
    {
      entityName: z.string().optional(),
      entityId: z.number().int().optional(),
      limit: z.number().int().optional().describe('기본 20'),
      orderBy: z.enum(['occurredAt', 'createdAt']).optional().describe('기본 occurredAt'),
    },
    async ({ entityName, entityId, limit, orderBy }) => {
      let resolvedId = entityId;
      if (!resolvedId && entityName) {
        const found = await core.findEntityByName(entityName);
        if (!found.success || !found.data) return { content: [{ type: 'text', text: JSON.stringify({ success: true, matches: [], count: 0, message: `entity 없음: ${entityName}` }) }] };
        resolvedId = found.data.id;
      }
      if (!resolvedId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'entityName 또는 entityId 필수' }) }] };
      const res = await core.getEntityTimeline(resolvedId, { limit, orderBy });
      if (!res.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error }) }] };
      const facts = (res.data ?? []).map(f => ({
        id: f.id, content: f.content, factType: f.factType, tags: f.tags,
        occurredAt: f.occurredAt ? new Date(f.occurredAt).toISOString() : undefined,
        createdAt: new Date(f.createdAt).toISOString(),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, entityId: resolvedId, matches: facts, count: facts.length }) }] };
    },
  );

  server.tool(
    'search_entity_facts',
    `메모리 시스템 — Fact 횡단 검색 (entity 무관). semantic + factType / tags / 시간 범위 필터.`,
    {
      query: z.string().optional(),
      entityName: z.string().optional(),
      entityId: z.number().int().optional(),
      factType: z.string().optional(),
      tags: z.array(z.string()).optional(),
      occurredAfter: z.string().optional().describe('ISO 8601'),
      occurredBefore: z.string().optional().describe('ISO 8601'),
      limit: z.number().int().optional().describe('기본 20'),
    },
    async (args) => {
      let resolvedId = args.entityId;
      if (!resolvedId && args.entityName) {
        const found = await core.findEntityByName(args.entityName);
        if (found.success && found.data) resolvedId = found.data.id;
      }
      const occurredAfterMs = args.occurredAfter ? new Date(args.occurredAfter).getTime() : undefined;
      const occurredBeforeMs = args.occurredBefore ? new Date(args.occurredBefore).getTime() : undefined;
      const res = await core.searchEntityFacts({
        query: args.query,
        entityId: resolvedId,
        factType: args.factType,
        tags: args.tags,
        occurredAfter: Number.isFinite(occurredAfterMs) ? occurredAfterMs : undefined,
        occurredBefore: Number.isFinite(occurredBeforeMs) ? occurredBeforeMs : undefined,
        limit: args.limit,
      });
      if (!res.success) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error }) }] };
      const facts = (res.data ?? []).map(f => ({
        id: f.id, entityId: f.entityId, content: f.content, factType: f.factType, tags: f.tags,
        occurredAt: f.occurredAt ? new Date(f.occurredAt).toISOString() : undefined,
        createdAt: new Date(f.createdAt).toISOString(),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, matches: facts, count: facts.length }) }] };
    },
  );

  return server;
}
