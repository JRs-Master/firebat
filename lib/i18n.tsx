/**
 * i18n client — LangProvider + 3 hook (useTranslations / usePublicTranslations / useLang).
 *
 * 두 영역 분리:
 *   - **어드민 UI** = useTranslations() hook + LangProvider (Client Component)
 *     활성 언어 결정: localStorage `firebat_ui_lang` → fetch /api/settings 의 interfaceLang → INITIAL_LANG
 *   - **공개 사이트 (RSC)** = `lib/i18n-server.ts` 의 getServerTranslations(siteLang)
 *     활성 언어 = cms.siteLang 그대로
 *
 * 키 형식: nested ('login.title' / 'page.reading_time'). 미발견 시 key 자체 반환 + console warn.
 * Placeholder: '{count}분 읽기' → t('page.reading_time', {count: 5}) → '5분 읽기'.
 *
 * pure logic (translate / normalizeLang / FALLBACK_LANG / INITIAL_LANG) 은 `lib/i18n-shared.ts`
 * 에 분리 — server / client 양쪽이 import 가능하도록. 이 파일은 `'use client'` 라 RSC 에서
 * 직접 import 불가.
 *
 * v2.0 Tauri / SPA 마이그레이션 시 — Provider + hook 그대로 사용. messages JSON 그대로.
 */

'use client';

import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import {
  type Lang,
  INITIAL_LANG,
  isValidLang,
  translate,
} from './i18n-shared';

// 타입 + 상수 re-export — 기존 import 호환.
export type { Lang } from './i18n-shared';
export { translate, normalizeLang, FALLBACK_LANG, INITIAL_LANG } from './i18n-shared';

// ──────────────────────────────────────────────────────────────────────────
// Client (어드민) — Context + Provider + hook
// ──────────────────────────────────────────────────────────────────────────

interface LangContextValue {
  lang: Lang;
  setLang: (next: Lang) => void;
}

const LangContext = createContext<LangContextValue>({
  lang: INITIAL_LANG,
  setLang: () => {},
});

const STORAGE_KEY = 'firebat_ui_lang';

/** 어드민 LangProvider — root 또는 admin layout 안에 렌더.
 *  초기값: server / client hydration 일치를 위해 INITIAL_LANG 고정 (또는 명시 prop).
 *  마운트 후 useEffect 안에서 localStorage → /api/settings 순으로 실제 값 동기화. */
export function LangProvider({ children, initial }: { children: React.ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (initial && isValidLang(initial)) return initial;
    return INITIAL_LANG;
  });

  // 마운트 후 동기화 — localStorage 즉시 + DB (멀티기기 일관성)
  useEffect(() => {
    let cancelled = false;
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isValidLang(saved) && saved !== lang) setLangState(saved);
    }
    (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (cancelled || !data.success) return;
        const remote: unknown = data.interfaceLang;
        if (isValidLang(remote)) {
          setLangState(remote);
          if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, remote);
        }
      } catch { /* fetch 실패 → localStorage / 디폴트 유지 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
 *  설정한 `<html lang={siteLang}>` 값 그대로 활용.
 *
 *  ⚠️ hydration safety — 첫 렌더는 server / client 모두 INITIAL_LANG 으로 통일.
 *  document.documentElement.lang 읽기는 useEffect 안에서만 (마운트 후). */
export function usePublicTranslations(): (key: string, params?: Record<string, string | number>) => string {
  const [lang, setLangState] = useState<Lang>(INITIAL_LANG);
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
