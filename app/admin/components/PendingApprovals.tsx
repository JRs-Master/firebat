'use client';

/**
 * PendingApprovals — cards waiting for approval, wherever they came from.
 *
 * An approval card is delivered inside the chat message that produced it, so a card created outside
 * a chat had no surface at all: an editor's MCP client, the CLI or a script would write one to the
 * store, be told the call succeeded, and leave a card nobody could find. Measured 2026-08-05: three
 * `save_page` cards sat in the store for an hour while the screen showed nothing.
 *
 * This is the place they show up. It hides itself when there is nothing waiting, so it costs nothing
 * on the normal path — a badge that is always there stops being read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldQuestion, Check, X, Loader2 } from 'lucide-react';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import { useTranslations } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { useEvents } from '../hooks/events-manager';

interface Card {
  planId: string;
  summary?: string;
  createdAt?: number;
  expiresAt?: number;
  args?: { name?: string } & Record<string, unknown>;
}

/** Backstop interval. The card arrives by push (`plan:pending`); this catches a dropped SSE.
 *
 *  A card created DURING a chat turn rides that turn's own stream. A card created outside one —
 *  an external MCP client asking for something that needs approval — has no stream, and this poll
 *  used to be its only path: up to twenty seconds of nothing on screen. The store now announces
 *  every card on the bus at the moment it is created, so the poll is no longer the mechanism. */
const POLL_MS = 20000;

function when(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** What the card would do, in the words of the thing it acts on.
 *
 *  Translated, not hardcoded: this is a label a person reads. Falls back to the tool's own name
 *  when there is no key for it — a new destructive tool should still be describable the day it
 *  lands, rather than showing nothing until someone remembers the translation. */
const ACTION_KEYS = new Set(['save_page', 'write_file', 'delete_file', 'delete_page',
                             'schedule_task', 'cancel_cron_job', 'run_module']);

function describe(c: Card, t: (k: string) => string): string {
  const a = c.args ?? {};
  const name = String(a.name ?? '');
  const target = String(a.slug ?? a.path ?? a.module ?? a.jobId ?? '');
  const label = ACTION_KEYS.has(name) ? t(`plan.action_${name}`) : name;
  return [label, target].filter(Boolean).join(' · ');
}

export function PendingApprovals() {
  const t = useTranslations();
  const [cards, setCards] = useState<Card[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ success: boolean; data?: Card[] }>(
        '/api/plan/pending', { category: 'plan' });
      setCards(res.success ? (res.data ?? []) : []);
    } catch (e) {
      logger.debug('plan', '대기 승인 조회 실패', { error: e });
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // A card created outside a chat turn has no stream to arrive on, so the store announces it.
  // The poll above stays as the backstop for a client whose SSE has dropped — the events manager
  // re-emits on reconnect, but a card born during the gap is only found by re-reading.
  useEvents(['plan:pending'], load);

  useEffect(() => {
    if (!open) { setCoords(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      setCoords({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 348)),
        bottom: window.innerHeight - r.top + 8,
      });
    }
  }, [open, cards.length]);

  const act = useCallback(async (planId: string, approve: boolean) => {
    setBusy(planId);
    try {
      await apiPost(`/api/plan/${approve ? 'commit' : 'reject'}?planId=${encodeURIComponent(planId)}`,
                    {}, { category: 'plan' });
    } catch (e) {
      logger.debug('plan', approve ? '승인 실패' : '거절 실패', { error: e });
    } finally {
      setBusy(null);
      load();
    }
  }, [load]);

  if (!cards.length) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-100"
        title={t('plan.external_tooltip')}
      >
        <ShieldQuestion size={13} />
        {t('plan.external_badge', { count: cards.length })}
      </button>

      {open && coords && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-[340px] max-h-[60vh] overflow-y-auto scrollbar-thin rounded-xl border border-slate-200 bg-white p-2 shadow-xl"
            style={{ left: coords.left, bottom: coords.bottom }}
          >
            <p className="px-1.5 pb-1.5 text-[11px] font-bold text-slate-600">
              {t('plan.external_title')}
            </p>
            {cards.map(c => (
              <div key={c.planId} className="rounded-lg border border-slate-200 p-2 mb-1.5 last:mb-0">
                <div className="text-[11px] font-bold text-slate-700">{describe(c, t)}</div>
                {c.summary && (
                  <div className="mt-0.5 text-[11px] text-slate-500 break-all">{c.summary}</div>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">{when(c.createdAt)}</span>
                  <span className="ml-auto flex gap-1">
                    <button
                      type="button"
                      disabled={busy === c.planId}
                      onClick={() => act(c.planId, true)}
                      className="flex items-center gap-0.5 rounded bg-blue-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy === c.planId
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Check size={11} />} {t('plan.approve')}
                    </button>
                    <button
                      type="button"
                      disabled={busy === c.planId}
                      onClick={() => act(c.planId, false)}
                      className="flex items-center gap-0.5 rounded border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <X size={11} /> {t('plan.reject')}
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>,
        document.body)}
    </>
  );
}
