/**
 * Plan 캐시 — corrId별 원본 plan 저장
 *
 * stream/route.ts에서 plan 수립 후 저장,
 * execute/route.ts에서 corrId로 조회하여 실행.
 * 프론트엔드에는 요약 정보만 전송하고, 실행 시 원본 plan 사용.
 */

import { PLAN_CACHE_EXPIRE_MS, PLAN_CACHE_MAX_SIZE } from '../../../infra/config';

const planStore = new Map<string, { plan: any; createdAt: number }>();

// 10분 이상 된 캐시 자동 정리
const EXPIRE_MS = PLAN_CACHE_EXPIRE_MS;
const MAX_CACHE_SIZE = PLAN_CACHE_MAX_SIZE;

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of planStore) {
    if (now - entry.createdAt > EXPIRE_MS) planStore.delete(key);
  }
}

// 1분마다 자동 정리
setInterval(cleanup, 60_000);

export function storePlan(corrId: string, plan: any) {
  // 크기 제한 — 가장 오래된 항목 제거
  if (planStore.size >= MAX_CACHE_SIZE) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of planStore) {
      if (entry.createdAt < oldestTime) {
        oldest = key;
        oldestTime = entry.createdAt;
      }
    }
    if (oldest) planStore.delete(oldest);
  }
  planStore.set(corrId, { plan, createdAt: Date.now() });
}

export function retrievePlan(corrId: string): any | null {
  const entry = planStore.get(corrId);
  if (!entry) return null;
  planStore.delete(corrId); // 1회용
  return entry.plan;
}
