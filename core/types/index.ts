import { z } from 'zod';
import type { ResultMeta } from '../ports';

/**
 * AI 요원이 Core에게 제출할 수 있는 모든 행동 규격 (Firebat Action)
 *
 * any 사용 금지 — z.any() 대신 z.unknown() 또는 구체 스키마 사용
 */

// 모든 액션 공통 필드
const actionBase = { description: z.string().default('').describe('사용자에게 보여줄 한국어 단계 설명 (예: "날씨 API 모듈을 생성합니다")') };

// ── 파이프라인 단계 스키마 (Discriminated Union) ─────────────────────────

const ExecuteStepSchema = z.object({
  type: z.literal('EXECUTE'),
  description: z.string().optional(),
  path: z.string(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const McpCallStepSchema = z.object({
  type: z.literal('MCP_CALL'),
  description: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const NetworkRequestStepSchema = z.object({
  type: z.literal('NETWORK_REQUEST'),
  description: z.string().optional(),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const LlmTransformStepSchema = z.object({
  type: z.literal('LLM_TRANSFORM'),
  description: z.string().optional(),
  instruction: z.string(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const ConditionStepSchema = z.object({
  type: z.literal('CONDITION'),
  description: z.string().optional(),
  field: z.string().describe('검사 대상 ($prev, $prev.price 등)'),
  op: z.enum(['==', '!=', '<', '<=', '>', '>=', 'includes', 'not_includes', 'exists', 'not_exists']).describe('비교 연산자'),
  value: z.unknown().optional().describe('비교 값 (exists/not_exists는 불필요)'),
});

export const PipelineStepSchema = z.discriminatedUnion('type', [
  ExecuteStepSchema,
  McpCallStepSchema,
  NetworkRequestStepSchema,
  LlmTransformStepSchema,
  ConditionStepSchema,
]);

// ── FirebatAction (Discriminated Union) ─────────────────────────────────

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
    type: z.literal('EXECUTE'),
    path: z.string().describe('실행할 모듈 경로 (예: user/modules/web-search/index.js)'),
    inputData: z.record(z.string(), z.unknown()).optional().describe('모듈에 전달할 입력 데이터'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('NETWORK_REQUEST'),
    url: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    headers: z.record(z.string(), z.string()).optional()
  }),
  z.object({
    ...actionBase,
    type: z.literal('SCHEDULE_TASK'),
    title: z.string().default('').describe('사이드바에 표시할 짧은 이름 (예: "카톡 전송", "날씨 알림")'),
    targetPath: z.string().optional().describe('실행할 모듈 경로 (단순 모듈 실행 시)'),
    inputData: z.record(z.string(), z.unknown()).optional().describe('모듈에 전달할 입력 데이터 (targetPath 사용 시)'),
    pipeline: z.array(PipelineStepSchema).optional().describe('복합 작업 파이프라인. targetPath 대신 사용'),
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
    query: z.string().describe('실행할 SQL 쿼리 문자열'),
    params: z.array(z.unknown()).optional().describe('SQL 바인딩 파라미터'),
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
    spec: z.record(z.string(), z.unknown()).describe('PageSpec JSON 객체 (slug, head, body 포함)')
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
    pipeline: z.array(PipelineStepSchema).describe('즉시 실행할 파이프라인 단계 배열'),
  }),
  z.object({
    ...actionBase,
    type: z.literal('MCP_CALL'),
    server: z.string().describe('MCP 서버 이름 (예: gmail, slack)'),
    tool: z.string().describe('실행할 도구 이름'),
    arguments: z.record(z.string(), z.unknown()).optional().describe('도구에 전달할 인자'),
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
  data: z.record(z.string(), z.unknown()).optional().describe('success가 true일 때 반환되는 결과값'),
  error: z.string().optional().describe('success가 false일 때 보고할 시스템 에러 메시지'),
  code: z.string().optional().describe('에러 식별자용 코드')
});
export type ModuleOutput = z.infer<typeof ModuleOutputSchema>;

/**
 * [Phase 2] Infra -> Core
 * 프레임워크가 절대로 죽지 않도록, 모든 Infra Port가 Core에게 응답을 포장해서 주는 방패 객체
 *
 * T는 반드시 구체적 타입으로 지정 — InfraResult<any> 금지
 */
export interface InfraResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  meta?: ResultMeta;
}

/**
 * [Phase 3] Core -> UI (App)
 * 코어가 모든 로직/에이전트 판단을 끝내고 프론트엔드로 내보내는 최종 결과물 포맷
 *
 * T는 반드시 구체적 타입으로 지정 — CoreResult<any> 금지
 */
export interface CoreResult<T = unknown> {
  success: boolean;
  thoughts?: string;
  reply?: string;
  executedActions: string[];
  data?: T;
  error?: string;
}
