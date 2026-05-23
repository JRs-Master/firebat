/**
 * SettingsManager — 프론트엔드 localStorage 중앙 스키마
 *
 * 배경: firebat_model / firebat_plan_mode / firebat_active_conv / firebat_conversations /
 *   firebat_last_model_by_category / firebat_editor_chat_* 등 키 8개+ 가 여러 파일에
 *   흩어져 있음. 오타·타입 불일치·탭 간 동기화 없음.
 *
 * 해결: 키 스키마 중앙 관리 + typed get/set + `storage` 이벤트 기반 cross-tab 동기화.
 *   - `useSetting(key)` 훅: useState 와 동일 API, localStorage 자동 영속 + 다른 탭 변경 감지.
 *   - `readSetting(key)` / `writeSetting(key, v)`: 훅 밖에서 즉시 접근 (초기 로드 등).
 *
 * Message history 같은 대용량 구조는 schema 밖에서 직접 직렬화 (성능 때문에 useState 관리).
 */

'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { safeJsonParse, logger } from '../../../lib/util';

// ── 스키마 정의 ─────────────────────────────────────────────────────────────
// 새 설정 추가 시 이 타입에만 키 추가하면 useSetting / readSetting / writeSetting 이 자동 지원.
export type SettingsSchema = {
  'firebat_model': string;
  /** 플랜 모드 3단계:
   *   - 'off': plan 강제 X. AI 자유 판단.
   *   - 'auto': destructive·복합 작업만 propose_plan, 단순 read-only 는 즉시
   *   - 'always': 모든 요청에 propose_plan 강제 (인사·단답 포함) */
  'firebat_plan_mode': 'off' | 'auto' | 'always';
  'firebat_active_conv': string;
  'firebat_last_model_by_category': Record<string, string>;
  'firebat_thinking_level': string;
  /** 모델별 마지막 thinking level — 카테고리별 모델 기억 (firebat_last_model_by_category) 패턴과 동일.
   *  모델 전환 후 그 모델 다시 선택 시 이전 thinking 복원. fallback: firebat_thinking_level (글로벌 default). */
  'firebat_last_thinking_by_model': Record<string, string>;
  /** 입력 모드 — 'text' 면 일반 LLM 채팅, 'image' 면 입력창 텍스트를 prompt 로 직접 image_gen.
   *  LLM 우회 → 비용 절감 + timeout 위험 0. 갤러리 자동 갱신은 SSE gallery:refresh 가 처리. */
  'firebat_input_mode': 'text' | 'image';
};

const DEFAULTS: SettingsSchema = {
  // 디폴트 빈 문자열 — 사용자가 설정 → AI 탭에서 명시 선택 + 인증 설정할 때까지 채팅 차단.
  'firebat_model': '',
  'firebat_plan_mode': 'off',
  'firebat_active_conv': '',
  'firebat_last_model_by_category': {},
  'firebat_thinking_level': 'medium',
  'firebat_last_thinking_by_model': {},
  'firebat_input_mode': 'text',
};

// ── 직렬화 ─────────────────────────────────────────────────────────────────
// boolean 은 'true'/'false' 문자열, object/array 는 JSON, 나머지는 raw.
// 기존 키 호환 — firebat_plan_mode 는 기존 useChat 에서 'true'/'false' 로 저장.
function serialize<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function deserialize<K extends keyof SettingsSchema>(key: K, raw: string): SettingsSchema[K] {
  const def = defaultFor(key);
  // firebat_plan_mode 마이그레이션: 'true'/'false' → 'always'/'off' (이전 boolean 토글 호환)
  if (key === 'firebat_plan_mode') {
    if (raw === 'true') return 'always' as unknown as SettingsSchema[K];
    if (raw === 'false') return 'off' as unknown as SettingsSchema[K];
    if (raw === 'off' || raw === 'auto' || raw === 'always') return raw as unknown as SettingsSchema[K];
    return def;
  }
  if (typeof def === 'boolean') return (raw === 'true') as unknown as SettingsSchema[K];
  if (typeof def === 'object') {
    return safeJsonParse<SettingsSchema[K]>(raw, def);
  }
  return raw as unknown as SettingsSchema[K];
}

// ── module-level 키 prefix ───────────────────────────────────────────────────
// hub page mode 에서는 admin localStorage 키 사용 금지. ConsolePage 가 hubContext 있을 때
// setKeyPrefix(`hub-<slug>`) 호출 → 모든 useSetting / readSetting / writeSetting 자동 분기.
// 호출 site 마다 옵션 박을 필요 없음 — 한 곳에서 set / clear.
let currentKeyPrefix: string | null = null;

export function setSettingsKeyPrefix(prefix: string | null): void {
  if (currentKeyPrefix === prefix) return;
  currentKeyPrefix = prefix;
  // 모든 구독자 재계산 (prefix 바뀐 후 새 키 읽기)
  for (const set of subscribers.values()) {
    for (const cb of set) cb();
  }
  // snapshot 캐시 전부 무효화 — 키 자체가 바뀜
  snapshotCache.clear();
}

function effectiveKey<K extends keyof SettingsSchema>(key: K): string {
  return currentKeyPrefix ? `${key}__${currentKeyPrefix}` : (key as string);
}

/** key 의 기본값. hub page mode (prefix 'hub-') 에서는 plan mode 기본을 'auto' 로 —
 *  방문자가 복합·destructive 작업 전에 계획을 먼저 확인하도록. 방문자가 토글로 명시
 *  변경하면 그 값이 localStorage 에 저장돼 우선한다 (default 는 미설정일 때만). */
