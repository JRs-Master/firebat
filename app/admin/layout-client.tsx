'use client';

import { useState, useEffect } from 'react';
import { LangProvider, useTranslations } from '../../lib/i18n';
import { FirebatQueryProvider } from '../../lib/query-client';
import { apiPost } from '../../lib/api-fetch';
import { setEventsHubMode } from './hooks/events-manager';

/** hub page wrapper — visitor lang server-side detect (cookie + Accept-Language)
 *  → SSR/client 동일 locale → hydration mismatch 차단. 옛 navigator.language 사용한
 *  client-only 부분 = SSR 시 'en' / client 시 동적 → React #418 (hydration text mismatch).
 *  + FirebatQueryProvider (CronPanel / TemplatesPanel / GalleryPanel 안 useQuery 동작).
 *  admin layout 안에 있던 provider 가 (user) route 쪽에는 없어 hub mode 안
 *  사이드바 panel 진입 시 "No QueryClient set" throw 가 일어나던 fix. */
export function ConsoleLayoutInner({
  children,
  hubMode,
  initialLang,
}: {
  children: React.ReactNode;
  hubMode?: boolean;
  /** server-side 에서 결정한 visitor lang — hub fallback render (server component) 안 cookie +
   *  Accept-Language header 로 detect 후 prop 전달. undefined = admin path */
  initialLang?: 'ko' | 'en';
}) {
  // hub mode = 익명 visitor → admin SSE `/api/events` 구독 차단 (인증 실패 무한 재연결 fix).
  // module-level 플래그라 render 시점 즉시 set — useEffect 안에 두면 첫 subscribe (Sidebar mount)
  // 보다 늦어 race. 본 컴포넌트 mount = hub page 진입 시점이라 동기 set 안전.
  if (typeof window !== 'undefined') {
    setEventsHubMode(!!hubMode);
  }
  if (hubMode) {
    return (
      <LangProvider forceLocale={initialLang ?? 'ko'}>
        <FirebatQueryProvider>
          <ConsoleLayoutBody hubMode>{children}</ConsoleLayoutBody>
        </FirebatQueryProvider>
      </LangProvider>
    );
  }
  return <ConsoleLayoutBody>{children}</ConsoleLayoutBody>;
}

function ConsoleLayoutBody({ children, hubMode }: { children: React.ReactNode; hubMode?: boolean }) {
  const t = useTranslations();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 사이드바 상태 동기화 — page.tsx에서 발행하는 이벤트 수신
  useEffect(() => {
    const handler = (e: Event) => setSidebarOpen((e as CustomEvent).detail?.open ?? false);
    window.addEventListener('firebat-sidebar-state', handler);
    return () => window.removeEventListener('firebat-sidebar-state', handler);
  }, []);

  const handleLogout = async () => {
    try {
      await apiPost('/api/auth/logout', undefined, { category: 'auth' });
    } catch {
      // 실패해도 로그아웃 진행
    }
    window.location.href = '/login';
  };

  return (
    <div className="h-dvh bg-[#fafafa] flex flex-col font-sans tracking-tight overflow-hidden">
      <header className="h-12 bg-white border-b border-[#eaeaea] flex items-center justify-between px-3 md:px-6 sticky top-0 z-50 shrink-0">
        <div className="flex items-center gap-2.5">
          {/* 모바일: 유령 아이콘 = 사이드바 토글 */}
          <button
            onClick={() => window.dispatchEvent(new Event('firebat-toggle-sidebar'))}
            className={`md:hidden w-7 h-7 rounded-lg border flex items-center justify-center shadow-sm transition-colors ${
              sidebarOpen ? 'bg-blue-50 border-blue-100' : 'bg-white border-slate-200'
            }`}
            aria-label={t('sidebar.workspace')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className={`w-4 h-4 transition-colors ${sidebarOpen ? 'text-blue-600' : 'text-slate-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 10h.01" />
              <path d="M15 10h.01" />
              <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
            </svg>
          </button>
          {/* PC: 유령 장식 (토글은 사이드바 w-12 아이콘바) */}
          <div className="hidden md:flex w-7 h-7 rounded-lg bg-blue-50 border border-blue-100 items-center justify-center shadow-sm">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 10h.01" />
              <path d="M15 10h.01" />
              <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
            </svg>
          </div>
          <h1 className="text-[13px] font-bold text-black flex items-center gap-1.5">
            Firebat
            <span className="bg-gray-100 text-gray-500 px-1 py-0.5 rounded text-[9px] uppercase font-bold tracking-widest border border-gray-200">V1.0</span>
          </h1>
        </div>
        {/* Hub page mode = 익명 방문자라 logout 의미 X — hide */}
        {!hubMode && (
          <button onClick={handleLogout} className="text-[12px] border border-[#eaeaea] bg-white rounded-md px-2.5 py-1 font-medium text-gray-500 hover:text-black hover:bg-gray-50 transition-colors shadow-sm">
            {t('common.logout')}
          </button>
        )}
      </header>
      <main className="flex-1 flex overflow-hidden">
        {children}
      </main>
    </div>
  );
}
