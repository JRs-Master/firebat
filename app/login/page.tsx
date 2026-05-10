/**
 * Login page — server component.
 * cookie 의 `firebat_ui_lang` 을 server 가 읽어 LangProvider 의 `initial` 로 전달.
 * 인증 무관 영역이라 `enableServerSync={false}` — /api/settings 호출 없음 (401 콘솔 더럽힘 0).
 * UI 자체는 'use client' 의 LoginInner 가 담당 (login-client.tsx).
 */

import { cookies } from 'next/headers';
import { LangProvider } from '../../lib/i18n';
import { isValidLang, INITIAL_LANG, type Lang } from '../../lib/i18n-shared';
import { LoginInner } from './login-client';

const COOKIE_NAME = 'firebat_ui_lang';

export default async function Login() {
  const store = await cookies();
  const cookieLang = store.get(COOKIE_NAME)?.value;
  const initial: Lang = isValidLang(cookieLang) ? cookieLang : INITIAL_LANG;
  return (
    <LangProvider initial={initial}>
      <LoginInner />
    </LangProvider>
  );
}
