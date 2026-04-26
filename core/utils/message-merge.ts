/**
 * 대화 메시지 union merge — id 기준 합집합, 동일 id 면 incoming 우선.
 *
 * 사용처:
 *   - ConversationManager.save: 모바일·PC 동시 쓰기 시 incoming 으로 단순 덮어쓰면 다른 기기 메시지 유실
 *   - 향후 임의 다기기 동기화 위치에서도 재사용
 *
 * 정렬: id 안의 숫자 부분 (timestamp) 추출해 시간순. id 형식 가정 — "u-{Date.now()}" / "s-{Date.now()}" / "system-init".
 *  id 에 timestamp 없으면 맨 앞 (ts=0). id 없는 메시지는 따로 모아 뒤에 append.
 *
 * 일반 로직 — 메시지 도메인 분기 X, role/content 무관 id 기반 merge 만.
 */

const getId = (m: unknown): string | null => {
  if (!m || typeof m !== 'object') return null;
  const id = (m as Record<string, unknown>).id;
  return typeof id === 'string' && id ? id : null;
};

const getTs = (id: string | null): number => {
  if (!id) return 0;
  const m = id.match(/(\d{10,})/);
  return m ? parseInt(m[1], 10) : 0;
};

/** existing + incoming 합집합. 동일 id 면 incoming 우선 (최신 데이터로 덮어쓰기).
 *  id 없는 메시지는 incoming 의 순서대로 뒤에 append (중복 제거 reference equality 기준). */
export function unionMergeMessages(existing: unknown[], incoming: unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  const noIdMsgs: unknown[] = [];

  for (const m of existing) {
    const mid = getId(m);
    if (mid) byId.set(mid, m);
    else noIdMsgs.push(m);
  }
  for (const m of incoming) {
    const mid = getId(m);
    if (mid) byId.set(mid, m);
    else if (!noIdMsgs.includes(m)) noIdMsgs.push(m);
  }

  // timestamp 순 정렬 — id 에 timestamp 없으면 ts=0 (맨 앞)
  const withId = Array.from(byId.entries())
    .map(([id, msg]) => ({ id, msg, ts: getTs(id) }))
    .sort((a, b) => a.ts - b.ts)
    .map(x => x.msg);

  return [...withId, ...noIdMsgs];
}
