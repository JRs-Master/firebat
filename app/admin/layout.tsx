'use client';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  return (
    <div className="h-dvh bg-[#fafafa] flex flex-col font-sans tracking-tight overflow-hidden">
      <header className="h-14 bg-white border-b border-[#eaeaea] flex items-center justify-between px-4 md:px-6 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center shadow-sm">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 10h.01" />
              <path d="M15 10h.01" />
              <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
            </svg>
          </div>
          <h1 className="text-sm font-bold text-black flex items-center gap-2">
            Firebat
            <span className="bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-widest border border-gray-200">V1.0</span>
          </h1>
        </div>
        <button onClick={handleLogout} className="text-sm border border-[#eaeaea] bg-white rounded-md px-3 py-1.5 font-medium text-gray-600 hover:text-black hover:bg-gray-50 transition-colors shadow-sm">
          Logout
        </button>
      </header>
      <main className="flex-1 flex overflow-hidden">
        {children}
      </main>
    </div>
  );
}
