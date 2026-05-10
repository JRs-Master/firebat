/**
 * Plan Store — propose_plan 의 steps 보관소
 *
 * AI 가 propose_plan 호출 → planId 발급 + steps 등 저장.
 * 사용자가 ✓실행 클릭 → 다음 chat 요청에 planExecuteId 동봉 → AiManager 가 조회 후 시스템 프롬프트에 강제 주입.
 *
 * **파일 영속화** (v0.1, 2026-04-22): PM2 재시작·서버 재부팅 후에도 plan 유지.
 * - in-memory Map 1차 캐시 + `data/plan-store.json` 영속 저장 (기존 cron-*.json 패턴과 동일)
 * - 부팅 시 파일 로드, 쓰기 시 즉시 flush (크기 작음 — TTL 3시간, max 50)
 *
 * 기존 PlanCard 가 component blocks 으로 conversations 테이블에 저장되지만
 * planId → steps 매핑만은 별도 저장 필요 (DB 저장하면 과잉, JSON 적합).
 */

import fs from 'fs';
import path from 'path';

const PLAN_EXPIRE_MS = 3 * 60 * 60_000; // 3시간 — 사용자가 한참 뒤 ✓실행 눌러도 유효
const MAX_SIZE = 50;
const STORE_FILE = path.resolve(process.env.FIREBAT_DATA_DIR || 'data', 'plan-store.json');

export interface PlanStep {
  title: string;
  description?: string;
  tool?: string;
}

export interface StoredPlan {
  planId: string;
  title: string;
  steps: PlanStep[];
  estimatedTime?: string;
  risks?: string[];
  createdAt: number;
}

const store = new Map<string, StoredPlan>();

// 부팅 시 파일에서 복원 (PM2 재시작 후에도 plan 유지)
(function loadFromFile() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const arr = JSON.parse(raw) as StoredPlan[];
    const now = Date.now();
    for (const p of arr) {
      if (p?.planId && now - p.createdAt <= PLAN_EXPIRE_MS) store.set(p.planId, p);
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
    if (now - p.createdAt > PLAN_EXPIRE_MS) { store.delete(id); changed = true; }
  }
  if (changed) flush();
}
const cleanupInterval = setInterval(cleanup, 60_000);
cleanupInterval.unref?.();

export function storePlan(plan: Omit<StoredPlan, 'createdAt'>): void {
  if (store.size >= MAX_SIZE) {
    let oldest: string | null = null;
    let ts = Infinity;
    for (const [id, p] of store) {
      if (p.createdAt < ts) { oldest = id; ts = p.createdAt; }
    }
    if (oldest) store.delete(oldest);
  }
  store.set(plan.planId, { ...plan, createdAt: Date.now() });
  flush();
}

export function getPlan(planId: string): StoredPlan | null {
  // 1차: in-memory 캐시
  const hit = store.get(planId);
  if (hit) return hit;
  // 2차: 파일 폴백 — Next.js 번들 분리로 storePlan 한 모듈과 getPlan 호출하는 모듈이
  //       다른 Map 인스턴스일 수 있음. 파일은 공유되므로 재조회로 우회.
  try {
    if (!fs.existsSync(STORE_FILE)) return null;
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const arr = JSON.parse(raw) as StoredPlan[];
    const now = Date.now();
    let found: StoredPlan | null = null;
    for (const p of arr) {
      if (!p?.planId || now - p.createdAt > PLAN_EXPIRE_MS) continue;
      // 발견한 김에 메모리에도 복원 (다음 조회 캐시 히트)
      store.set(p.planId, p);
      if (p.planId === planId) found = p;
    }
    return found;
  } catch {
    return null;
  }
}

export function deletePlan(planId: string): void {
  if (store.delete(planId)) flush();
}

/** plan steps + 사용자 수정 요청 → propose_plan 재호출 강제 시스템 프롬프트.
 *  사용자가 plan card 의 ⚙수정 제안 input 으로 "1단계 빼줘" 같은 피드백 입력 시 사용. */
export function planToReviseInstruction(plan: StoredPlan, userFeedback: string): string {
  const stepsText = plan.steps
    .map((s, i) => {
      const desc = s.description ? ` — ${s.description}` : '';
      const tool = s.tool ? ` [${s.tool}]` : '';
      return `[${i + 1}] ${s.title}${desc}${tool}`;
    })
    .join('\n');
  return `사용자가 직전 plan 에 대한 수정 요청을 했습니다. 사용자 피드백을 반영해 propose_plan 도구를 **재호출**하세요.

## 직전 plan: ${plan.title}
${stepsText}

## 사용자 수정 요청
"${userFeedback}"

## 재작성 규칙
- 사용자 요청대로 단계 추가/삭제/수정 후 propose_plan 도구를 다시 호출.
- title, steps, estimatedTime, risks 모두 갱신.
- propose_plan 호출 후 **즉시 턴 종료** — 다른 도구·텍스트 응답 금지. 사용자가 새 plan card 보고 다시 ✓실행 누름.
- 텍스트 답변·설명 금지 — 오직 propose_plan tool_use 만.`;
}

/** plan steps 를 LLM 이 따라 실행할 수 있게 한국어 텍스트로 직렬화.
 *  originalRequest: 사용자 원래 메시지 — 시각·예약 정보가 plan steps 에 누락된 경우 AI 가 다시 인식 가능. */
export function planToInstruction(plan: StoredPlan, originalRequest?: string): string {
  const stepsText = plan.steps
    .map((s, i) => {
      const desc = s.description ? ` — ${s.description}` : '';
      const tool = s.tool ? ` [${s.tool}]` : '';
      return `[${i + 1}] ${s.title}${desc}${tool}`;
    })
    .join('\n');
  const originalSection = originalRequest
    ? `\n## 사용자 원래 요청 (참고 — 시각·예약·조건 등이 plan steps 에 없으면 여기서 인식)\n"${originalRequest}"\n`
    : '';
  return `사용자가 직전 plan 을 ✓실행으로 승인했습니다. 아래 단계를 그대로 따라 실행하세요.

## 승인된 plan: ${plan.title}
${stepsText}
${originalSection}
## 실행 규칙
- 위 단계들을 순서대로 모두 실행. 단계 임의 변경·생략 금지.
- propose_plan 도구 **재호출 금지** (이미 승인됨).
- **사용자 원래 요청에 시각·예약 표현 (X시 X분, X분 후, 매일 등) 이 있으면 → \`schedule_task\` 도구로 wrap.** 단계들은 schedule_task 의 pipeline 인자로 들어감. 즉시 실행 금지.
- 시각·예약 표현 없으면 → \`run_task\` 또는 단계별 직접 도구 호출로 즉시 실행.
- 각 단계의 tool 명시가 있으면 그 도구를 사용. 명시 없으면 단계 내용에 적합한 도구 선택.
- 마지막 단계 종료 후 결과를 사용자에게 시각화 컴포넌트로 보고.`;
}
