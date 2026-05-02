/**
 * Tool Schemas — AI Function Calling 정적 도구 정의 (schema only, handler X).
 *
 * AiManager 의 내부 collaborator 데이터 모듈. 외부 import 금지.
 *
 * 책임:
 *   1. PIPELINE_STEP_SCHEMA — schedule_task / run_task 의 pipeline 항목 schema 재사용 const.
 *   2. RENDER_TOOLS — render_alert / render_callout strict schema 2종.
 *   3. buildCoreToolDefinitions — 27개 정적 도구 schema (file/page/schedule/render/search/image_gen 등).
 *
 * 분리 이유: 1500줄 중 schema 데이터만 ~410줄. handler 코드와 분리되면 AiManager 가능.
 *   handler 는 여전히 AiManager.registerStaticToolsToManager 에서 등록 (this 의존 유지).
 */
import type { JsonSchema, ToolDefinition } from '../../ports';
import { IMAGE_GEN_DESCRIPTION } from '../../../lib/image-gen-prompt';

/** 파이프라인 단계 JSON Schema — schedule_task / run_task 가 items 로 참조 */
export const PIPELINE_STEP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'EXECUTE | MCP_CALL | NETWORK_REQUEST | LLM_TRANSFORM | CONDITION | SAVE_PAGE | TOOL_CALL', enum: ['EXECUTE', 'MCP_CALL', 'NETWORK_REQUEST', 'LLM_TRANSFORM', 'CONDITION', 'SAVE_PAGE', 'TOOL_CALL'] },
    description: { type: 'string', description: '단계 설명' },
    path: { type: 'string', description: 'EXECUTE: 모듈 경로 (예: system/modules/kiwoom/index.mjs)' },
    inputData: { type: 'object', description: '이 단계의 자체 입력. EXECUTE/SAVE_PAGE/TOOL_CALL 등에서 사용 (예: {action, symbol} / {slug, spec} / {prompt, aspectRatio}).', additionalProperties: true },
    inputMap: { type: 'object', description: '$prev 매핑 (예: {"url":"$prev.url"} 또는 SAVE_PAGE 의 {"spec":"$prev"})', additionalProperties: true },
    server: { type: 'string', description: 'MCP_CALL: 서버 이름' },
    tool: { type: 'string', description: 'MCP_CALL: 도구 이름. TOOL_CALL: Function Calling 도구명 (image_gen / search_history / search_media / render_* 등).' },
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

/** render_alert / render_callout — 안전망·보편 도구 2종 (strict 모드). 나머지 render_* 는 search_components 로 발견. */
export const RENDER_TOOLS: ToolDefinition[] = [
  {
    name: 'render_alert',
    description: '경고·주의·위험 박스(빨강/주황 계열). 리스크·오류·경고 메시지 전용. 일반 정보/팁/강조는 render_callout 사용.',
    strict: true,
    parameters: {
      type: 'object',
      required: ['message', 'type', 'title', 'action'],
      additionalProperties: false,
      properties: {
        message: { type: 'string' },
        type: { type: 'string', enum: ['warn', 'error'], description: 'warn=주황(주의/경고), error=빨강(위험/오류)' },
        title: { type: ['string', 'null'], description: '제목 (불필요하면 null)' },
        action: {
          type: ['object', 'null'],
          description: 'CTA 버튼 (선택). 박혀있으면 본문 아래에 link 버튼 자동. 미사용 시 null.',
          required: ['label', 'href'],
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: '버튼 텍스트 (예: "자세히 보기")' },
            href: { type: 'string', description: '링크 URL — /, https://, mailto:, tel: 등' },
          },
        },
      },
    },
  },
  {
    name: 'render_callout',
    description: '일반 정보/강조 박스. 배경색으로 의미 구분. 경고/위험은 render_alert 사용.',
    strict: true,
    parameters: {
      type: 'object',
      required: ['message', 'type', 'title', 'action'],
      additionalProperties: false,
      properties: {
        message: { type: 'string' },
        type: {
          type: 'string',
          enum: ['info', 'success', 'tip', 'accent', 'highlight', 'neutral'],
          description: 'info=파랑(정보), success=초록(완료/긍정 결과), tip=보라(팁/추천), accent=주황(강조/핵심 포인트), highlight=노랑(주목/하이라이트), neutral=회색(일반/참고 메모)',
        },
        title: { type: ['string', 'null'], description: '제목 (불필요하면 null)' },
        action: {
          type: ['object', 'null'],
          description: 'CTA 버튼 (선택). 박혀있으면 본문 아래에 link 버튼 자동. 미사용 시 null.',
          required: ['label', 'href'],
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: '버튼 텍스트 (예: "자세히 보기")' },
            href: { type: 'string', description: '링크 URL — /, https://, mailto:, tel: 등' },
          },
        },
      },
    },
  },
];

/** 27개 정적 Core 도구 schema — file/page/schedule/render/search/image_gen 등.
 *  handler 는 AiManager.registerStaticToolsToManager 가 별도로 등록. */
