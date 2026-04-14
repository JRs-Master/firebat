import { z } from 'zod';

/**
 * AI 요원이 Core에게 제출할 수 있는 모든 행동 규격 (Firebat Action)
 */
// 모든 액션 공통 필드
const actionBase = { description: z.string().default('').describe('사용자에게 보여줄 한국어 단계 설명 (예: "날씨 API 모듈을 생성합니다")') };

export const FirebatActionSchema = z.discriminatedUnion('type', [
  z.object({
    ...actionBase,
    type: z.literal('WRITE_FILE'),
    path: z.string().describe('저장할 파일의 대상 상대 경로 (예: user/modules/test.ts)'),
    content: z.string().describe('파일에 작성될 전체 텍스트 내용')
  }),
  z.object({
    ...actionBase,
    type: z.literal('READ_FILE'),
    path: z.string().describe('읽어올 파일의 상대 경로'),
    lines: z.number().optional().describe('파일이 너무 클 경우 처음 N줄만 읽어옴')
  }),
  z.object({
    ...actionBase,
    type: z.literal('LIST_DIR'),
    path: z.string().describe('목록을 조회할 폴더 경로 (예: user/modules)')
  }),
  z.object({
    ...actionBase,
    type: z.literal('APPEND_FILE'),
    path: z.string(),
    content: z.string()
  }),
  z.object({
    ...actionBase,
    type: z.literal('DELETE_FILE'),
    path: z.string().describe('삭제할 파일 또는 폴더 경로 (폴더 지정 시 지정된 앱/프로젝트 데이터가 통째로 삭제됨)')
  }),
  z.object({
    ...actionBase,
    type: z.literal('TEST_RUN'),
    path: z.string().describe('실행할 모듈 경로 (예: user/modules/web-search/index.js)'),
    mockData: z.any().optional().describe('주입할 임의의 테스트 파라미터')
  }),
  z.object({
    ...actionBase,
    type: z.literal('NETWORK_REQUEST'),
    url: z.string(),
    method: z.string().default('GET'),
    body: z.any().optional(),
    headers: z.record(z.string(), z.string()).optional()
  }),
  z.object({
    ...actionBase,
    type: z.literal('SCHEDULE_TASK'),
    title: z.string().default('').describe('사이드바에 표시할 짧은 이름 (예: "카톡 전송", "날씨 알림")'),
    description: z.string().optional().describe('상세 스케줄 설명 (예: "5분 후 메일 요약해서 카톡 전송")'),
    targetPath: z.string().optional().describe('실행할 모듈 경로 (단순 모듈 실행 시)'),
    inputData: z.any().optional().describe('모듈에 전달할 입력 데이터 (targetPath 사용 시)'),
    pipeline: z.array(z.object({
      type: z.string().describe('단계 타입: TEST_RUN | MCP_CALL | NETWORK_REQUEST | LLM_TRANSFORM'),
      path: z.string().optional().describe('TEST_RUN 시 모듈 경로'),
      server: z.string().optional().describe('MCP_CALL 시 서버명'),
      tool: z.string().optional().describe('MCP_CALL 시 도구명'),
      arguments: z.record(z.string(), z.any()).optional().describe('MCP_CALL 시 인자'),
      url: z.string().optional().describe('NETWORK_REQUEST 시 URL'),
      method: z.string().optional().describe('NETWORK_REQUEST 시 HTTP 메서드'),
      body: z.any().optional().describe('NETWORK_REQUEST 시 요청 body'),
      headers: z.record(z.string(), z.string()).optional().describe('NETWORK_REQUEST 시 헤더'),
      instruction: z.string().optional().describe('LLM_TRANSFORM 시 변환 지시문'),
      inputData: z.any().optional().describe('이 단계에 주입할 고정 입력. 생략 시 이전 단계 결과가 자동 전달'),
      inputMap: z.record(z.string(), z.any()).optional().describe('입력 매핑. "$prev"는 이전 단계 결과로 치환'),
    })).optional().describe('복합 작업 파이프라인. targetPath 대신 사용'),
    cronTime: z.string().optional().describe('반복 주기 (크론 표현식). 예: "0 9 * * *" = 매일 9시'),
    runAt: z.string().optional().describe('특정 시각 1회 실행 (ISO 8601). 예: "2026-04-15T09:00:00"'),
    delaySec: z.number().optional().describe('N초 후 1회 실행. 예: 300 = 5분 후'),
    startAt: z.string().optional().describe('스케줄 시작 시각 (ISO 8601). 이 시각 이전에는 실행하지 않음'),
    endAt: z.string().optional().describe('스케줄 종료 시각 (ISO 8601). 이 시각 이후 자동 해제'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('CANCEL_TASK'),
    jobId: z.string().describe('해제할 잡 ID')
  }),
  z.object({
    ...actionBase,
    type: z.literal('LIST_TASKS'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('DATABASE_QUERY'),
    query: z.any().describe('실행할 쿼리 (Postgres용 SQL 문자열 또는 MongoDB용 JSON 객체 모두 허용)'),
    params: z.any().optional().describe('매핑할 추가 파라미터나 설정 옵션')
  }),
  z.object({
    ...actionBase,
    type: z.literal('OPEN_URL'),
    url: z.string().describe('새 탭에서 열 URL 또는 경로 (예: /bmi-calculator)')
  }),
  z.object({
    ...actionBase,
    type: z.literal('SAVE_PAGE'),
    slug: z.string().describe('페이지 URL 슬러그 (kebab-case, 예: bmi-calculator)'),
    spec: z.any().describe('PageSpec JSON 객체 (slug, head, body 포함)')
  }),
  z.object({
    ...actionBase,
    type: z.literal('DELETE_PAGE'),
    slug: z.string().describe('삭제할 페이지의 slug')
  }),
  z.object({
    ...actionBase,
    type: z.literal('LIST_PAGES'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('REQUEST_SECRET'),
    name: z.string().describe('시크릿 키 이름 (영문 kebab-case, 예: openweathermap-api-key)'),
    prompt: z.string().describe('사용자에게 보여줄 안내 메시지 (예: "OpenWeatherMap API 키를 입력해주세요")'),
    helpUrl: z.string().optional().describe('API 키 발급 안내 URL (선택)'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('SET_SECRET'),
    name: z.string().describe('저장할 시크릿 키 이름'),
    value: z.string().describe('시크릿 값'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('RUN_TASK'),
    pipeline: z.array(z.object({
      type: z.string().describe('단계 타입: TEST_RUN | MCP_CALL | NETWORK_REQUEST | LLM_TRANSFORM'),
      path: z.string().optional().describe('TEST_RUN 시 모듈 경로'),
      server: z.string().optional().describe('MCP_CALL 시 서버명'),
      tool: z.string().optional().describe('MCP_CALL 시 도구명'),
      arguments: z.record(z.string(), z.any()).optional().describe('MCP_CALL 시 인자'),
      url: z.string().optional().describe('NETWORK_REQUEST 시 URL'),
      method: z.string().optional().describe('NETWORK_REQUEST 시 HTTP 메서드'),
      body: z.any().optional().describe('NETWORK_REQUEST 시 요청 body'),
      headers: z.record(z.string(), z.string()).optional().describe('NETWORK_REQUEST 시 헤더'),
      instruction: z.string().optional().describe('LLM_TRANSFORM 시 변환 지시문'),
      inputData: z.any().optional().describe('이 단계에 주입할 고정 입력. 생략 시 이전 단계 결과가 자동 전달'),
      inputMap: z.record(z.string(), z.any()).optional().describe('입력 매핑. "$prev"는 이전 단계 결과로 치환'),
    })).describe('즉시 실행할 파이프라인 단계 배열'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('MCP_CALL'),
    server: z.string().describe('MCP 서버 이름 (예: gmail, slack)'),
    tool: z.string().describe('실행할 도구 이름'),
    arguments: z.record(z.string(), z.any()).optional().describe('도구에 전달할 인자'),
  })
]);

/**
 * LLM이 지시를 받고 최종적으로 반환해야 하는 거시적 계획서 규약 (Firebat Plan JSON)
 */
export const FirebatPlanSchema = z.object({
  thoughts: z.string().describe('사용자 지시를 어떻게 분석했고, 무슨 행동을 왜 취할 것인지에 대한 내부 사고 체인.'),
  reply: z.string().describe('사용자에게 직접 전달할 최종 답변(마크다운 지원). 작업 내역 요약, 질문에 대한 대답, 혹은 인사 등.'),
  actions: z.array(FirebatActionSchema).default([]).describe('판결에 따라 실제로 수행할 물리적 액션들의 나열.'),
  suggestions: z.array(z.union([
    z.string(),
    z.object({
      type: z.literal('input'),
      label: z.string().describe('버튼에 표시할 텍스트 (예: "다른 시간 지정")'),
      placeholder: z.string().optional().describe('입력 필드 힌트 (예: "오후 2시 30분")'),
    }),
    z.object({
      type: z.literal('toggle'),
      label: z.string().describe('그룹 제목 (예: "기능 선택")'),
      options: z.array(z.string()).describe('토글 옵션 목록'),
      defaults: z.array(z.string()).optional().describe('기본 선택된 옵션 목록'),
    }),
  ])).default([]).describe('사용자에게 제시할 선택지. 문자열=버튼, {type:"input"}=텍스트 입력, {type:"toggle"}=다중 선택 토글.')
});

export type FirebatAction = z.infer<typeof FirebatActionSchema>;
export type FirebatPlan = z.infer<typeof FirebatPlanSchema>;


// ============================================================================
// 통신 3단계 프로토콜 (Module -> Infra -> Core -> UI)
// ============================================================================

/**
 * [Phase 1] Module -> Infra
 * 자식 모듈(Sandbox 내부 스크립트)이 실행 결과를 stdout에 뱉을 때 사용하는 규약
 */
export const ModuleOutputSchema = z.object({
  success: z.boolean(),
  data: z.any().optional().describe('success가 true일 때 반환되는 결과값'),
  error: z.string().optional().describe('success가 false일 때 보고할 시스템 에러 메시지'),
  code: z.string().optional().describe('에러 식별자용 코드')
});
export type ModuleOutput = z.infer<typeof ModuleOutputSchema>;

/**
 * [Phase 2] Infra -> Core
 * 프레임워크가 절대로 죽지 않도록, 모든 Infra Port가 Core에게 응답을 포장해서 주는 방패 객체
 */
export interface InfraResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  meta?: any; // 실행 시간, 캐시 적중 여부 등 추가 정보
}

/**
 * [Phase 3] Core -> UI (App)
 * 코어가 모든 로직/에이전트 판단을 끝내고 프론트엔드로 내보내는 최종 결과물 포맷
 */
export interface CoreResult<T = any> {
  success: boolean;
  thoughts?: string;       // AI가 어떤 판단으로 이 결론에 도달했는지
  reply?: string;          // 사용자에게 보여줄 친절한 최종 안내 메시지
  executedActions: string[]; // 수행된 작업들 목록 (예: ["WRITE_FILE", "TEST_RUN"])
  data?: T;                // 프론트엔드 화면에 꽂아줄 최종 비즈니스 데이터
  error?: string;          // 전체 실패 시 에러 사유
}
