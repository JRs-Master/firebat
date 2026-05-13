/**
 * Admin console layout — server component.
 * cookie 의 `firebat_ui_lang` 을 server 가 읽어 LangProvider 의 `initial` prop 으로 전달.
 * SSR 과 client hydration 이 같은 lang 으로 시작 → hydration mismatch + 한 프레임 flash 0.
 * UI 자체는 'use client' 의 ConsoleLayoutInner 가 담당 (layout-client.tsx).
 */

import { cookies } from 'next/headers';
import { LangProvider } from '../../lib/i18n';
import { isValidLang, INITIAL_LANG, type Lang } from '../../lib/i18n-shared';
import { FirebatQueryProvider } from '../../lib/query-client';
import { ConsoleLayoutInner } from './layout-client';

const COOKIE_NAME = 'firebat_ui_lang';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const cookieLang = store.get(COOKIE_NAME)?.value;
  const initial: Lang = isValidLang(cookieLang) ? cookieLang : INITIAL_LANG;
  return (
    <LangProvider initial={initial} enableServerSync>
      <FirebatQueryProvider>
        <ConsoleLayoutInner>{children}</ConsoleLayoutInner>
      </FirebatQueryProvider>
    </LangProvider>
  );
}