function defaultFor<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
  if (key === 'firebat_plan_mode' && currentKeyPrefix?.startsWith('hub-')) {
    return 'auto' as unknown as SettingsSchema[K];
  }
  return DEFAULTS[key];
}

// ── 즉시 접근 API (훅 밖에서 사용) ──────────────────────────────────────────
export function readSetting<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
  if (typeof window === 'undefined') return defaultFor(key);
  try {
    const raw = localStorage.getItem(effectiveKey(key));
    if (raw === null) return defaultFor(key);
    return deserialize(key, raw);
  } catch {
    return defaultFor(key);
  }
}

export function writeSetting<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void {
  if (typeof window === 'undefined') return;
  try {
    const realKey = effectiveKey(key);
    localStorage.setItem(realKey, serialize(key, value));
    invalidateSnapshot(realKey);
    notify(realKey);
  } catch (e) { logger.debug('settings', `localStorage write 실패 (${String(key)})`, { error: e }); }
}

// ── useSetting 훅 ───────────────────────────────────────────────────────────
/** localStorage 영속 + cross-tab 동기화되는 useState.
 *  다른 탭에서 같은 키 변경 시 자동 반영 (`storage` 이벤트).
 *
 *  중요: 초기값은 useState **initializer 안에서 동기적으로 localStorage 읽기**.
 *  이전에는 DEFAULTS 로 시작 후 useEffect 로 하이드레이션했는데, 그 사이 다른
 *  useEffect 가 stale DEFAULTS 기반으로 setValue 를 호출하면 **localStorage 를
 *  빈 객체 + 현재 값 하나** 로 덮어써 다른 카테고리 기억이 전부 날아가는 race 발생.
 *  (SettingsModal 의 "카테고리 전환 시 이전 모델 복원" 이 작동 안 하던 원인.)
 *  'use client' 컴포넌트만 useSetting 호출하므로 SSR 하이드레이션 충돌 없음. */
// ── localStorage 외부 스토어 브릿지 ──────────────────────────────────────────
// 같은 key 구독자는 같은 listener 리스트 공유 — setPlanMode 후 모든 구독 hook 동기 갱신.
const subscribers = new Map<string, Set<() => void>>();

// snapshot 캐시 — object/array 타입은 JSON.parse 로 매번 새 레퍼런스 생성되면
// useSyncExternalStore 가 "값이 바뀌었다" 고 판정해 무한 루프 → 페이지 크래시.
// 원본 raw 문자열을 키로 캐시해서 동일 raw 면 동일 객체 반환 (stable reference).
const snapshotCache = new Map<string, { raw: string | null; value: unknown }>();

function getStableSnapshot<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
  if (typeof window === 'undefined') return defaultFor(key);
  const realKey = effectiveKey(key);
  const raw = localStorage.getItem(realKey);
  const cached = snapshotCache.get(realKey);
  if (cached && cached.raw === raw) return cached.value as SettingsSchema[K];
  const value = raw === null ? defaultFor(key) : (() => {
    try { return deserialize(key, raw); } catch { return defaultFor(key); }
  })();
  snapshotCache.set(realKey, { raw, value });
  return value;
}

function invalidateSnapshot(key: string) {
  snapshotCache.delete(key);
}

function subscribe(key: string, cb: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) { set = new Set(); subscribers.set(key, set); }
  set.add(cb);
  // cross-tab: 다른 탭 storage 이벤트 → 이 탭도 알림 (캐시 무효화 선행)
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) { invalidateSnapshot(key); cb(); }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(key);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function notify(key: string) {
  invalidateSnapshot(key);
  const set = subscribers.get(key);
  if (!set) return;
  for (const cb of set) cb();
}

// Server snapshot — SSR 동안 단일 레퍼런스 유지 (key 별)
const serverSnapshots = new Map<string, unknown>();
function getServerSnapshot<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
  const cached = serverSnapshots.get(key as string);
  if (cached !== undefined) return cached as SettingsSchema[K];
  const value = DEFAULTS[key];
  serverSnapshots.set(key as string, value);
  return value;
}

/** useSetting — useSyncExternalStore 기반.
 *  SSR 시 getServerSnapshot 이 DEFAULTS 반환 → 클라이언트 getSnapshot 이 localStorage 반환.
 *  React 가 hydration mismatch 없이 자동으로 외부 스토어 값으로 렌더 — useEffect flicker 없음. */
export function useSetting<K extends keyof SettingsSchema>(
  key: K,
): [SettingsSchema[K], (value: SettingsSchema[K] | ((prev: SettingsSchema[K]) => SettingsSchema[K])) => void] {
  // subscribe / notify 모두 effectiveKey 기반 — prefix 일치 안 하면 update 누락.
  // currentKeyPrefix 자체가 module-level 이라 prefix 변경 시 setSettingsKeyPrefix 가 모든 listener 호출.
  const value = useSyncExternalStore<SettingsSchema[K]>(
    useCallback(cb => subscribe(effectiveKey(key), cb), [key]),
    useCallback(() => getStableSnapshot(key), [key]),
    useCallback(() => getServerSnapshot(key), [key]),
  );

  const update = useCallback((next: SettingsSchema[K] | ((prev: SettingsSchema[K]) => SettingsSchema[K])) => {
    const prev = readSetting(key);
    const resolved = typeof next === 'function' ? (next as (p: SettingsSchema[K]) => SettingsSchema[K])(prev) : next;
    writeSetting(key, resolved);
  }, [key]);

  return [value, update];
}
