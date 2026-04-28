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
          spec: { type: 'object', description: 'PageSpec — { head:{title,description,keywords,og}, project, status:"published", body: render_* 컴포넌트 객체 배열 }. body 는 반드시 [{type:"Header",props:{...}}, {type:"Text",props:{...}}, {type:"Table",props:{...}}, ...] 형태 여러 컴포넌트. **단일 Html 블록 1개로 통째 만들면 페이지가 iframe 안에 들어가 AdSense 광고·SEO 인덱싱 모두 차단**. Html 블록은 Leaflet/Mermaid/KaTeX 같은 특수 시각화 한 섹션에만 사용.', additionalProperties: true },
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
      description: '한 섹션용 iframe 위젯 — 결과가 sandbox iframe srcDoc 안에서 렌더됨 (페이지 본문 통째 아님). 지도/다이어그램/애니메이션/수학식 같은 CDN 라이브러리 시각화 한 섹션에만 사용. **iframe 안에서는 AdSense 광고 게재·Googlebot 인덱싱 모두 차단되므로 페이지 본문 전체를 이걸로 만들면 광고 수익·검색 노출 0**. 표·차트·리스트·헤더·텍스트·이미지 등은 render_table / render_chart / render_list / render_header / render_text / render_image 등 전용 도구 사용. CDN 라이브러리는 dependencies 배열로 선언만 — Frontend 가 자동 합성. <script src="..."> 태그 직접 박지 마라.',
      parameters: {
        type: 'object',
        required: ['html'],
        properties: {
          html: { type: 'string', description: '렌더링할 HTML body 내용 (외부 CDN <script>/<link> 태그 X — dependencies 배열로 선언만)' },
          height: { type: 'string', description: 'iframe 높이 (기본 400px). 예: "500px", "60vh"' },
          dependencies: {
            type: 'array',
            description: '사용할 CDN 라이브러리 키. Frontend HtmlComp 가 lib/cdn-libraries.ts 카탈로그 보고 <script>/<link> 자동 합성 후 iframe head 에 주입.',
            items: {
              type: 'string',
              enum: ['d3', 'mermaid', 'leaflet', 'threejs', 'animejs', 'tailwindcss', 'katex', 'hljs', 'marked', 'cytoscape', 'mathjax', 'p5', 'lottie', 'datatables', 'swiper', 'echarts'],
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