export function buildCoreToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'write_file',
      description: '파일 생성/덮어쓰기 — 새 파일이거나 전체 재작성. 부분 수정은 edit_file 사용 (token 절감).',
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
      name: 'edit_file',
      description: `파일 부분 수정 — 정확한 문자열 매칭으로 oldString → newString 교체. **user/ 영역만 수정 가능** (sysmod·core·infra 자동 차단).

**호출 시점**:
- user/modules/ 의 기존 파일 일부 수정 (write_file 의 token 낭비 회피)
- bug fix, 코드 한 줄 변경, import 추가 등

**호출 금지**:
- 새 파일 생성 (write_file 사용)
- 전체 재작성 (write_file)
- 5+ 군데 동시 수정 — write_file 더 효율적
- system/modules/, system/services/, core/, infra/, app/admin/ — Firebat 시스템 영역. canWrite 자동 차단됨.

**규칙**:
- oldString 정확한 매칭 (공백·들여쓰기·줄바꿈 포함). 1글자 다르면 거부.
- oldString 미발견 → 에러
- oldString 중복 매칭 → 기본 거부 (replaceAll:true 명시 필요)
- newString 다르게 입력 (X 동일하면 의미 X)`,
      parameters: {
        type: 'object',
        required: ['path', 'oldString', 'newString'],
        properties: {
          path: { type: 'string', description: '수정할 파일 경로' },
          oldString: { type: 'string', description: '교체 대상 문자열 — 파일 안 정확한 매칭 필요 (공백·줄바꿈 포함)' },
          newString: { type: 'string', description: '대체 문자열 (oldString 과 달라야 함)' },
          replaceAll: { type: 'boolean', description: 'true 면 모든 매칭 교체 (기본 false — 중복 매칭 시 에러)' },
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
      name: 'glob_files',
      description: `Glob 패턴으로 파일 경로 검색 — \`**/*.ts\` 같은 와일드카드.

**사용 예**:
- \`user/modules/*/main.py\` — user 모듈들의 main.py 모두
- \`**/*.json\` — 전체 JSON 파일
- \`system/modules/**/config.json\` — 시스템 모듈 config 모두
- \`data/cache/**/*.jsonl\` — cache 디렉토리 jsonl

**호출 시점**:
- 파일 경로 모를 때 list_dir 반복 대신 한 번에 검색
- 특정 패턴 매칭 파일 목록 필요 시 (확장자별, 디렉토리 구조별)

**호출 금지**:
- 정확한 경로 알 때 (read_file 직접 사용)
- 콘텐츠 검색 (grep_code 사용)`,
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Glob 패턴 (예: "**/*.ts", "user/modules/*/main.py")' },
          limit: { type: 'number', description: '최대 결과 수 (기본 500)' },
        },
      },
    },
    {
      name: 'grep_code',
      description: `파일 내용에서 정규식 매칭 line 추출 — 코드 검색.

**사용 예**:
- \`grep_code("kiwoom", { path: "user/modules/" })\` — user 모듈에서 "kiwoom" 검색
- \`grep_code("import.*react", { fileType: "tsx" })\` — tsx 파일에서 react import
- \`grep_code("TODO", { fileType: "ts", ignoreCase: true })\` — 모든 ts 의 TODO

**호출 시점**:
- 어떤 파일에 특정 패턴 박혀있는지 모를 때
- 모듈 디버깅 — 특정 함수·변수 사용처 검색
- 설정값·magic number 추적

**호출 금지**:
- 파일 이름 검색 (glob_files 사용)
- 단일 파일 안 검색 (read_file 후 자체 파싱)`,
      parameters: {
        type: 'object',
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: '정규식 패턴 (예: "import.*react", "TODO")' },
          path: { type: 'string', description: '검색 시작 경로 (예: "user/modules/"). 미지정 시 zone 전체.' },
          fileType: { type: 'string', description: '확장자 필터 (예: "ts", "py", "json"). dot 자동.' },
          limit: { type: 'number', description: '최대 매칭 line 수 (기본 200)' },
          ignoreCase: { type: 'boolean', description: '대소문자 무시 (기본 false)' },
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
          spec: { type: 'object', description: `PageSpec — { head:{title,description,keywords,og}, project, status:"published", body: render_* 컴포넌트 객체 배열 }.

**head.description 작성 룰 (SEO meta description, 검색 노출 직결)**:
- 본문 본질을 압축한 자연어 1-2 문장 (120-160자 권장, 모바일 검색결과 cutoff).
- 본문 첫 줄 그대로 박지 마라 — 그건 자동 fallback (백엔드가 첫 Text 120자 알아서 추출).
- 구체 키워드 + 핵심 수치/결론 포함 — 검색결과 클릭 유도 (예: "삼성전자 1Q 영업이익 6.6조 +931% 발표 — 메모리 회복·서버 DRAM 가격 상승 영향").
- 단순 본문 발췌 X. 본문이 "오늘 코스피 마감" 으로 시작해도 description 은 "코스피 6,605 마감 -0.78%, 외인 1.5조 매도 폭탄에 8거래일째 내림. 삼성전자·SK하이닉스 5%대 하락 주도" 식으로 핵심 요약.
- 미박힘 시 SEO 메타 비어 검색 노출 약화 — 반드시 박을 것.

body 는 반드시 [{type:"Header",props:{...}}, {type:"Text",props:{...}}, {type:"Table",props:{...}}, ...] 형태 여러 컴포넌트. **단일 Html 블록 1개로 통째 만들면 페이지가 iframe 안에 들어가 AdSense 광고·SEO 인덱싱 모두 차단**. Html 블록은 Leaflet/Mermaid/KaTeX 같은 특수 시각화 한 섹션에만 사용.`, additionalProperties: true },
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
      name: 'get_template',
      description: '페이지 템플릿 조회 (CMS Phase 8b) — user/templates/{slug}/template.json. 반환된 spec 의 head·body 를 baseline 으로 변동값만 교체해 save_page 호출. 일관 발행 보장. cron-agent prompt 에 사용 가능 템플릿 목록 자동 주입됨 — 매칭되는 slug 사용.',
      parameters: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: '템플릿 slug (영숫자·하이픈·언더스코어). cron-agent prelude 의 사용 가능 목록에서 선택.' },
        },
      },
    },
    {
      name: 'list_tags',
      description: '모든 public+published 페이지의 head.keywords aggregation + 사용 빈도. CMS settings.tagAliases 적용 — case-insensitive normalize 후 canonical 통합. 사용자가 "어떤 태그 있어?" / "코스피 태그 페이지 몇 개?" 등 질문 시 호출.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_templates',
      description: '등록된 페이지 템플릿 목록 조회 (CMS Phase 8b). 사용자가 템플릿 보고 관리할 때 사용.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'save_template',
      description: '페이지 템플릿 등록·수정 (CMS Phase 8b). 사용자가 자연어로 "주간 시황 템플릿 만들어줘" 같이 요청 시 호출. spec.body 는 render_* 컴포넌트 객체 배열 (Header/Text/Table/Callout/Metric 등). spec.head 는 SEO 메타 (title/description/keywords 자리에 {date} 같은 변수 placeholder 사용 가능 — cron-agent 가 발행 시 교체).',
      parameters: {
        type: 'object',
        required: ['slug', 'config'],
        properties: {
          slug: { type: 'string', description: '템플릿 slug (영숫자·하이픈·언더스코어). user/templates/{slug}/template.json 으로 저장.' },
          config: {
            type: 'object',
            required: ['name', 'spec'],
            additionalProperties: true,
            properties: {
              name: { type: 'string', description: '사람 친화 이름 (어드민 UI 표시)' },
              description: { type: 'string', description: '템플릿 목적·사용 시점. cron-agent 매칭 시 참고.' },
              tags: { type: 'array', items: { type: 'string' }, description: '분류 태그 (stock / news / report 등)' },
              spec: {
                type: 'object',
                required: ['body'],
                additionalProperties: true,
                properties: {
                  head: { type: 'object', additionalProperties: true, description: 'SEO 메타 — title/description/keywords/og 등' },
                  body: { type: 'array', description: 'render_* 컴포넌트 객체 배열', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
      },
    },
    {
      name: 'delete_template',
      description: '페이지 템플릿 삭제. user/templates/{slug} 폴더 통째 제거.',
      parameters: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: '삭제할 템플릿 slug' },
        },
      },
    },
    {
      name: 'schedule_task',
      description: '모듈/파이프라인 예약 실행 등록. 반복(cronTime), 1회(runAt), 지연(delaySec). 가격 알림 등 "조건 충족 시 1회 알림" 패턴은 cronTime + oneShot:true + CONDITION 스텝 조합. 휴장·가드 같은 발화 전 체크는 runWhen, 일시 실패 자동 복구는 retry, 결과 알림은 notify 옵션 사용 (pipeline step 안에 박지 마라).',
      parameters: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', description: '사이드바에 표시할 짧은 이름' },
          targetPath: { type: 'string', description: '단순 모듈 실행 시 경로 (pipeline 미사용 시에만)' },
          inputData: { type: 'object', description: 'targetPath 단일 실행용 입력. pipeline을 쓸 때는 이 필드 사용 금지 — 각 step의 inputData에 넣어라.', additionalProperties: true },
          pipeline: { type: 'array', description: '복합 작업 파이프라인. 각 step은 자체 inputData를 가져야 한다.', items: PIPELINE_STEP_SCHEMA },
          cronTime: { type: 'string', description: '반복 크론 표현식 (예: "0 9 * * *"). 주식 관련 스케줄은 평일 한정 "1-5" 요일 지정 필수.' },
          runAt: { type: 'string', description: '1회 실행 시각 (ISO 8601)' },
          delaySec: { type: 'number', description: 'N초 후 실행' },
          startAt: { type: 'string', description: '시작 시각 (ISO 8601)' },
          endAt: { type: 'string', description: '종료 시각 (ISO 8601)' },
          oneShot: { type: 'boolean', description: '첫 성공 시 자동 취소. 가격 알림 같은 "조건 충족 후 1회만" 케이스는 반드시 true. CONDITION 스텝 미충족 시에는 취소 안 되고 다음 주기에 재시도.' },
          executionMode: {
            type: 'string',
            enum: ['pipeline', 'agent'],
            description: '실행 모드 — 트리거 시 처리 방식 결정. pipeline (기본) = 미리 짠 step 흐름 결정적 실행 (askText 단발, 싸고 결정적). 단순 시세 조회·임계값 알림·정해진 데이터 fetch+send. agent = 트리거 시 AI Function Calling 사이클로 agentPrompt 실행 (도구 자유 사용, 검색·검증·콘텐츠 생성 가능, 비용 ↑). 블로그·리포트·일정 정리·매번 다른 데이터 검증 필요한 콘텐츠. **선택 기준**: "step JSON 으로 결정적 표현 가능한가?" Yes → pipeline. No (검증·창작 필요) → agent. agent 사용 시 pipeline 필드 비우고 agentPrompt 작성.',
          },
          agentPrompt: {
            type: 'string',
            description: 'agent 모드 전용 — 트리거 시 AI 에 user message 로 전달할 자연어 instruction. 한국어 권장. 잡 목적·필요 데이터·출력 형식 명시. 예: "오늘 기준 한국 주식 시장 다음 주 (월~금) 주요 일정 정리. 한투 ksd-puboffer/ksd-dividend + naver-search 로 실제 일정 데이터 확보. 과거·미래 분간하고 hallucinate 금지. SAVE_PAGE stock/$dateYmd-weekly 로 발행, head 에 SEO 메타데이터 포함. 발행 결과 텔레그램 알림."',
          },
          runWhen: {
            type: 'object',
            description: '발화 전 조건 체크 — 미충족 시 이번 발화 skip (실패 아님). 휴장일 enumerate 하드코딩 금지 — API 호출로 동적 판단.',
            required: ['check', 'field', 'op'],
            properties: {
              check: {
                type: 'object',
                description: '체크용 sysmod 호출. 결과를 field/op/value 로 평가.',
                required: ['sysmod', 'action'],
                properties: {
                  sysmod: { type: 'string', description: 'sysmod 이름 (예: korea-invest)' },
                  action: { type: 'string', description: '모듈 action (예: is-business-day)' },
                  inputData: { type: 'object', description: '추가 입력', additionalProperties: true },
                },
              },
              field: { type: 'string', description: '결과 필드 경로 ($prev.isBusinessDay 등)' },
              op: { type: 'string', description: '비교 연산자', enum: ['==', '!=', '<', '<=', '>', '>=', 'includes', 'not_includes', 'exists', 'not_exists'] },
              value: { type: 'string', description: '비교 값 (op 가 exists/not_exists 면 생략)' },
            },
          },
          retry: {
            type: 'object',
            description: '자동 retry 정책 (timeout·rate limit·503 등 일시 실패 복구). 멱등 도구만 사용 — 매수 주문 같은 부작용 도구는 retry 금지.',
            required: ['count'],
            properties: {
              count: { type: 'number', description: 'retry 횟수 (1~5 권장, 0 = retry X)' },
              delayMs: { type: 'number', description: 'retry 간격 ms (기본 30000)' },
            },
          },
          notify: {
            type: 'object',
            description: '결과 알림 hook — pipeline step 으로 분리하지 말고 이 필드 사용. ScheduleManager 가 발화 결과 단일 source 에서 발사. retry 모두 소진 후 최종 상태로만 onError 발동.',
            properties: {
              onSuccess: {
                type: 'object',
                required: ['sysmod'],
                properties: {
                  sysmod: { type: 'string', description: '알림 sysmod (예: telegram, kakao-talk)' },
                  chatId: { type: 'string', description: '대상 chat ID (sysmod 별 의미)' },
                  template: { type: 'string', description: '메시지 템플릿. 변수: {title} {jobId} {durationMs} {error}' },
                },
              },
              onError: {
                type: 'object',
                required: ['sysmod'],
                properties: {
                  sysmod: { type: 'string' },
                  chatId: { type: 'string' },
                  template: { type: 'string' },
                },
              },
            },
          },
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
      name: 'run_cron_job',
      description: '기존 등록된 cron 잡을 즉시 1회 트리거. 정상 cron 발화와 동일 path (cron-logs 기록 + agent prelude 적용 + retry/notify 동작). 사용자가 "X 잡 한 번 실행해줘" 의뢰 시 list_tasks 로 jobId 찾고 호출. save_page·schedule_task 직접 호출하지 마라 — 그건 cron 우회라 cron-logs 안 박히고 prelude 미적용.',
      parameters: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string', description: '실행할 cron 잡 ID' },
        },
      },
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
          pipeline: { type: 'array', description: '실행할 파이프라인 단계 배열', items: PIPELINE_STEP_SCHEMA },
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
    ...RENDER_TOOLS,
    {
      name: 'render_iframe',
      description: '한 섹션용 iframe 위젯 — **마지막 수단**. 다음은 모두 전용 도구 있음 → render_iframe 쓰면 안 됨: 지도(render_map) / 다이어그램(render_diagram, mermaid) / 수식(render_math, KaTeX) / 코드(render_code, hljs) / 슬라이드(render_slideshow) / Lottie 애니메이션(render_lottie) / 네트워크 그래프(render_network) / 표·차트·리스트·헤더·텍스트·이미지 (전용 render_*). render_iframe 은 d3 자유 시각화·threejs 3D·p5 스케치·echarts·animejs 같이 전용 도구 없는 케이스만. **iframe 안에서는 AdSense 광고 게재·Googlebot 인덱싱 모두 차단되므로 페이지 본문 전체를 이걸로 만들면 광고 수익·검색 노출 0**. CDN 라이브러리는 dependencies 배열로 선언만 — Frontend 가 자동 합성. <script src="..."> 태그 직접 박지 마라.',
      parameters: {
        type: 'object',
        required: ['html'],
        properties: {
          html: { type: 'string', description: '렌더링할 HTML body 내용 (외부 CDN <script>/<link> 태그 X — dependencies 배열로 선언만)' },
          height: { type: 'string', description: 'iframe 높이 (기본 400px). 예: "500px", "60vh"' },
          dependencies: {
            type: 'array',
            description: '사용할 CDN 라이브러리 키. Frontend HtmlComp 가 lib/cdn-libraries.ts 카탈로그 보고 <script>/<link> 자동 합성 후 iframe head 에 주입. leaflet/mermaid/katex/hljs/swiper/lottie/cytoscape 는 전용 컴포넌트로 흡수되어 enum 에서 제외 — 해당 라이브러리는 render_map/render_diagram/render_math/render_code/render_slideshow/render_lottie/render_network 사용.',
            items: {
              type: 'string',
              enum: ['d3', 'threejs', 'animejs', 'tailwindcss', 'marked', 'mathjax', 'echarts', 'p5', 'datatables'],
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
          referenceImage: {
            type: 'object',
            description: 'image-to-image 변환용 참조 이미지 (선택). 사용자가 기존 이미지 변환 요청 시 사용. slug/url/base64 중 하나 지정. 자세한 가이드는 도구 description 참조.',
            properties: {
              slug: { type: 'string', description: '갤러리 미디어 slug (가장 흔한 케이스, search_media 결과의 slug 사용)' },
              url: { type: 'string', description: '미디어 URL (`/user/media/<slug>.<ext>`) 또는 외부 https URL' },
              base64: { type: 'string', description: 'base64 또는 data URI (`data:image/png;base64,...`) — 직접 첨부 base64 보유 시' },
            },
          },
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
- **이미지·첨부 참조** — "내가 올린 이미지", "방금 첨부한 사진", "위 그림", "이거 (이미지 가리킴)", "내가 보낸 짤", "전에 보낸 사진" 등. 현재 턴에 첨부 이미지가 없거나 보이지 않는데 사용자가 가리키면 **재첨부 요청 전에 반드시 먼저 호출** — 과거 턴에 [이미지 첨부] 인덱스로 잡힘. 그래도 못 찾으면 그때 사용자에게 재첨부 요청

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
      description: `갤러리 이미지 검색 — prompt·파일명·모델·**slug** 단어 매칭. AI 생성·사용자 업로드 모두.
사용 시점:
- "전에 만든 그 차트 이미지", "삼성 이미지 가져와줘" 같이 갤러리에서 특정 이미지 찾을 때.
- **사용자가 갤러리 slug 명시** ("갤러리에 있는 2026-04-28-0b1a", "X 이미지 변환해줘") — query 에 slug 일부 그대로 넣으면 정확 매칭됨. **이 경우 image_gen 호출 전에 반드시 먼저 search_media** — 사용자가 기존 자산 가리키는데 새로 생성하면 안 됨.
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
    // ── 메모리 시스템 — Entity tier (Phase 1 of 4-tier memory) ────────────────
    // 단기 대화 (search_history) 와 별도 — 종목·인물·프로젝트 단위로 정제된 사실 누적.
    // 자동매매·블로그 운영 깊어질수록 진짜 가치 폭발. 사용자가 "삼성전자 1주 전 추천 결과는?"
    // 같은 질의 → search_entity_facts 로 직접 답.
    {
      name: 'save_entity',
      description: `메모리 시스템 — Entity (추적 대상) 저장.
종목·인물·프로젝트·이벤트·개념 등 모든 추적 대상이 entity. name+type 으로 upsert (같은
이름·타입 박으면 alias·metadata 업데이트만, 새 row X).

**호출 시점:**
- 사용자가 새 종목·인물·프로젝트 처음 언급 → 자동 등록 (예: "삼성전자 추천해줘" → save_entity(name='삼성전자', type='stock', metadata={ticker:'005930'}))
- 기존 entity 의 별칭·메타 추가 (예: alias '삼전' / ticker / 카테고리)

**type 자유 분류 (도구별 enum X)**: stock / company / person / project / concept / event / asset / topic 등 자유.

이후 save_entity_fact 로 그 entity 의 timeline 사실 추가.`,
      parameters: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', description: 'Entity 정식 명칭 (예: "삼성전자", "테슬라", "자동매매봇v1")' },
          type: { type: 'string', description: '자유 분류 — stock / company / person / project / concept / event 등' },
          aliases: { type: 'array', items: { type: 'string' }, description: '별칭 (예: ["005930", "삼전"]). 검색 시 통합 매칭.' },
          metadata: { type: 'object', additionalProperties: true, description: '자유 메타 (ticker / industry / sector / 부가정보 등). JSON 직렬화 가능.' },
        },
      },
    },
    {
      name: 'save_entity_fact',
      description: `메모리 시스템 — Entity 에 fact (시간 stamped 사실) link.
대화 끝나도 보존되는 정제된 사실. AI 가 사용자 발화에서 중요한 사실 발견 시 자율 호출.

**호출 시점:**
- 사용자가 종목 매수·매도·추천 명시 (예: "삼성전자 75000원 매수했어" → save_entity_fact(entityName='삼성전자', content='2026-04-15 75000원 매수', factType='transaction', occurredAt=ms epoch))
- 분석·리포트 결론 (예: "이번주 KOSPI 상승 가능성 높음" → factType='analysis')
- 자동매매 결과·이벤트 (예: "자동매매봇v1 첫 매수 성공" → factType='event')

**factType 자유 (enum X)**: recommendation / transaction / analysis / observation / event / report 등.

**entityName 또는 entityId 둘 중 하나 필수**: entityName 박으면 backend 가 자동으로 entity 조회·생성 (편의).
없으면 entityId 명시 (search_entities 로 ID 알아낸 후).

ttlDays 박으면 자동 만료. 영구 보존이면 미박음.`,
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          entityName: { type: 'string', description: 'Entity 이름 — 없으면 자동 생성 (type=entityType 또는 "concept" 기본).' },
          entityType: { type: 'string', description: 'entityName 으로 자동 생성 시 type. 미박힘 시 "concept".' },
          entityId: { type: 'integer', description: 'Entity ID 직접 지정 (search_entities 결과 활용). entityName 보다 우선.' },
          content: { type: 'string', description: '사실 본문 — 자연어 1-2 문장. 시간·수치 명시 권장.' },
          factType: { type: 'string', description: 'fact 종류 — recommendation / transaction / analysis / observation / event / report 등 자유.' },
          occurredAt: { type: 'string', description: '사실 발생 시각 — ISO 8601 형식 (예: "2026-04-15T09:00:00+09:00"). 미박힘 시 createdAt 사용.' },
          tags: { type: 'array', items: { type: 'string' }, description: '자유 태그 (다중 분류).' },
          ttlDays: { type: 'integer', description: '만료 일수 (기본 영구). 임시 메모는 30/90 박음.' },
        },
      },
    },
    {
      name: 'search_entities',
      description: `메모리 시스템 — Entity 검색.
**호출 시점:**
- 사용자가 종목·인물 언급 → 기존 entity 있는지 확인 (예: "삼성전자에 대해 정리해줘" → search_entities(query='삼성전자') → 매칭되면 fact timeline 가져와서 답변)
- "최근 추적한 종목들" / "관심 entity 목록" 같은 메타 질의

**옵션:**
- query: semantic search (임베딩 cosine + alias 매칭). 자연어 OK.
- type: type 별 필터.
- nameLike: 이름 부분 매칭 (case-insensitive).
- 미박힘 시 최근 활성 entity 순 (lastUpdated DESC).`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search 쿼리 (자연어).' },
          type: { type: 'string', description: 'Type 필터 (예: "stock" 만).' },
          nameLike: { type: 'string', description: '이름 부분 매칭.' },
          limit: { type: 'integer', description: '최대 결과 수 (기본 10).' },
        },
      },
    },
    {
      name: 'get_entity_timeline',
      description: `메모리 시스템 — Entity 의 fact timeline (시간순).
**호출 시점:**
- 사용자가 특정 종목·프로젝트 의 이력 질의 (예: "삼성전자 추천 이력 보여줘", "자동매매봇v1 결과 정리")
- AI 가 답변 생성 전에 entity 컨텍스트 자동 retrieve

entityName 또는 entityId 중 하나 필수. entityName 박으면 backend 가 조회 후 timeline 반환.
0건이면 "기록 없음" 응답 → 사용자에게 entity 자체 없음을 안내.`,
      parameters: {
        type: 'object',
        properties: {
          entityName: { type: 'string', description: 'Entity 이름 (검색 자동).' },
          entityId: { type: 'integer', description: 'Entity ID 직접 지정.' },
          limit: { type: 'integer', description: '최대 fact 수 (기본 20).' },
          orderBy: { type: 'string', enum: ['occurredAt', 'createdAt'], description: '정렬 — occurredAt (이벤트 발생 시각, 기본) / createdAt (저장 시각).' },
        },
      },
    },
    {
      name: 'search_entity_facts',
      description: `메모리 시스템 — Fact 횡단 검색 (entity 무관, semantic + filter).
**호출 시점:**
- "최근 매수 기록 보여줘" → search_entity_facts(factType='transaction')
- "지난 주 분석 결과들" → search_entity_facts(factType='analysis', occurredAfter=ms epoch)
- "추천 종목 중 매수 진행된 거" → search_entity_facts(query='매수', tags=['추천'])

자연어 query + factType / tags / 시간 범위 필터 조합 가능.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search 쿼리.' },
          entityName: { type: 'string', description: '특정 entity 의 fact 만 (자동 조회).' },
          entityId: { type: 'integer', description: 'Entity ID 직접 지정.' },
          factType: { type: 'string', description: 'Fact type 필터.' },
          tags: { type: 'array', items: { type: 'string' }, description: '태그 매칭 (ANY 일치).' },
          occurredAfter: { type: 'string', description: 'ISO 8601 — 이 시각 이후 발생 fact 만.' },
          occurredBefore: { type: 'string', description: 'ISO 8601 — 이 시각 이전 발생 fact 만.' },
          limit: { type: 'integer', description: '최대 결과 수 (기본 20).' },
        },
      },
    },
    // ── 메모리 시스템 — Episodic tier (Phase 2 of 4-tier memory) ───────────────
    // 시간순 사건 — 자동매매 / 페이지 발행 / cron / 도구 호출 / 사용자 액션 등.
    // Entity (영속 추적 대상) 와 m2m link. saveEvent 는 자동 훅 (Phase 2.5) 에서도 호출.
    {
      name: 'save_event',
      description: `메모리 시스템 — 시간순 사건 (Event) 저장.
Entity 의 fact 와 다름:
- entity_fact: entity 에 link 된 정제된 사실 (영속, "삼성전자: 매수 추천")
- event: 발생한 사건 (한 번의 트리거, "자동매매봇v1 매수 실행")

**호출 시점:**
- 자동매매 사건 (예: "삼성전자 매수 실행" → save_event(type='transaction', who='cron:abc'))
- 분석·리포트 발행 (예: "주간시황 페이지 발행" → save_event(type='page_publish'))
- 수동 사용자 액션 (예: "포트폴리오 리밸런싱 했어" → save_event(type='user_action'))
- 오류·알림 (type='alert' / 'error')

**type 자유 (enum X)**: cron_trigger / page_publish / transaction / image_gen /
tool_call / user_action / analysis / alert / error 등.

**entityNames 박으면 m2m link 자동** (각 이름별 자동 entity 조회·생성). entityIds 직접 박을 수도 있음.
context 는 자유 메타 (ticker / price / jobId / pageSlug / cost 등).`,
      parameters: {
        type: 'object',
        required: ['type', 'title'],
        properties: {
          type: { type: 'string', description: '자유 분류 — cron_trigger / page_publish / transaction / image_gen / tool_call / user_action / analysis / alert / error' },
          title: { type: 'string', description: '짧은 요약 — 자연어 1줄' },
          description: { type: 'string', description: '상세 (선택) — 결과·로그·근거' },
          who: { type: 'string', description: '발화자 — user / ai / cron:{jobId} / sysmod:{name} / manager:{name}' },
          context: { type: 'object', additionalProperties: true, description: '자유 메타 (JSON)' },
          occurredAt: { type: 'string', description: 'ISO 8601 — 발생 시각. 미박힘 시 현재' },
          entityNames: { type: 'array', items: { type: 'string' }, description: 'Link entity 이름 — 각자 자동 조회·생성' },
          entityIds: { type: 'array', items: { type: 'integer' }, description: 'Link entity ID 직접 (entityNames 보다 우선)' },
          ttlDays: { type: 'integer', description: '만료 일수 (기본 영구)' },
        },
      },
    },
    {
      name: 'search_events',
      description: `메모리 시스템 — Event 검색. semantic + 다중 필터.

**호출 시점:**
- "지난 주 매매 결과" → search_events(type='transaction', occurredAfter=ISO)
- "오늘 발행한 글" → search_events(type='page_publish', occurredAfter=오늘 00:00)
- "삼성전자 관련 모든 사건" → search_events(entityName='삼성전자')
- "실패한 cron 잡들" → search_events(type='cron_trigger', query='실패')

opts 다중 조합 가능. occurredAt DESC 기본 정렬.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Semantic search 쿼리 (자연어)' },
          type: { type: 'string', description: 'Type 필터' },
          who: { type: 'string', description: 'Who 필터 (예: cron:abc123 만)' },
          entityName: { type: 'string', description: '특정 entity 의 event 만 (자동 조회)' },
          entityId: { type: 'integer', description: 'Entity ID 직접' },
          occurredAfter: { type: 'string', description: 'ISO 8601 — 이 시각 이후 발생 event 만' },
          occurredBefore: { type: 'string', description: 'ISO 8601 — 이 시각 이전 발생 event 만' },
          limit: { type: 'integer', description: '최대 결과 수 (기본 50)' },
        },
      },
    },
    {
      name: 'consolidate_conversation',
      description: `메모리 시스템 — 현재 또는 지정 대화 의 entity / fact / event 자동 추출 + 저장 (Phase 4).
LLM 후처리 (AI assistant 모델, ~$0.001) 로 대화 정리 → 결과를 메모리에 누적.

**호출 시점:**
- 사용자가 "이 대화 정리해줘" / "메모리에 저장해줘" 명시 요청
- 긴 분석 turn 끝에 AI 자율 호출 (자동 누적 가치 큼)

**주의:** 대화당 1회 권장. 같은 대화 여러 번 호출하면 fact/event 중복 누적 (Phase 4.2 에서 중복
검출 추가). 현재는 단순 매번 새로 박음.

owner 미박힘 시 'admin' 폴백 (single-user 환경).`,
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '대화 ID. 미박힘 시 현재 turn 의 대화 (ctx 에서 자동).' },
          owner: { type: 'string', description: '대화 소유자 (기본 admin).' },
        },
      },
    },
    {
      name: 'list_recent_events',
      description: `메모리 시스템 — 최근 events (occurredAt DESC). 운영 모니터링 / 대시보드 용도.
"오늘 무슨 일들이 있었지?" / "최근 cron 실행 결과" 같은 timeline 질의.`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Type 필터' },
          who: { type: 'string', description: 'Who 필터' },
          limit: { type: 'integer', description: '기본 20, 최대 200' },
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
    // ──────────────────────────────────────────────────────────────────────────
    // Firebat 자율 메모리 — 사용자 룰·선호·도메인 컨텍스트 영속 저장.
    // data/firebat-memory/ 디렉토리. 매 turn 시스템 프롬프트에 index.md 자동 prepend.
    // 본문 (`<category>_<name>.md`) 은 AI 가 필요 판단 시 memory_read 호출.
    // ──────────────────────────────────────────────────────────────────────────
    {
      name: 'memory_save',
      description: `사용자 룰·선호·도메인 컨텍스트를 영속 저장 — 다음 대화에서 자동 로드되어 일관 적용.

**호출 시점** (자율 판단):
- 사용자가 명시 룰 설정 ("앞으로 X 회피해줘", "Y 패턴 따라줘", "Z는 절대 안 함")
- 사용자 선호 발견 ("나는 ~방식 선호", "한국어 존댓말로", "간결한 응답")
- 진행 중 프로젝트 컨텍스트 ("자동매매 1주차 운영 중", "X 종목 보유")
- 외부 자원 매핑 ("API 키는 Vault X", "회사 정보는 Y 시트")

**호출 금지**:
- 일회성 정보 (오늘 시세·뉴스 등 — 시간 지나면 stale)
- 코드·git 으로 추적 가능한 정보 (CLAUDE.md 또는 prompt-builder 룰 중복)
- 명백한 사실 (1+1=2, 한국 수도=서울 등)
- 사용자가 "기억해줘" 명시 안 한 임시 발언

**카테고리** (file 명에 prefix):
- user: 사용자 정보·역할·언어
- feedback: 행동 룰 ("X 회피", "Y 우선" 등)
- project: 진행 컨텍스트 ("자동매매 운영 중", "어떤 단계")
- reference: 외부 자원 매핑 (시트·API·도메인)`,
      parameters: {
        type: 'object',
        required: ['category', 'name', 'description', 'content'],
        properties: {
          category: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: '메모리 카테고리' },
          name: { type: 'string', description: '메모리 식별자 (snake_case, 예: "korean_only", "avoid_samsung", "auto_trade_running"). 같은 이름 재호출 시 기존 메모리 덮어씀.' },
          description: { type: 'string', description: '한 줄 요약 (인덱스에 표시. 미래 자기·다른 LLM 이 관련 여부 즉시 판단할 수 있게).' },
          content: { type: 'string', description: '메모리 본문 (마크다운). 룰의 사유·적용 시점·예외 케이스 명시.' },
        },
      },
    },
    {
      name: 'memory_read',
      description: '메모리 본문 read. 인덱스 description 보고 관련 룰이라 판단되면 본문 read 후 자세한 내용 파악.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: '메모리 식별자 (memory_save 시 박은 name).' },
        },
      },
    },
    {
      name: 'memory_list',
      description: '현재 저장된 메모리 인덱스 (전체 목록). 매 turn 시스템 프롬프트에 자동 prepend 되므로 일반적으로 명시 호출 불필요. 디버깅·검토 용.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'memory_delete',
      description: '메모리 영구 삭제. 사용자가 명시 요청 시 ("X 룰 잊어줘", "Y 메모리 삭제") 만 호출.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: '삭제할 메모리 식별자.' },
        },
      },
    },
    // ──────────────────────────────────────────────────────────────────────────
    // sysmod 결과 cache — 큰 응답(yfinance history/DART 공시 등)을 메인 context 안 박지 않고
    // cacheKey 받아 read/grep/aggregate. sysmod 가 cacheKey 반환하면 그 키로 다음 도구 호출.
    // ──────────────────────────────────────────────────────────────────────────
    {
      name: 'cache_read',
      description: `Cache 페이징 read — sysmod 가 반환한 cacheKey 로 일부 레코드만 추출.

**호출 시점**: sysmod 응답에 cacheKey 박혀있고 전체 데이터 필요할 때 (예: 10년 history 일별 시계열 2500행).

**호출 금지**:
- cacheKey 없는 응답 (records 직접 박혀있으면 그대로 사용)
- 작은 결과 (10행 미만 — 어차피 메인 응답에 박혀있음)`,
      parameters: {
        type: 'object',
        required: ['cacheKey'],
        properties: {
          cacheKey: { type: 'string', description: 'sysmod 응답의 cacheKey 필드 값.' },
          offset: { type: 'number', description: '시작 인덱스 (기본 0).' },
          limit: { type: 'number', description: '최대 반환 레코드 수 (기본 100).' },
          fields: { type: 'array', items: { type: 'string' }, description: '추출할 필드 목록 (선택, 미지정 시 전체 필드). 토큰 절감 — date/close 만 필요할 때 ["date","close"].' },
        },
      },
    },
    {
      name: 'cache_grep',
      description: `Cache 필터 — 특정 조건에 맞는 레코드만 추출. eq/ne/gt/gte/lt/lte/contains/in/regex 9 연산자.

**사용 예**:
- 종가 1만원 이상: cache_grep(cacheKey, {field:"close", op:"gte", value:10000})
- 종목명에 "삼성" 포함: cache_grep(cacheKey, {field:"name", op:"contains", value:"삼성"})
- 특정 sectors: cache_grep(cacheKey, {field:"sector", op:"in", value:["반도체","2차전지"]})

**전체 records 수 제한**: 결과 1000개 초과 시 truncated (limit 인자로 줄여서 호출).`,
      parameters: {
        type: 'object',
        required: ['cacheKey', 'query'],
        properties: {
          cacheKey: { type: 'string', description: 'sysmod 응답의 cacheKey.' },
          query: {
            type: 'object',
            required: ['field', 'op', 'value'],
            properties: {
              field: { type: 'string', description: '검사 대상 필드명.' },
              op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'regex'], description: '비교 연산자.' },
              value: { type: ['string', 'number', 'boolean', 'array'], description: '비교 값. eq/ne/gt/...=단일 값, in=배열 (예: ["반도체","2차전지"]), regex=문자열 패턴.' },
            },
            additionalProperties: false,
          },
          limit: { type: 'number', description: '최대 반환 레코드 수 (기본 100).' },
          fields: { type: 'array', items: { type: 'string' }, description: '추출할 필드 (선택).' },
        },
      },
    },
    {
      name: 'cache_aggregate',
      description: `Cache 집계 — avg/sum/min/max/count + 선택적 groupBy.

**사용 예**:
- 평균 종가: cache_aggregate(cacheKey, "avg", "close") → 숫자
- 섹터별 평균 시총: cache_aggregate(cacheKey, "avg", "marketCap", "sector") → {반도체: ..., 2차전지: ...}
- 최고가: cache_aggregate(cacheKey, "max", "high") → 숫자

**non-numeric 필드 + count 외 op**: 0 또는 null 반환 (필드 검증 자동).`,
      parameters: {
        type: 'object',
        required: ['cacheKey', 'op', 'field'],
        properties: {
          cacheKey: { type: 'string' },
          op: { type: 'string', enum: ['avg', 'sum', 'min', 'max', 'count'], description: '집계 연산.' },
          field: { type: 'string', description: '집계 대상 필드.' },
          by: { type: 'string', description: 'groupBy 필드 (선택). 미지정 시 전체 단일 값 반환.' },
        },
      },
    },
    {
      name: 'cache_drop',
      description: `Cache 명시 삭제 — 더 이상 필요 없는 cache 즉시 정리. TTL 5분 자동 만료되므로 일반적으로 호출 불필요. 큰 데이터 작업 끝났을 때 명시 호출 권장.`,
      parameters: {
        type: 'object',
        required: ['cacheKey'],
        properties: {
          cacheKey: { type: 'string' },
        },
      },
    },
    // ──────────────────────────────────────────────────────────────────────────
    // Sub-agent 병렬 — 큰 작업을 자체 conversation context 의 sub-agent 에 위임.
    // 메인 context 안 더럽힘 + 결과만 받음. 한 turn 안에 여러 spawn_subagent 호출 시 병렬 가능 (Step 2).
    // Vault 토글 'system:llm:sub-agent-enabled' = 'true' 일 때만 도구 노출 (API 비용 폭탄 방지).
    // ──────────────────────────────────────────────────────────────────────────
    {
      name: 'spawn_subagent',
      description: `큰 작업을 sub-agent 에 위임 — 메인 conversation context 안 더럽힘 + 결과만 받음.

**호출 시점**:
- "TQQQ 10년 백테스트", "Apple 분기 재무 분석" 같이 자체 도구 호출 다수 + 큰 결과 → sub-agent 에 prompt 전달
- 한 turn 안에 여러 종목·여러 분석을 동시에 → spawn_subagent N번 호출 = 병렬 처리 (Step 2 박힌 후)
- 큰 데이터 분석 (백테스트·재무 시계열·옵션 체인 등) — 메인 context 토큰 절감

**호출 금지**:
- 단순 1-2 step 작업 (어차피 메인 turn 으로 충분, 비용만 ↑)
- 자기 (spawn_subagent) 재귀 호출 (sub-agent 안에서 또 spawn_subagent — 무한 재귀 차단)
- 사용자 직접 응답 필요한 대화 (sub-agent 결과는 메인이 받아 종합)

**사용 예**:
- "TQQQ + Apple + Tesla 10년 백테스트 비교" → spawn_subagent 3번 호출 (각자 백테스트) → 메인이 결과 받아 종합 비교 페이지

**비용**: sub-agent 마다 별도 LLM 호출 (메인 + sub × N). 토글 OFF 면 도구 자체 미노출.`,
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: 'Sub-agent 가 받을 작업 지시. 자세한 컨텍스트 + 명확한 결과 요구. 메인 context 와 격리되므로 필요한 배경 모두 포함.' },
          taskType: { type: 'string', description: '작업 유형 라벨 (선택, 로깅 용). 예: "backtest", "financial-analysis", "code-review".' },
        },
      },
    },
  ];
}
