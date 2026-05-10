/**
 * Pending Tools — 승인 필요 도구의 대기 저장소
 *
 * AI가 write_file(덮어쓰기) / save_page(덮어쓰기) / delete_file / delete_page / schedule_task
 * 호출 시 즉시 실행하지 않고 여기 저장. 사용자 승인 시 commit으로 실제 실행.
 *
 * **파일 영속화** (v0.1, 2026-04-27): plan-store.ts 와 동일 패턴.
 * - PM2 재시작·서버 리빌드 후에도 planId 유효 → 사용자가 승인 누르면 정상 commit.
 * - 영속 안 하면: 리빌드 후 재진입 시 메모리 store 빔 → /api/plan/commit 404 "Plan not found or expired"
 * - in-memory Map 1차 캐시 + `data/pending-tools.json` 영속. 부팅 시 자동 로드.
 * - getPending 도 파일 폴백 (Next.js 번들 분리 / multi-isolate 안전망).
 */

import fs from 'fs';
import path from 'path';

const PENDING_EXPIRE_MS = 10 * 60_000; // 10분
const MAX_SIZE = 100;
const STORE_FILE = path.resolve(process.env.FIREBAT_DATA_DIR || 'data', 'pending-tools.json');

export type PendingTool = {
  planId: string;
  name: string; // tool name (write_file, delete_file, schedule_task, ...)
  args: Record<string, unknown>;
  summary: string; // UI 표시용 한 줄 요약
  createdAt: number;
};

const store = new Map<string, PendingTool>();

// 부팅 시 파일에서 복원 (PM2 재시작 후에도 pending 유지)
(function loadFromFile() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const arr = JSON.parse(raw) as PendingTool[];
    const now = Date.now();
    for (const p of arr) {
      if (p?.planId && now - p.createdAt <= PENDING_EXPIRE_MS) store.set(p.planId, p);
    }
  } catch { /* 파일 손상 시 무시, 빈 store 로 시작 */ }
})();

function flush() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(Array.from(store.values()), null, 2));
  } catch { /* 파일 쓰기 실패는 in-memory 만 유지 */ }
}

function cleanup() {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of store) {
    if (now - p.createdAt > PENDING_EXPIRE_MS) { store.delete(id); changed = true; }
  }
  if (changed) flush();
}
const cleanupInterval = setInterval(cleanup, 60_000);
cleanupInterval.unref?.();

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
  flush();
  return planId;
}

export function getPending(planId: string): PendingTool | null {
  // 1차: in-memory 캐시
  const hit = store.get(planId);
  if (hit) return hit;
  // 2차: 파일 폴백 — Next.js 번들 분리로 createPending 한 모듈과 getPending 호출하는 모듈이
  //       다른 Map 인스턴스일 수 있음. 파일은 공유되므로 재조회로 우회.
  try {
    if (!fs.existsSync(STORE_FILE)) return null;
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const arr = JSON.parse(raw) as PendingTool[];
    const now = Date.now();
    let found: PendingTool | null = null;
    for (const p of arr) {
      if (!p?.planId || now - p.createdAt > PENDING_EXPIRE_MS) continue;
      // 발견한 김에 메모리에도 복원 (다음 조회 캐시 히트)
      store.set(p.planId, p);
      if (p.planId === planId) found = p;
    }
    return found;
  } catch {
    return null;
  }
}

export function consumePending(planId: string): PendingTool | null {
  // 메모리에 없으면 파일 폴백 (getPending 과 동일 정공법)
  const p = store.get(planId) ?? getPending(planId);
  if (!p) return null;
  store.delete(planId);
  flush();
  return p;
}

export function rejectPending(planId: string): boolean {
  // 메모리 + 파일 양쪽 정리. 파일에만 있어도 정상 처리.
  const had = store.has(planId) || getPending(planId) !== null;
  store.delete(planId);
  if (had) flush();
  return had;
}
