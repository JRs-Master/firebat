/**
 * Pending Tools — 승인 필요 도구의 대기 저장소
 *
 * AI가 write_file(덮어쓰기) / save_page(덮어쓰기) / delete_file / delete_page / schedule_task
 * 호출 시 즉시 실행하지 않고 여기 저장. 사용자 승인 시 commit으로 실제 실행.
 */

const PENDING_EXPIRE_MS = 10 * 60_000; // 10분
const MAX_SIZE = 100;

export type PendingTool = {
  planId: string;
  name: string; // tool name (write_file, delete_file, schedule_task, ...)
  args: Record<string, unknown>;
  summary: string; // UI 표시용 한 줄 요약
  createdAt: number;
};

const store = new Map<string, PendingTool>();

function cleanup() {
  const now = Date.now();
  for (const [id, p] of store) {
    if (now - p.createdAt > PENDING_EXPIRE_MS) store.delete(id);
  }
}
setInterval(cleanup, 60_000);

export function createPending(name: string, args: Record<string, unknown>, summary: string): string {
  if (store.size >= MAX_SIZE) {
    let oldest: string | null = null;
    let ts = Infinity;
    for (const [id, p] of store) {
      if (p.createdAt < ts) { oldest = id; ts = p.createdAt; }
    }
    if (oldest) store.delete(oldest);
  }
  const planId = 'plan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  store.set(planId, { planId, name, args, summary, createdAt: Date.now() });
  return planId;
}

export function getPending(planId: string): PendingTool | null {
  return store.get(planId) ?? null;
}

export function consumePending(planId: string): PendingTool | null {
  const p = store.get(planId);
  if (!p) return null;
  store.delete(planId);
  return p;
}

export function rejectPending(planId: string): boolean {
  return store.delete(planId);
}
