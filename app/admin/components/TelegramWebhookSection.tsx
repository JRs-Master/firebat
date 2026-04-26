'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { FeedbackBadge } from './FeedbackBadge';

/**
 * 텔레그램 양방향 봇 webhook 등록 섹션 — SystemModuleSettings 의 telegram 모듈 페이지에서만 노출.
 *
 * 흐름:
 *   1. TELEGRAM_BOT_TOKEN 등록 (위 secret 입력 필드)
 *   2. TELEGRAM_OWNER_IDS 등록 (위 secret 입력 필드, comma-sep)
 *   3. 도메인 입력 + "웹훅 등록" 버튼 → POST /api/telegram/setup
 *   4. 등록 후 텔레그램 봇이 사용자 메시지 받음 → /api/telegram/webhook → AI 처리 → 응답
 *
 * 등록 해제: "비활성화" 버튼 → DELETE /api/telegram/setup
 */
export function TelegramWebhookSection() {
  const [status, setStatus] = useState<{
    active: boolean;
    url?: string;
    configured: boolean;
    ownerCount: number;
    error?: string;
  } | null>(null);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/telegram/setup');
      const data = await res.json();
      if (data.success) {
        setStatus({
          active: data.active,
          url: data.url,
          configured: data.configured,
          ownerCount: data.ownerCount,
          error: data.error,
        });
        // 처음 로드 시 도메인 자동 추정 — 현재 호스트 기반
        if (typeof window !== 'undefined' && !domain) {
          setDomain(`${window.location.protocol}//${window.location.host}`);
        }
      }
    } catch {}
  }, [domain]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSetup = async () => {
    if (!domain.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/telegram/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ kind: 'ok', text: `등록 완료 — ${data.webhookUrl}` });
        await refresh();
      } else {
        setMessage({ kind: 'err', text: data.error || '등록 실패' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || 'network error' });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm('웹훅을 해제하시겠습니까? 텔레그램 명령 수신이 중단됩니다.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/telegram/setup', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setMessage({ kind: 'ok', text: '해제 완료' });
        await refresh();
      } else {
        setMessage({ kind: 'err', text: data.error || '해제 실패' });
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || 'network error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-3 mt-2 border-t border-slate-200">
      <div className="flex items-center justify-between">
        <label className="text-xs sm:text-sm font-bold text-slate-700">양방향 봇 (Webhook)</label>
        <div className="flex items-center gap-2 text-[11px] sm:text-[12px]">
          {status?.active ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              활성
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
              비활성
            </span>
          )}
          {status && (
            <span className="text-slate-500">owner: {status.ownerCount}명</span>
          )}
        </div>
      </div>

      <p className="text-[10px] sm:text-xs text-slate-500 leading-relaxed">
        등록 전 위에서 <code className="px-1 bg-slate-100 rounded text-slate-700">TELEGRAM_BOT_TOKEN</code>·<code className="px-1 bg-slate-100 rounded text-slate-700">TELEGRAM_OWNER_IDS</code> 를 채우세요.
        OWNER_IDS = 텔레그램 user ID, comma 구분 (예: <code className="px-1 bg-slate-100 rounded">123456789,987654321</code>). @userinfobot 로 확인 가능.
        등록 후 텔레그램에서 owner 가 메시지 보내면 AI 가 자동 응답합니다.
      </p>

      {status?.active && status.url && (
        <div className="text-[10px] sm:text-[11px] text-slate-400 font-mono break-all bg-slate-50 border border-slate-200 rounded px-2 py-1">
          {status.url}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={domain}
          onChange={e => { setDomain(e.target.value); setMessage(null); }}
          placeholder="https://firebat.co.kr"
          disabled={busy}
          className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] sm:text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-50"
        />
        {status?.active ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy}
            className="px-3 py-1.5 bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 rounded-lg text-[12px] sm:text-[13px] font-bold transition-colors disabled:bg-slate-50 disabled:text-slate-400 flex items-center gap-1.5 justify-center"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            비활성화
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSetup}
            disabled={busy || !domain.trim() || !status?.configured}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[12px] sm:text-[13px] font-bold transition-colors disabled:bg-slate-300 flex items-center gap-1.5 justify-center"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            웹훅 등록
          </button>
        )}
      </div>

      {/* 자세한 메시지 (등록 URL 등) — 짧은 결과는 FeedbackBadge 가 표시, 자세한 정보는 별도 표시 */}
      {message && (
        <div className={`text-[10px] flex items-center gap-1.5 ${message.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'} break-all`}>
          <FeedbackBadge state={message.kind === 'ok' ? 'ok' : 'err'} okLabel="완료" errLabel="실패" />
          <span>{message.text}</span>
        </div>
      )}

      {status?.error && !message && (
        <div className="text-[11px] text-amber-600">{status.error}</div>
      )}
    </div>
  );
}
