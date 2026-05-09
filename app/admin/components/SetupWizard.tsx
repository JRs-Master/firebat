'use client';

/**
 * SetupWizard — 첫 부팅 시 관리자 계정·인터페이스 언어·시간대 입력.
 *
 * 흐름:
 *   1. /api/auth/setup GET → isAdminSetup=false 일 때 login 페이지가 이 컴포넌트 렌더
 *   2. 언어는 LangProvider 의 lang 그대로 사용 — 토글 클릭 시 화면 즉시 전환
 *      (마운트 시 navigator.language 자동 감지 — localStorage 미설정 시)
 *   3. 사용자가 ID·비밀번호·언어·시간대 입력 후 제출
 *   4. /api/auth/setup POST → 모두 Vault 저장 + 자동 로그인 (세션 쿠키 발급)
 *   5. 완료 시 /admin 으로 이동
 *
 * 비밀번호 정책: 대소문자·숫자·특수문자 포함 8자 이상, ID 와 동일 금지.
 *
 * Timezone 옵션 — `lib/timezones.ts` 단일 source (어드민 설정과 공유).
 *
 * API 키 / CLI 인증은 위자드에서 받지 않습니다 — 어드민 진입 후 설정 화면에서 별도 등록.
 */
import { useEffect, useState } from 'react';
import { useTranslations, useLang, type Lang } from '../../../lib/i18n';
import { TIMEZONE_OPTIONS, timezoneLabel } from '../../../lib/timezones';

interface Props {
  onComplete: () => void;
}

const PASSWORD_RE = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]).{8,}$/;

/** 단순 채점 — 0(빈)·1(weak)·2(medium)·3(strong). 의존성 0. */
function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(pw)) score++;
  if (pw.length >= 12) score++;
  if (score <= 2) return 1;
  if (score <= 3) return 2;
  return 3;
}

function detectBrowserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

function detectBrowserLang(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const nav = navigator.language?.toLowerCase() || '';
  return nav.startsWith('ko') ? 'ko' : 'en';
}

export function SetupWizard({ onComplete }: Props) {
  const t = useTranslations();
  const { lang, setLang } = useLang();

  const [adminId, setAdminId] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [timezone, setTimezone] = useState<string>(() => detectBrowserTimezone());
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 첫 마운트 — localStorage 미설정 시 navigator.language 기반 자동 감지
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem('firebat_ui_lang')) return; // 사용자가 이미 선택
    const detected = detectBrowserLang();
    if (detected !== lang) setLang(detected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          siteLang: lang,
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

  const browserTz = (() => {
    const knownValues = new Set(TIMEZONE_OPTIONS.map(o => o.value));
    return knownValues.has(timezone) ? null : timezone;
  })();

  return (
    <div className="w-full max-w-[440px] bg-white border border-[#eaeaea] rounded-xl shadow-sm p-8">
      <div className="mb-6 text-center">
        <h2 className="text-2xl font-bold text-black mb-1">{t('setup.title')}</h2>
        <p className="text-sm text-gray-500">{t('setup.subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 언어 — 최상단 (외국인이 한글 위자드에 막히지 않게) */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.interface_lang')}</label>
          <div className="flex gap-2">
            {(['ko', 'en'] as const).map(l => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                disabled={submitting}
                className={`flex-1 py-2 text-sm font-medium rounded-md border transition-colors ${
                  lang === l
                    ? 'bg-blue-50 border-blue-500 text-blue-700'
                    : 'bg-white border-[#eaeaea] text-gray-600 hover:border-gray-300'
                } disabled:opacity-50`}
              >
                {l === 'ko' ? '한국어' : 'English'}
              </button>
            ))}
          </div>
        </div>

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
          {adminPassword && (() => {
            const s = passwordStrength(adminPassword);
            const barColor = s === 1 ? 'bg-red-500' : s === 2 ? 'bg-amber-500' : 'bg-green-500';
            const labelColor = s === 1 ? 'text-red-600' : s === 2 ? 'text-amber-600' : 'text-green-600';
            const labelKey = s === 1 ? 'setup.password_strength_weak' : s === 2 ? 'setup.password_strength_medium' : 'setup.password_strength_strong';
            return (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1 bg-slate-200 rounded overflow-hidden">
                  <div className={`h-full ${barColor} transition-all`} style={{ width: `${(s / 3) * 100}%` }} />
                </div>
                <span className={`text-[11px] font-medium ${labelColor} min-w-[36px] text-right`}>{t(labelKey)}</span>
              </div>
            );
          })()}
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
          {confirmPassword && (() => {
            const match = adminPassword === confirmPassword;
            return (
              <p className={`text-[11px] font-medium ${match ? 'text-green-600' : 'text-red-600'}`}>
                {match ? '✓ ' : '✗ '}{t(match ? 'setup.password_match' : 'setup.password_no_match')}
              </p>
            );
          })()}
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-gray-700 block">{t('setup.timezone')}</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={submitting}
            className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:bg-slate-50"
          >
            {browserTz && (
              <option value={browserTz}>{browserTz} {t('setup.tz_browser_detected')}</option>
            )}
            {TIMEZONE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{timezoneLabel(opt, lang)}</option>
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
