'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  slug: string;
  title: string;
  isProjectPassword?: boolean;
  projectName?: string;
}

/** 비밀번호 보호 페이지 게이트 — 비밀번호 입력 후 검증 성공 시 페이지 새로고침 */
export function PasswordGate({ slug, title, isProjectPassword, projectName }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setLoading(true);
    setError('');

    try {
      const url = isProjectPassword
        ? '/api/fs/projects/verify'
        : `/api/pages/${encodeURIComponent(slug)}/visibility`;

      const body = isProjectPassword
        ? { project: projectName, password }
        : { password };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.verified) {
        // 쿠키에 인증 토큰 저장 후 새로고침
        const key = isProjectPassword ? `fp_${projectName}` : `fp_${slug}`;
        document.cookie = `${key}=${encodeURIComponent(password)};path=/;max-age=86400;SameSite=Lax`;
        router.refresh();
      } else {
        setError('비밀번호가 올바르지 않습니다');
      }
    } catch {
      setError('오류가 발생했습니다');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-lg font-bold text-slate-800">{title}</h1>
          <p className="text-sm text-slate-400 mt-1">
            {isProjectPassword ? '이 프로젝트는' : '이 페이지는'} 비밀번호로 보호되어 있습니다
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder="비밀번호 입력"
            autoFocus
            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-[15px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
          />
          {error && (
            <p className="text-sm text-red-500 font-medium">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full px-4 py-3 text-[15px] font-bold text-white bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 rounded-xl transition-colors"
          >
            {loading ? '확인 중...' : '확인'}
          </button>
        </form>
      </div>
    </main>
  );
}
