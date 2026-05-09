'use client';
import { useEffect, useState } from 'react';
import { alertDialog } from '../admin/components/Dialog';
import { SetupWizard } from '../admin/components/SetupWizard';

export default function Login() {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  // setupState: 'checking' (초기) / 'needed' (SetupWizard 노출) / 'done' (정상 login form)
  const [setupState, setSetupState] = useState<'checking' | 'needed' | 'done'>('checking');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/setup');
        const data = await res.json();
        setSetupState(data.isAdminSetup === false ? 'needed' : 'done');
      } catch {
        setSetupState('done'); // 네트워크 실패 시 일반 login form 노출 (안전한 fallback)
      }
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password }) });
    if (res.ok) { window.location.href = '/admin'; }
    else { await alertDialog({ title: '로그인 실패', message: '아이디 또는 비밀번호가 올바르지 않습니다.', danger: true }); }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#fafafa] px-4 py-8 font-sans tracking-tight">
      {setupState === 'checking' && (
        <div className="text-sm text-gray-400">초기 상태 확인 중…</div>
      )}
      {setupState === 'needed' && (
        <SetupWizard onComplete={() => { window.location.href = '/admin'; }} />
      )}
      {setupState === 'done' && (
        <div className="w-full max-w-[400px] bg-white border border-[#eaeaea] rounded-xl shadow-sm p-8">
          <div className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-black mb-1">Firebat 로그인</h2>
            <p className="text-sm text-gray-500">관리자 계정으로 로그인하세요</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700 block">아이디</label>
              <input type="text" value={id} onChange={(e) => setId(e.target.value)}
                className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700 block">비밀번호</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors" />
            </div>
            <div className="pt-2">
              <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium h-10 rounded-md text-sm transition-colors flex items-center justify-center shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-1">
                계속
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
