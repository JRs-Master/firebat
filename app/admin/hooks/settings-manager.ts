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

import { useEffect, useState, useCallback } from 'react';

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
export function useSetting<K extends keyof SettingsSchema>(
  key: K,
): [SettingsSchema[K], (value: SettingsSchema[K] | ((prev: SettingsSchema[K]) => SettingsSchema[K])) => void] {
  const [value, setValue] = useState<SettingsSchema[K]>(() => readSetting(key));

  // SSR 하이드레이션 동기화 — 서버는 window 없이 DEFAULTS 로 렌더 → 클라이언트 mount 후
  // localStorage 값으로 재동기화. useState 초기화와 중복이지만 SSR 시 className 등이
  // DEFAULTS 기준 박제되는 문제를 트리거 재렌더로 해결.
  useEffect(() => {
    const current = readSetting(key);
    setValue(prev => (prev !== current ? current : prev));
  }, [key]);

  // cross-tab 동기화 — storage 이벤트는 다른 탭에서 localStorage 변경 시 발생
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      if (e.newValue === null) { setValue(DEFAULTS[key]); return; }
      try { setValue(deserialize(key, e.newValue)); } catch {}
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const update = useCallback((next: SettingsSchema[K] | ((prev: SettingsSchema[K]) => SettingsSchema[K])) => {
    setValue(prev => {
      const resolved = typeof next === 'function' ? (next as (p: SettingsSchema[K]) => SettingsSchema[K])(prev) : next;
      writeSetting(key, resolved);
      return resolved;
    });
  }, [key]);

  return [value, update];
}
