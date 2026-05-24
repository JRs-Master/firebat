/**
 * i18n server — Server Component (RSC) 전용 헬퍼.
 *
 * **분리 사유** (2026-05-11): `lib/i18n.tsx` 의 `'use client'` 안에 있던
 * `getServerTranslations` 가 server 에서 호출되면 Next.js 가 "client function 을
 * server 에서 못 부름" 에러 던짐 → NotFound 폴백 → admin hydration mismatch (#418)
 * 까지 chain. 이 파일에는 `'use client'` 추가 X.
 *
 * 사용 예:
 *   const t = getServerTranslations(cms.siteLang);
 *   <h1>{t('page.not_found_title')}</h1>
 */

import {
  type Lang,
  isValidLang,
  FALLBACK_LANG,
  translate,
  normalizeLang as normalizeLangShared,
} from './i18n-shared';

/** Server Component 안에서 사용 — siteLang 받아 t() 함수 응답. */
export function getServerTranslations(
  siteLang?: string | null,
): (key: string, params?: Record<string, string | number>) => string {
  const lang: Lang = isValidLang(siteLang) ? siteLang : FALLBACK_LANG;
  return (key, params) => translate(lang, key, params);
}

/** lang 정규화 — server side 도 사용 (cms-related-posts.tsx 등). */
export const normalizeLang = normalizeLangShared;

/** 타입 re-export — server 컨텍스트에서 직접 import 가능. */
export type { Lang } from './i18n-shared';
