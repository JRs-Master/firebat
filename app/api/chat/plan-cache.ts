/**
 * Plan 캐시 — corrId별 원본 plan 저장
 *
 * stream/route.ts에서 plan 수립 후 저장,
 * execute/route.ts에서 corrId로 조회하여 실행.
 * 프론트엔드에는 요약 정보만 전송하고, 실행 시 원본 plan 사용.
 */

const planStore = new Map<string, { plan: any; createdAt: number }>();

// 10분 이상 된 캐시 자동 정리
const EXPIRE_MS = 10 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of planStore) {
    if (now - entry.createdAt > EXPIRE_MS) planStore.delete(key);
  }
}

export function storePlan(corrId: string, plan: any) {
  cleanup();
  planStore.set(corrId, { plan, createdAt: Date.now() });
}

export function retrievePlan(corrId: string): any | null {
  const entry = planStore.get(corrId);
  if (!entry) return null;
  planStore.delete(corrId); // 1회용
  return entry.plan;
}
