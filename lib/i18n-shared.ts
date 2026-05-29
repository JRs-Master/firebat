/**
 * i18n shared — server / client 공용 pure logic.
 *
 * **분리 사유** (2026-05-11): 이 파일은 `'use client'` directive 없이 작성되어
 * server component / client component 양쪽에서 import 가능. `lib/i18n.tsx` 의
 * `'use client'` 안에 있던 translate / normalizeLang / FALLBACK_LANG 등 pure
 * 함수를 server (RSC) 가 호출 못하던 NotFound 폴백 발생 → admin hydration mismatch
 * (#418) 까지 chain 되던 문제 차단.
 *
 * 사용:
 *   - client side: `lib/i18n.tsx` (LangProvider / hooks) 가 import
 *   - server side: `lib/i18n-server.ts` (getServerTranslations) 가 import
 */

import koMessages from '../language/ko.json';
import enMessages from '../language/en.json';

export type Lang = 'ko' | 'en';

export const MESSAGES: Record<Lang, Record<string, unknown>> = {
  ko: koMessages,
  en: enMessages,
};

/** 누락 키 폴백 — 어느 언어에서 못 찾을 때 마지막으로 시도할 언어. */
export const FALLBACK_LANG: Lang = 'en';

/** SSR + 첫 client render (hydration) 의 default 언어.
 *  ⚠️ localStorage 읽기는 useEffect 안에서만 — lazy useState init 에 넣으면 server 는
 *  FALLBACK 으로 영문 렌더, client 는 localStorage 의 'ko' 로 한국어 렌더 → text node
 *  mismatch → React #418. server / client 가 같은 값 반환하도록 통일.
 *  값 = 'en' — SetupWizard / FALLBACK 과 동일한 글로벌 default. 한국어 사용자는
 *  localStorage 에 'ko' 가 있어 마운트 직후 useEffect 에서 즉시 전환 (한 프레임 flash). */
export const INITIAL_LANG: Lang = 'en';

export function isValidLang(v: unknown): v is Lang {
  return v === 'ko' || v === 'en';
}

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

/** lang 정규화 — 외부 입력 (e.g. cms settings) 의 lang string → Lang 또는 fallback. */
export function normalizeLang(lang?: string | null): Lang {
  return isValidLang(lang) ? lang : FALLBACK_LANG;
}
