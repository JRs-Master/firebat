'use client';

import { useEffect, useState } from 'react';
import { alertDialog } from '../admin/components/Dialog';
import { SetupWizard } from '../admin/components/SetupWizard';
import { useTranslations } from '../../lib/i18n';
import { apiGet, apiPost, ApiError } from '../../lib/api-fetch';

export function LoginInner() {
  const t = useTranslations();
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // brute-force 잠금 — 남은 초. >0 이면 "N초 후 로그인 가능" 표시 + 제출 차단, 매초 감소.
  const [lockRemaining, setLockRemaining] = useState(0);
  // setupState: 'checking' (초기) / 'needed' (SetupWizard 노출) / 'done' (정상 login form)
  const [setupState, setSetupState] = useState<'checking' | 'needed' | 'done'>('checking');

  useEffect(() => {
    (async () => {
      try {
        const data = await apiGet<{ isAdminSetup: boolean }>('/api/auth/setup', { category: 'login' });
        setSetupState(data.isAdminSetup === false ? 'needed' : 'done');
      } catch {
        setSetupState('done'); // 네트워크 실패 시 일반 login form 노출 (안전한 fallback)
      }
    })();
  }, []);

  // 잠금 카운트다운 — lockRemaining 이 바뀔 때마다 1초 뒤 1 감소, 0 되면 멈춤(가드).
  useEffect(() => {
    if (lockRemaining <= 0) return;
    const timer = setTimeout(() => setLockRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [lockRemaining]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || lockRemaining > 0) return; // 진행 중 / 잠금 중 재제출 차단
    setSubmitting(true);
    try {
      await apiPost('/api/auth', { id, password }, { category: 'login' });
      window.location.href = '/admin';
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          // brute-force 잠금 — 남은 초로 카운트다운 시작 (틀림 alert 대신).
          const sec = (err.responseBody as { retryAfterSec?: number } | undefined)?.retryAfterSec ?? 60;
          setLockRemaining(sec);
        } else {
          await alertDialog({ title: t('login.failed_title'), message: t('login.failed_message'), danger: true });
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#fafafa] px-4 py-8 font-sans tracking-tight">
      {setupState === 'checking' && (
        <div className="text-sm text-gray-400">{t('login.checking')}</div>
      )}
      {setupState === 'needed' && (
        <SetupWizard onComplete={() => { window.location.href = '/admin'; }} />
      )}
      {setupState === 'done' && (
        <div className="w-full max-w-[400px] bg-white border border-[#eaeaea] rounded-xl shadow-sm p-8">
          <div className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-black mb-1">{t('login.title')}</h2>
            <p className="text-sm text-gray-500">{t('login.subtitle')}</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700 block" htmlFor="login-username">{t('login.username')}</label>
              <input id="login-username" name="username" type="text" autoComplete="username"
                value={id} onChange={(e) => setId(e.target.value)}
                className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700 block" htmlFor="login-password">{t('login.password')}</label>
              <input id="login-password" name="password" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors" />
            </div>
            <div className="pt-2">
              <button type="submit" disabled={submitting || lockRemaining > 0} className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-medium h-10 rounded-md text-sm transition-colors flex items-center justify-center shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-1">
                {t('login.continue')}
              </button>
              {lockRemaining > 0 && (
                <p className="mt-2 text-center text-sm font-medium text-rose-600" role="status" aria-live="polite">
                  {t('login.locked', { sec: lockRemaining })}
                </p>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
