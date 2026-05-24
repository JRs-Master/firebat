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
import { LANG_COOKIE_MAX_AGE_SECONDS as COOKIE_MAX_AGE } from './config';

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

/** lang 저장소 key — localStorage / cookie 공용. cookie 만료 = lib/config LANG_COOKIE_MAX_AGE_SECONDS (1년). */
const STORAGE_KEY = 'firebat_ui_lang';

function writeLangCookie(lang: Lang) {
  if (typeof document === 'undefined') return;
  // path=/ 전 영역. samesite=lax — 일반 navigation 에 포함, csrf 안전.
  document.cookie = `${STORAGE_KEY}=${lang}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

/** 어드민 LangProvider — root 또는 admin layout 안에 렌더.
 *  초기값: server 가 cookie 읽어 `initial` prop 으로 전달 (Option C — hydration mismatch
 *  + UX flash 영구 해결). prop 없으면 INITIAL_LANG ('en') 으로 fallback.
 *
 *  마운트 후 동기화:
 *  - localStorage 가 cookie 와 다르면 localStorage 값으로 보강 (cross-tab 갱신 대응)
 *  - `enableServerSync` true 일 때만 /api/settings fetch (멀티기기 일관성).
 *    인증 무관 영역 (login / public) 에선 false → 401 콘솔 더럽힘 방지. */
export function LangProvider({
  children,
  initial,
  enableServerSync = false,
  forceLocale,
}: {
  children: React.ReactNode;
  initial?: Lang;
  enableServerSync?: boolean;
  /** 강제 lang — admin cookie / localStorage 무시. hub page 안 visitor navigator 자동 감지에 사용.
   *  설정되어 있으면 setLang 도 no-op (localStorage / cookie 기록 X — admin 설정 영향 0). */
  forceLocale?: Lang;
}) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (forceLocale && isValidLang(forceLocale)) return forceLocale;
    if (initial && isValidLang(initial)) return initial;
    return INITIAL_LANG;
  });

  // 마운트 후 동기화
  useEffect(() => {
    let cancelled = false;
    if (forceLocale && isValidLang(forceLocale)) {
      // forceLocale 이 있으면 admin saved / server sync 모두 무시.
      if (forceLocale !== lang) setLangState(forceLocale);
      return () => { cancelled = true; };
    }
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isValidLang(saved) && saved !== lang) setLangState(saved);
    }
    if (!enableServerSync) return;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (cancelled || !data.success) return;
        const remote: unknown = data.interfaceLang;
        if (isValidLang(remote)) {
          setLangState(remote);
          if (typeof window !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, remote);
            writeLangCookie(remote);
          }
        }
      } catch { /* fetch 실패 → localStorage / 디폴트 유지 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableServerSync]); // enableServerSync 변경 시 재발화 (보통 mount 1회)

  const setLang = useCallback((next: Lang) => {
    // forceLocale 이 있으면 setLang no-op (admin 설정에 기록 X).
    if (forceLocale) return;
    setLangState(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, next);
      writeLangCookie(next); // 다음 SSR 의 initial 값 확정 — flash 0
    }
    // 서버 동기화 — enableServerSync 영역에서만. 실패 silent.
    if (enableServerSync) {
      fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interfaceLang: next }),
      }).catch(() => {});
    }
  }, [enableServerSync, forceLocale]);

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
