'use client';

import { useState, useEffect } from 'react';
import { Menu } from 'lucide-react';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 사이드바 상태 동기화 — page.tsx에서 발행하는 이벤트 수신
  useEffect(() => {
    const handler = (e: Event) => setSidebarOpen((e as CustomEvent).detail?.open ?? false);
    window.addEventListener('firebat-sidebar-state', handler);
    return () => window.removeEventListener('firebat-sidebar-state', handler);
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  return (
    <div className="h-dvh bg-[#fafafa] flex flex-col font-sans tracking-tight overflow-hidden">
      <header className="h-12 bg-white border-b border-[#eaeaea] flex items-center justify-between px-3 md:px-6 sticky top-0 z-50 shrink-0">
        <div className="flex items-center gap-2.5">
          {/* 모바일 사이드바 토글 */}
          <button
            onClick={() => window.dispatchEvent(new Event('firebat-toggle-sidebar'))}
            className={`md:hidden p-1.5 -ml-1 rounded-lg transition-colors ${sidebarOpen ? 'bg-slate-200 text-slate-700' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            <Menu size={18} />
          </button>
          <div className="w-7 h-7 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center shadow-sm">
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
        <button onClick={handleLogout} className="text-[12px] border border-[#eaeaea] bg-white rounded-md px-2.5 py-1 font-medium text-gray-500 hover:text-black hover:bg-gray-50 transition-colors shadow-sm">
          Logout
        </button>
      </header>
      <main className="flex-1 flex overflow-hidden">
        {children}
      </main>
    </div>
  );
}
