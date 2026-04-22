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

// ── 스키마 정의 ─────────────────────────────────────────────────────────────
// 새 설정 추가 시 이 타입에만 키 추가하면 useSetting / readSetting / writeSetting 이 자동 지원.
export type SettingsSchema = {
  'firebat_model': string;
  'firebat_plan_mode': boolean;
  'firebat_active_conv': string;
  'firebat_last_model_by_category': Record<string, string>;
  'firebat_thinking_level': string;
};

const DEFAULTS: SettingsSchema = {
  'firebat_model': 'gpt-5.4-mini',
  'firebat_plan_mode': false,
  'firebat_active_conv': '',
  'firebat_last_model_by_category': {},
  'firebat_thinking_level': 'medium',
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
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return (raw === 'true') as SettingsSchema[K];
  if (typeof def === 'object') {
    try { return JSON.parse(raw) as SettingsSchema[K]; }
    catch { return def; }
  }
  return raw as SettingsSchema[K];
}

// ── 즉시 접근 API (훅 밖에서 사용) ──────────────────────────────────────────
export function readSetting<K extends keyof SettingsSchema>(key: K): SettingsSchema[K] {
  if (typeof window === 'undefined') return DEFAULTS[key];
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return DEFAULTS[key];
    return deserialize(key, raw);
  } catch {
    return DEFAULTS[key];
  }
}

export function writeSetting<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, serialize(key, value));
  } catch {}
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

function subscribe(key: string, cb: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) { set = new Set(); subscribers.set(key, set); }
  set.add(cb);
  // cross-tab: 다른 탭 storage 이벤트 → 이 탭도 알림
  const onStorage = (e: StorageEvent) => { if (e.key === key) cb(); };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(key);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function notify(key: string) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const cb of set) cb();
}

/** useSetting — useSyncExternalStore 기반.
 *  SSR 시 getServerSnapshot 이 DEFAULTS 반환 → 클라이언트 getSnapshot 이 localStorage 반환.
 *  React 가 hydration mismatch 없이 자동으로 외부 스토어 값으로 렌더 — useEffect flicker 없음. */
export function useSetting<K extends keyof SettingsSchema>(
  key: K,
): [SettingsSchema[K], (value: SettingsSchema[K] | ((prev: SettingsSchema[K]) => SettingsSchema[K])) => void] {
  const value = useSyncExternalStore<SettingsSchema[K]>(
    useCallback(cb => subscribe(key, cb), [key]),
    useCallback(() => readSetting(key), [key]),
    useCallback(() => DEFAULTS[key], [key]),
  );

  const update = useCallback((next: SettingsSchema[K] | ((prev: SettingsSchema[K]) => SettingsSchema[K])) => {
    const prev = readSetting(key);
    const resolved = typeof next === 'function' ? (next as (p: SettingsSchema[K]) => SettingsSchema[K])(prev) : next;
    writeSetting(key, resolved);
    notify(key); // 같은 탭 내 다른 useSetting(key) 구독자 즉시 갱신
  }, [key]);

  return [value, update];
}
