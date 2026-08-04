'use client';

/**
 * Autotrade ledger viewer — positions, orders, fills, universe, events.
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
  /** The screen, from the universe store — a different database, so it is fetched and shown
   *  separately rather than merged into the trading events. */
  watchlists?: Record<string, Row[]>;
  screenEvents?: Row[];
  /** Realised profit as the ledger states it. Carried inside `report`, so reading it costs no
   *  extra call and no broker query. */
  pnl?: {
    realizedToday?: number;
    realizedTotal?: number;
    sold?: { today?: Leg; total?: Leg };
    transferred?: { today?: Leg; total?: Leg };
    byStrategy?: Row[];
    held?: Row[];
    unrealized?: { total?: number | null; priced?: number; unpriced?: string[] };
  };
}

interface Leg { pnl?: number; fee?: number; tax?: number; count?: number }

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

/** Won, with a sign, because the sign is the whole point. Coins need decimals; won does not. */
function money(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const s = Math.abs(n) < 1 && n !== 0
    ? String(Number(n.toPrecision(4)))
    : Math.round(n).toLocaleString();
  return n > 0 ? `+${s}` : s;
}

/** Green up, red down, grey flat. Never green for a zero — a flat day is not a good day. */
function tone(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'text-slate-500';
  return n > 0 ? 'text-emerald-600' : 'text-rose-600';
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

  // Two different questions that happened to share a table. `strategy_position` keeps a row for
  // anything ever traded, so a sold-out strategy sits there with qty 0 holding the profit it made —
  // and the section called it a position. What is held and what was earned are separate sections now.
  const listed = (data?.positions ?? []).filter(p => Number(p.qty) !== 0 || Number(p.realized_pnl) !== 0);
  const holdings = listed.filter(p => Number(p.qty) !== 0);
  const closed = listed.filter(p => Number(p.qty) === 0);
  const pnl = data?.pnl;
  const orders = data?.orders ?? [];
  const ledger = data?.ledger ?? [];
  const events = data?.events ?? [];
  const watchlists = Object.entries(data?.watchlists ?? {});
  const screened: Row[] = watchlists.flatMap(([trade, rows]) =>
    (rows ?? []).map(r => ({ ...r, trade })));
  const screenEvents = data?.screenEvents ?? [];

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

      {/* The number the whole thing is for. It was computed nowhere and shown nowhere: the ledger
          had every row needed and the only consumer of a realised total was the daily loss limit,
          which asks whether to stop. Fees and taxes sit beside the gain rather than inside it —
          "made 2,080" and "made 2,080 after paying 240" are different sentences. */}
      {pnl && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ['오늘 실현', pnl.realizedToday, pnl.sold?.today],
            ['누적 실현', pnl.realizedTotal, pnl.sold?.total],
          ] as const).map(([label, value, leg]) => (
            <div key={label} className="rounded-lg border border-slate-200 px-2.5 py-2">
              <div className="text-[10px] font-bold text-slate-400">{label}</div>
              <div className={`text-sm font-bold ${tone(value)}`}>{money(value)}</div>
              <div className="text-[10px] text-slate-400">
                {leg?.count ? `${leg.count}회 · 비용 ${money(-((leg.fee ?? 0) + (leg.tax ?? 0)))}` : '거래 없음'}
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-slate-200 px-2.5 py-2">
            <div className="text-[10px] font-bold text-slate-400">평가손익</div>
            {/* Null on purpose when any holding has no price. A partial sum reads as the whole. */}
            <div className={`text-sm font-bold ${
              pnl.unrealized?.total == null ? 'text-slate-400' : tone(pnl.unrealized.total)}`}>
              {pnl.unrealized?.total == null ? '가격 미조회' : money(pnl.unrealized.total)}
            </div>
            <div className="text-[10px] text-slate-400">
              {pnl.unrealized?.unpriced?.length
                ? `${pnl.unrealized.unpriced.length}종목 시세 없음`
                : `${pnl.unrealized?.priced ?? 0}종목`}
            </div>
          </div>
          {/* Shown only when it happened, because a transfer is rare and an always-zero box beside
              the profit invites adding the two. */}
          {!!pnl.transferred?.total?.count && (
            <div className="rounded-lg border border-slate-200 px-2.5 py-2">
              <div className="text-[10px] font-bold text-slate-400">내부이전</div>
              <div className={`text-sm font-bold ${tone(pnl.transferred.total.pnl)}`}>
                {money(pnl.transferred.total.pnl)}
              </div>
              <div className="text-[10px] text-slate-400">매도 아님 · 합산 금지</div>
            </div>
          )}
        </div>
      )}

      <Section title="보유" count={holdings.length}>
        <Table
          head={['전략', '종목', '수량', '평단', '실현손익', '상태']}
          empty="보유 중인 포지션이 없습니다."
          rows={holdings.map(p => [
            String(p.strategy_id ?? ''),
            String(p.symbol ?? ''),
            num(p.qty),
            num(p.avg_price),
            <span key="r" className={tone(p.realized_pnl)}>{money(p.realized_pnl)}</span> as any,
            <Badge key="s" text={String(p.state ?? '')} /> as any,
          ])}
        />
      </Section>

      {/* Sold out, and the row stays because it is where that strategy's realised profit lives.
          It is not a holding, so it is not listed as one. */}
      <Section title="청산 완료" count={closed.length}>
        <Table
          head={['전략', '종목', '실현손익', '상태']}
          empty="청산된 매매가 없습니다."
          rows={closed.map(p => [
            String(p.strategy_id ?? ''),
            String(p.symbol ?? ''),
            <span key="r" className={tone(p.realized_pnl)}>{money(p.realized_pnl)}</span> as any,
            <Badge key="s" text={String(p.state ?? '')} /> as any,
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

      <Section title="종목관리" count={screened.length}>
        <Table
          maxH="max-h-64"
          head={['매매', '종목', '편입', '마지막 확인']}
          empty="화면에 올라온 종목이 없습니다 — 종목관리 스케줄이 아직 안 돌았거나 순위가 비었습니다."
          rows={screened.map(r => [
            String(r.trade ?? ''),
            String(r.symbol ?? ''),
            when(r.enteredMs),
            when(r.lastSeenMs),
          ])}
        />
      </Section>

      <Section title="편입·이탈" count={screenEvents.length}>
        <Table
          maxH="max-h-52"
          head={['시각', '매매', '종목', '사건', '출처']}
          empty="편입·이탈 기록이 없습니다."
          rows={screenEvents.map(e => [
            when(e.ts_ms),
            String(e.trade_id ?? ''),
            String(e.symbol ?? ''),
            String(e.event ?? ''),
            String(e.detail_json ?? '').slice(0, 120),
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
