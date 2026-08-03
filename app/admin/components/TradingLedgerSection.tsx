'use client';

/**
 * 자동매매 원장 뷰어 — 포지션·주문·체결·이벤트.
 *
 * The module already answers all of this (`report`); until now the only way to read it was to open
 * the sqlite on the server, which is what everyone actually did. The four tables are the four
 * questions asked while a cycle is live: what do we hold, what is outstanding, what actually
 * happened, and what did the engine refuse.
 *
 * Two ledgers, one at a time. Paper and live are separate files on purpose — a paper fill in the
 * live book breaks the reconciliation invariant — so the store is named rather than merged.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { apiPost } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';

type Row = Record<string, any>;

interface Report {
  mode?: string;
  store?: string;
  tripped?: boolean;
  positions?: Row[];
  orders?: Row[];
  ledger?: Row[];
  events?: Row[];
  transfers?: Row[];
}

/** Epoch ms → local wall clock, minutes resolution. Seconds add noise at this density. */
function when(ms: any): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Quantities run from eight-decimal coins to whole shares, so significant digits, not fixed. */
function num(v: any, max = 8): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n !== 0 && Math.abs(n) < 1) return String(Number(n.toPrecision(4)));
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(max, 2) });
}

const STATE_TONE: Record<string, string> = {
  filled: 'bg-emerald-50 text-emerald-700',
  partial: 'bg-amber-50 text-amber-700',
  acked: 'bg-blue-50 text-blue-700',
  sent: 'bg-blue-50 text-blue-700',
  canceling: 'bg-slate-100 text-slate-600',
  canceled: 'bg-slate-100 text-slate-500',
  unknown: 'bg-rose-50 text-rose-700',
  void: 'bg-slate-100 text-slate-400 line-through',
};

function Table({ head, rows, empty, maxH }: {
  head: string[];
  rows: (string | number)[][];
  empty: string;
  /** Tall lists scroll in place — a hundred orders should not push the tabs off the screen. */
  maxH?: string;
}) {
  if (!rows.length) return <p className="px-1 py-3 text-[11px] text-slate-400 italic">{empty}</p>;
  return (
    // Wide on a phone, and long everywhere: the table scrolls inside its own box in both
    // directions rather than moving the page. `scrollbar-thin` because without it these are the
    // only bars on the screen drawn by the browser's own chrome, and they read as heavier than
    // every other scroll in the app.
    <div
      className={`overflow-x-auto overflow-y-auto scrollbar-thin rounded-lg border border-slate-200 ${maxH ?? ''}`}
    >
      <table className="w-full text-[11px] whitespace-nowrap">
        <thead>
          <tr className="bg-slate-50 text-slate-500 sticky top-0 z-10">
            {head.map(h => <th key={h} className="px-2 py-1.5 text-left font-bold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-100">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1.5 text-slate-700 align-top">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ text }: { text: string }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 font-bold ${STATE_TONE[text] ?? 'bg-slate-100 text-slate-600'}`}>
      {text}
    </span>
  );
}

export function TradingLedgerSection({ moduleName }: { moduleName: string }) {
  const [store, setStore] = useState<'live' | 'dryrun'>('live');
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiPost<{ success: boolean; data?: Report }>(
        '/api/module/run',
        { module: moduleName, data: { action: 'report', store, limit: 100 } },
        { category: 'system-module' },
      );
      setData(res.success ? (res.data ?? null) : null);
    } catch (e) {
      logger.debug('system-module', '원장 조회 실패', { error: e });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [moduleName, store]);
  useEffect(() => { load(); }, [load]);

  const positions = (data?.positions ?? []).filter(p => Number(p.qty) !== 0 || Number(p.realized_pnl) !== 0);
  const orders = data?.orders ?? [];
  const ledger = data?.ledger ?? [];
  const events = data?.events ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {(['live', 'dryrun'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStore(s)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                store === s ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {s === 'live' ? '실거래·모의' : '종이'}
            </button>
          ))}
          {data?.mode && (
            <span className="ml-1 text-[10px] text-slate-400">현재 모드 {data.mode}</span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-50"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} 새로고침
        </button>
      </div>

      {data?.tripped && (
        <div className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-2.5 py-2 text-[11px] text-rose-700">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>
            매매가 정지돼 있습니다 — 일일 손실 한도에 걸렸거나 원장 대조가 어긋났습니다.
            아래 이벤트에서 사유를 확인한 뒤 해제하십시오.
          </span>
        </div>
      )}

      <Section title="포지션" count={positions.length}>
        <Table
          head={['전략', '종목', '수량', '평단', '실현손익', '상태']}
          empty="보유 중인 포지션이 없습니다."
          rows={positions.map(p => [
            String(p.strategy_id ?? ''),
            String(p.symbol ?? ''),
            num(p.qty),
            num(p.avg_price),
            num(p.realized_pnl),
            <Badge key="s" text={String(p.state ?? 'ok')} /> as any,
          ])}
        />
      </Section>

      <Section title="주문" count={orders.length}>
        <Table
          maxH="max-h-72"
          head={['시각', '전략', '종목', '방향', '수량', '요청가', '체결', '평균', '상태', '사유']}
          empty="주문 기록이 없습니다."
          rows={orders.map(o => [
            when(o.ts_ms),
            String(o.strategy_id ?? ''),
            String(o.symbol ?? ''),
            String(o.side ?? ''),
            num(o.req_qty),
            num(o.req_price),
            num(o.filled_qty),
            num(o.filled_avg),
            <Badge key="s" text={String(o.state ?? '')} /> as any,
            // The error is why an order stopped being ordinary, and it is the thing you came for.
            String(o.error || o.reason || ''),
          ])}
        />
      </Section>

      <Section title="체결" count={ledger.length}>
        <Table
          maxH="max-h-72"
          head={['시각', '전략', '종목', '방향', '수량', '가격', '수수료', '실현손익', '출처']}
          empty="체결이 없습니다."
          rows={ledger.map(l => [
            when(l.ts_ms),
            String(l.strategy_id ?? ''),
            String(l.symbol ?? ''),
            String(l.side ?? ''),
            num(l.qty),
            num(l.price),
            num(Number(l.fee ?? 0) + Number(l.tax ?? 0)),
            num(l.realized_pnl),
            String(l.source ?? ''),
          ])}
        />
      </Section>

      <Section title="이벤트" count={events.length}>
        <Table
          maxH="max-h-64"
          head={['시각', '종류', '전략', '내용']}
          empty="이벤트가 없습니다."
          rows={events.map(e => [
            when(e.ts_ms),
            String(e.kind ?? ''),
            String(e.strategy_id ?? ''),
            String(e.detail ?? '').slice(0, 200),
          ])}
        />
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-bold text-slate-700">{title}</span>
        <span className="text-[10px] text-slate-400">{count}</span>
      </div>
      {children}
    </div>
  );
}
