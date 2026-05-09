'use client';

/**
 * SetupWizard — 첫 부팅 시 관리자 계정·인터페이스 언어·시간대 입력.
 *
 * 흐름:
 *   1. /api/auth/setup GET → isAdminSetup=false 일 때 login 페이지가 이 컴포넌트 렌더
 *   2. 사용자가 ID·비밀번호·언어·시간대 입력 후 제출
 *   3. /api/auth/setup POST → 모두 Vault 저장 + 자동 로그인 (세션 쿠키 발급)
 *   4. 완료 시 /admin 으로 이동
 *
 * 비밀번호 정책: 대소문자·숫자·특수문자 포함 8자 이상, ID 와 동일 금지.
 *
 * API 키 / CLI 인증은 위자드에서 받지 않습니다 — 어드민 진입 후 설정 화면에서 별도 등록.
 */
import { useState } from 'react';
import { useTranslations } from '../../../lib/i18n';

interface Props {
  onComplete: () => void;
}

const TIMEZONE_OPTIONS = [
  { value: 'Asia/Seoul',     label: '서울 (UTC+9)' },
  { value: 'Asia/Tokyo',     label: '도쿄 (UTC+9)' },
  { value: 'Asia/Shanghai',  label: '상하이 (UTC+8)' },
  { value: 'Asia/Singapore', label: '싱가포르 (UTC+8)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (UTC-8/-7)' },
  { value: 'America/New_York',    label: 'New York (UTC-5/-4)' },
  { value: 'Europe/London',  label: 'London (UTC+0/+1)' },
  { value: 'Europe/Berlin',  label: 'Berlin (UTC+1/+2)' },
  { value: 'UTC',            label: 'UTC' },
];

const PASSWORD_RE = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]).{8,}$/;

function detectBrowserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
}

export function SetupWizard({ onComplete }: Props) {
  const t = useTranslations();
  const [adminId, setAdminId] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [siteLang, setSiteLang] = useState<'ko' | 'en'>('ko');
  const [timezone, setTimezone] = useState<string>(() => detectBrowserTimezone());
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!adminId.trim()) { setError(t('setup.err_id_required')); return; }
    if (!PASSWORD_RE.test(adminPassword)) {
      setError(t('setup.err_password_policy'));
      return;
    }
    if (adminPassword.toLowerCase() === adminId.trim().toLowerCase()) {
      setError(t('setup.err_password_same_as_id'));
      return;
    }
    if (adminPassword !== confirmPassword) { setError(t('setup.err_password_mismatch')); return; }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminId: adminId.trim(),
          adminPassword,
          siteLang,
          timezone,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || t('setup.err_failed'));
        setSubmitting(false);
        return;
      }
      onComplete();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('setup.err_network');
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[440px] bg-white border border-[#eaeaea] rounded-xl shadow-sm p-8">
      <div className="mb-6 text-center">
        <h2 className="text-2xl font-bold text-black mb-1">{t('setup.title')}</h2>
        <p className="text-sm text-gray-500">{t('setup.subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.admin_id')}</label>
          <input
            type="text"
            value={adminId}
            onChange={(e) => setAdminId(e.target.value)}
            disabled={submitting}
            autoFocus
            className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:bg-slate-50"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.password')}</label>
          <input
            type="password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            disabled={submitting}
            className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:bg-slate-50"
          />
          <p className="text-[11px] text-gray-500">{t('setup.password_hint')}</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.password_confirm')}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
            className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:bg-slate-50"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.interface_lang')}</label>
          <div className="flex gap-2">
            {(['ko', 'en'] as const).map(lang => (
              <button
                key={lang}
                type="button"
                onClick={() => setSiteLang(lang)}
                disabled={submitting}
                className={`flex-1 py-2 text-sm font-medium rounded-md border transition-colors ${
                  siteLang === lang
                    ? 'bg-blue-50 border-blue-500 text-blue-700'
                    : 'bg-white border-[#eaeaea] text-gray-600 hover:border-gray-300'
                } disabled:opacity-50`}
              >
                {lang === 'ko' ? '한국어' : 'English'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.timezone')}</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={submitting}
            className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:bg-slate-50"
          >
            {TIMEZONE_OPTIONS.some(o => o.value === timezone) ? null : (
              <option value={timezone}>{timezone} (브라우저 자동 감지)</option>
            )}
            {TIMEZONE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-[13px] text-red-600 font-medium bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div className="pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium h-10 rounded-md text-sm transition-colors flex items-center justify-center shadow-sm"
          >
            {submitting ? t('setup.submitting') : t('setup.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
