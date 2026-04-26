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

export function createInternalMcpServer(core: FirebatCore): McpServer {
  const server = new McpServer({ name: 'firebat-internal', version: '0.1.0' });

  // ── UI 렌더링 — 14개 render_* 도구 ────────────────────────────────────
  const makeRender = (name: string, component: string, schema: Record<string, z.ZodTypeAny>, desc: string) => {
    server.tool(name, desc, schema, async (args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true, component, props: args }) }],
    }));
  };

  makeRender('render_stock_chart', 'StockChart', {
    symbol: z.string().describe('종목 코드 또는 이름 (표시용)'),
    title: z.string().describe('차트 제목'),
    data: z.array(z.object({
      date: z.string().describe('YYYY-MM-DD 또는 시각 문자열'),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
      volume: z.number(),
    })).describe('OHLCV 배열 (오름차순 정렬, 날짜 오래된 것부터 최근 순)'),
    indicators: z.array(z.enum(['MA5','MA10','MA20','MA60'])).optional().describe('이동평균선 겹쳐 그리기'),
    buyPoints: z.array(z.object({ price: z.number(), label: z.string() })).optional().describe('매수 구간 점선 + 라벨'),
    sellPoints: z.array(z.object({ price: z.number(), label: z.string() })).optional().describe('매도 구간 점선 + 라벨'),
  }, '주식 캔들스틱 + 거래량 차트. 팬/줌 지원, 호버 시 OHLC 툴팁.');
  makeRender('render_table', 'Table', {
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    /** 컬럼별 정렬. 미지정 시 자동(숫자 컬럼→right, 그 외→left). 짧은 상태·뱃지성 단어는 center 추천. */
    align: z.array(z.enum(['left', 'right', 'center'])).optional(),
    // 참고: 셀별 정렬(cellAlign) 은 Gemini CLI 가 중첩 배열 + enum 스키마를 거부해서 MCP 도구 노출에서 제외.
    // PageSpec body 에서 직접 prop 으로 지정은 여전히 가능 (components.tsx Table 컴포넌트는 cellAlign 지원).
  }, '표. 수치 3개 이상 시 필수. 기본 정렬은 자동(숫자→우측, 텍스트→좌측). align 로 컬럼별 정렬 지정 가능.');
  makeRender('render_alert', 'Alert', {
    message: z.string(),
    type: z.enum(['info','warn','error','success']).describe('warn=주황, error=빨강, success=초록, info=파랑'),
    title: z.string().optional(),
  }, '경고·주의·위험 박스 (리스크·오류 알림 전용). 일반 정보·팁은 render_callout 사용.');
  makeRender('render_callout', 'Callout', {
    message: z.string(),
    type: z.enum(['info','success','tip','accent','highlight','neutral']).optional().describe('tip=보라, accent=주황, highlight=노랑, neutral=회색 (기본 info=파랑)'),
    title: z.string().optional(),
  }, '정보 강조 박스 — 팁·핵심 요약·판단 근거·하이라이트. 경고는 render_alert 사용.');
  makeRender('render_badge', 'Badge', {
    text: z.string(),
    color: z.enum(['blue','green','red','yellow','purple','gray','orange']).describe('뱃지 색상'),
  }, '작은 태그/뱃지 1개. 여러 상태 나열은 render_status_badge 사용.');
  makeRender('render_progress', 'Progress', {
    value: z.number().describe('현재 값'),
    max: z.number().optional().describe('최대 값 (기본 100)'),
    label: z.string().optional().describe('진행바 제목'),
    color: z.enum(['blue','green','red','yellow','purple','orange']).optional().describe('바 색상 (기본 blue)'),
  }, '진행률 바. 달성률·로딩·목표 대비 현황 시각화.');
  makeRender('render_header', 'Header', {
    text: z.string(),
    level: z.number().optional(),
    align: z.enum(['left','right','center']).optional().describe('기본 left. 히어로 섹션·카드 타이틀은 center.'),
  }, '섹션 제목.');
  makeRender('render_text', 'Text', {
    content: z.string().describe('마크다운 지원 — **굵게** *기울임* `코드` 목록 링크 등. 이 필드만 마크다운 허용.'),
  }, '본문 텍스트 블록 (마크다운 렌더). 짧은 한 줄·헤딩은 render_header / render_callout 우선.');
  makeRender('render_list', 'List', {
    items: z.array(z.string()).describe('각 항목 한 줄 텍스트'),
    ordered: z.boolean().optional().describe('true=번호 목록(1,2,3), false=불릿(기본)'),
  }, '순서·비순서 목록. 각 항목 간결한 한 줄씩.');
  makeRender('render_divider', 'Divider', {}, '섹션 구분선 (수평선). 긴 리포트에서 주제 전환 시 사용.');
  makeRender('render_countdown', 'Countdown', {
    targetDate: z.string().describe('ISO 8601 형식 목표 시각. 예: "2026-12-31T23:59:59+09:00"'),
    label: z.string().optional().describe('카운트다운 제목. 예: "이벤트 종료까지"'),
  }, '목표 시각까지 남은 일/시/분/초 실시간 카운트다운.');
  makeRender('render_chart', 'Chart', {
    chartType: z.enum(['bar','line','pie','doughnut']).describe(
      'bar=값 크기 비교 (독립 수치). line=시간에 따른 추세. ' +
      'pie/doughnut=전체에서 차지하는 비율 (부분 합 = 전체 100%). ' +
      '⚠️ 독립 비율 비교(종목별 외국인 보유율 등)는 합계가 100% 아니므로 pie 금지 — bar 사용.'
    ),
    labels: z.array(z.string()).describe('각 항목 라벨. **값·퍼센트 중복 표기 금지** (예: "삼성전자 (49.1%)" → "삼성전자"로).'),
    data: z.array(z.number()).describe('수치 배열. labels 와 길이 동일.'),
    title: z.string().optional(),
    subtitle: z.string().optional().describe('부제목 (데이터 출처·기간 등)'),
    unit: z.string().optional().describe('값 단위 (예: "원", "%", "건")'),
    color: z.enum(['blue','green','red','purple','orange','teal','pink','yellow','slate']).optional().describe('bar/line 단일 색상 (기본 blue)'),
    palette: z.enum(['default','pastel','mono-blue','mono-green','red-green','earth']).optional().describe('pie/doughnut 색상 팔레트'),
    showValues: z.boolean().optional().describe('bar 값 inline 표시 (기본 true)'),
    showPct: z.boolean().optional().describe('pie/doughnut 범례·툴팁에 자동 계산 % 표시 (기본 true). data 가 이미 퍼센트 값(합≠100)이면 false 로 중복 회피.'),
  }, '간단 차트. chartType 선택이 중요 — 비율 분해만 pie, 독립 수치 비교는 bar.');

  makeRender('render_metric', 'Metric', {
    label: z.string().describe('지표명 (예: "현재가", "PER")'),
    value: z.union([z.string(), z.number()]).describe('대표 수치 — 하나만. 두 개 값 병렬 금지. 숫자는 3자리 콤마 자동.'),
    unit: z.string().optional().describe('단위 (원, %, 배 등)'),
    delta: z.union([z.string(), z.number()]).optional().describe('증감치 (예: -1500, "-0.69%"). 숫자 3자리 콤마 자동.'),
    deltaType: z.enum(['up','down','neutral']).optional().describe('up=빨강, down=파랑, neutral=회색'),
    subLabel: z.string().optional().describe('보조 설명 — 부가 맥락만. 동등한 값 병렬 표시 금지.'),
    icon: z.string().optional().describe('이모지 아이콘 (예: "📈")'),
    align: z.enum(['left','right','center']).optional().describe('전체 정렬 일괄 지정. 미지정 시 기본값: label·subLabel=center, value=(숫자→right / 텍스트→center), delta=right.'),
    labelAlign: z.enum(['left','right','center']).optional().describe('라벨 정렬만 개별 지정.'),
    valueAlign: z.enum(['left','right','center']).optional().describe('값 정렬만 개별 지정.'),
    deltaAlign: z.enum(['left','right','center']).optional().describe('증감 정렬만 개별 지정.'),
    subLabelAlign: z.enum(['left','right','center']).optional().describe('부연 설명 정렬만 개별 지정.'),
  }, '단일 지표 카드. 라벨+값+증감. 필드별 정렬 개별 조절 가능.');

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
    src: z.string().describe('이미지 URL (http/https 또는 상대 경로). image_gen 결과의 url 을 그대로 전달.'),
    alt: z.string().optional().describe('대체 텍스트 (접근성·SEO)'),
    width: z.number().optional().describe('픽셀 단위 너비'),
    height: z.number().optional().describe('픽셀 단위 높이'),
    variants: z.array(z.object({
      width: z.number(),
      height: z.number().optional(),
      format: z.string(),
      url: z.string(),
      bytes: z.number().optional(),
    })).optional().describe('반응형 variants (image_gen 결과의 variants 배열 그대로). 있으면 <picture> + srcset 자동 구성.'),
    blurhash: z.string().optional().describe('Blurhash LQIP 문자열 (image_gen 결과의 blurhash). 로딩 플레이스홀더 표시.'),
    thumbnailUrl: z.string().optional().describe('썸네일 URL (image_gen 결과의 thumbnailUrl). 갤러리용 보조 필드.'),
  }, '이미지 블록 (figure + caption). image_gen 결과의 url/variants/blurhash 전부 넘겨주면 <picture> + AVIF/WebP srcset + blur placeholder 자동 구성.');
  makeRender('render_card', 'Card', {
    children: z.array(z.any()).describe('카드 안에 넣을 render_* 결과 배열 (컨테이너)'),
    align: z.enum(['left','right','center']).optional().describe('카드 내부 전체 텍스트 정렬. 기본 left.'),
  }, '흰 배경·둥근 테두리 카드 컨테이너. 관련 컴포넌트 묶음 용도.');
  makeRender('render_grid', 'Grid', {
    columns: z.number().describe('1~4 열. KPI 대시보드는 보통 2~3'),
    children: z.array(z.any()).describe('각 셀에 배치할 render_* 결과 배열'),
    align: z.enum(['left','right','center']).optional().describe('그리드 내부 전체 텍스트 정렬. 기본 left.'),
  }, '2D 격자 레이아웃. render_metric 여러 개를 담으면 KPI 대시보드.');

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
    },
    async (args) => {
      const res = await core.generateImage({
        prompt: args.prompt as string,
        size: args.size as string | undefined,
        quality: args.quality as string | undefined,
        filenameHint: args.filenameHint as string | undefined,
        aspectRatio: args.aspectRatio as string | undefined,
        focusPoint: args.focusPoint as 'attention' | 'entropy' | 'center' | undefined,
      });
      if (!res.success || !res.data) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: res.error || '이미지 생성 실패' }) }] };
      }
      const d = res.data;
      return {
        content: [{ type: 'text', text: JSON.stringify({
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
      // 승인 대기 — 기존 페이지 덮어쓰기 방지 + 의도 확인
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

  return server;
}
