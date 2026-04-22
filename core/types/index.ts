import { z } from 'zod';
import type { ResultMeta } from '../ports';

/**
 * 레거시 FirebatActionSchema / FirebatPlanSchema / PipelineStepSchema (Zod) 는
 * v0.1, 2026-04-22 삭제됨. Function Calling 네이티브 function_call 객체로 완전 이관.
 * Pipeline step TypeScript 타입 (PipelineStep) 은 core/ports/index.ts 에 정의되어 있음.
 */


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
