/**
 * i18n — 자체 단순 구현 (의존성 0, v2.0 Tauri / SPA 호환).
 *
 * 두 영역 분리:
 *   - **어드민 UI** = useTranslations() hook + LangProvider (Client Component)
 *     활성 언어 결정: localStorage `firebat_ui_lang` → fetch /api/settings 의 interfaceLang → 'ko'
 *   - **공개 사이트** = getServerTranslations(siteLang) (Server Component)
 *     활성 언어 = cms.siteLang 그대로
 *
 * 키 형식: nested ('login.title' / 'page.reading_time'). 미발견 시 key 자체 반환 + console warn.
 * Placeholder: '{count}분 읽기' → t('page.reading_time', {count: 5}) → '5분 읽기'.
 *
 * v2.0 Tauri / SPA 마이그레이션 시 — Provider + hook 그대로 사용. messages JSON 그대로.
 */

'use client';

import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import koMessages from '../messages/ko.json';
import enMessages from '../messages/en.json';

export type Lang = 'ko' | 'en';

const MESSAGES: Record<Lang, Record<string, unknown>> = {
  ko: koMessages,
  en: enMessages,
};

const FALLBACK_LANG: Lang = 'en';

/** nested key resolver — 'login.title' → messages.login.title */
function resolveKey(messages: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = messages;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** placeholder 치환 — '{count}분 읽기' + {count: 5} → '5분 읽기' */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    return v === undefined ? `{${key}}` : String(v);
  });
}

/** 활성 언어 + raw messages 응답 (key 없으면 fallback lang 시도 → 그것도 없으면 key 자체) */
export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>,
): string {
  const primary = resolveKey(MESSAGES[lang] || {}, key);
  if (primary !== undefined) return interpolate(primary, params);
  // fallback chain — 다른 언어에서 시도 (영어 → 한국어 또는 그 역)
  const fallback = lang === FALLBACK_LANG ? undefined : resolveKey(MESSAGES[FALLBACK_LANG] || {}, key);
  if (fallback !== undefined && fallback !== null) {
    if (typeof console !== 'undefined') {
      console.warn(`[i18n] missing key '${key}' in lang '${lang}', using '${FALLBACK_LANG}' fallback`);
    }
    return interpolate(fallback, params);
  }
  if (typeof console !== 'undefined') {
    console.warn(`[i18n] missing key '${key}' in all languages — returning raw key`);
  }
  return key;
}

// ──────────────────────────────────────────────────────────────────────────
// Client (어드민) — Context + Provider + hook
// ──────────────────────────────────────────────────────────────────────────

interface LangContextValue {
  lang: Lang;
  setLang: (next: Lang) => void;
}

const LangContext = createContext<LangContextValue>({
  lang: FALLBACK_LANG,
  setLang: () => {},
});

const STORAGE_KEY = 'firebat_ui_lang';

function isValidLang(v: unknown): v is Lang {
  return v === 'ko' || v === 'en';
}

/** 어드민 LangProvider — root 또는 admin layout 안에 렌더.
 *  초기값: localStorage 우선 → 없으면 'ko'. 마운트 후 /api/settings 동기화. */
export function LangProvider({ children, initial }: { children: React.ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (initial && isValidLang(initial)) return initial;
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isValidLang(saved)) return saved;
    }
    return FALLBACK_LANG;
  });

  // 마운트 후 서버 settings 동기화 (DB 우선 — 멀티기기 일관성)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (cancelled || !data.success) return;
        const remote: unknown = data.interfaceLang;
        if (isValidLang(remote) && remote !== lang) {
          setLangState(remote);
          if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, remote);
        }
      } catch { /* fetch 실패 → localStorage / 디폴트 유지 */ }
    })();
    return () => { cancelled = true; };
  }, []); // 첫 마운트 시 1회만

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, next);
    // 서버 동기화 — 실패 silent (다음 fetch 가 갱신)
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interfaceLang: next }),
    }).catch(() => {});
  }, []);

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

/** 어드민 useTranslations — 활성 언어로 매핑된 t() 함수 응답. */
export function useTranslations(): (key: string, params?: Record<string, string | number>) => string {
  const { lang } = useContext(LangContext);
  return useCallback(
    (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );
}

/** 활성 언어 조회 (Setting 변경 UI 등). */
export function useLang(): { lang: Lang; setLang: (next: Lang) => void } {
  return useContext(LangContext);
}

/** (user) 영역의 Client Component 용 — `<html lang>` 따라 자동 결정.
 *  LangProvider 없이도 작동 (admin 영역과 분리). siteLang 은 server (user)/layout.tsx 가
 *  설정한 `<html lang={siteLang}>` 값 그대로 활용. */
export function usePublicTranslations(): (key: string, params?: Record<string, string | number>) => string {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof document === 'undefined') return FALLBACK_LANG;
    return document.documentElement.lang === 'en' ? 'en' : 'ko';
  });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const next = document.documentElement.lang === 'en' ? 'en' : 'ko';
    if (next !== lang) setLangState(next);
  }, [lang]);
  return useCallback(
    (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Server (공개 사이트) — 단순 함수 (RSC 안에서 사용)
// ──────────────────────────────────────────────────────────────────────────

/** Server Component 안에서 사용 — siteLang 받아 t() 함수 응답.
 *  사용 예:
 *    const t = getServerTranslations(cms.siteLang);
 *    <h1>{t('page.not_found_title')}</h1>
 */
export function getServerTranslations(
  siteLang?: string | null,
): (key: string, params?: Record<string, string | number>) => string {
  const lang: Lang = isValidLang(siteLang) ? siteLang : FALLBACK_LANG;
  return (key, params) => translate(lang, key, params);
}

/** lang 정규화 — 외부 입력 (e.g. cms settings) 의 lang string → Lang 또는 fallback. */
export function normalizeLang(lang?: string | null): Lang {
  return isValidLang(lang) ? lang : FALLBACK_LANG;
}
