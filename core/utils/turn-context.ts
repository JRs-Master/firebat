/**
 * Turn Context — AsyncLocalStorage 로 한 turn 의 메타데이터를 비동기 호출 체인 따라 전파.
 *
 * 왜 필요한가:
 *   AiManager 가 instance variable (_currentTurnPrevUserQuery) 로 turn-scope 데이터 보관
 *   → 동시 요청 (사용자 여러 탭·여러 cron 동시 발화) 시 race condition. 한 turn 의
 *   값이 다른 turn 의 tool handler 에 누설되어 컨텍스트 뒤섞임.
 *
 * 해법:
 *   processWithTools 시작 시 turnContext.run({prevUserQuery, ...}, async () => {...})
 *   안에서 모든 도구 호출. tool handler 는 turnContext.getStore() 로 자기 turn 의
 *   값만 읽음 — Node.js async_hooks 가 자동으로 호출 chain 따라 전파.
 *
 * 적용 범위: AiManager.processWithTools 1턴 + 그 안에서 호출되는 모든 도구 handler.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TurnContext {
  /** 직전 user 발화 — search_history 의 enriched query 보강용 */
  prevUserQuery?: string;
  /** 현재 turn 의 corrId — 로그 추적 */
  corrId?: string;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();

/** 현재 turn context 조회. processWithTools 외부에서 호출하면 undefined. */
export function getTurnContext(): TurnContext | undefined {
  return turnContext.getStore();
}
