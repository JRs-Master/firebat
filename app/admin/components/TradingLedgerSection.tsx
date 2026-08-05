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
  /** Currencies whose daily loss limit is currently reached. Separate from `tripped`: this one
   *  stops new buys in that currency only, exits keep running, and it lifts itself when the day's
   *  realised result comes back inside the limit. */
  haltedCurrencies?: string[];
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
    /** Per currency, and never summed across them — adding won to dollars needs a rate the module
     *  does not have. `?` is the bucket for rows whose currency could not be told. */
    currencies?: string[];
    byCurrency?: Record<string, {
      realizedToday?: number;
      realizedTotal?: number;
      sold?: { today?: Leg; total?: Leg };
      transferred?: { today?: Leg; total?: Leg };
    }>;
    byStrategy?: Row[];
    held?: Row[];
    unrealized?: Record<string, { total?: number | null; priced?: number; unpriced?: string[] }>;
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

/** Signed, because the sign is the whole point. Won rounds to units; a dollar or a coin does not. */
function money(v: any, currency?: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const whole = !currency || currency === 'KRW';
  const s = (!whole || (Math.abs(n) < 1 && n !== 0))
    ? String(Number(n.toPrecision(6)))
    : Math.round(n).toLocaleString();
  return n > 0 ? `+${s}` : s;
}

/** What a currency is called on screen. `?` is the ledger's own name for "could not be told". */
function curLabel(cur: string): string {
  return cur === '?' ? '통화 미확인' : cur;
}

/** Korean market convention: a gain is red and a loss is blue — the opposite of the western default,
 *  and the direction every domestic broker screen uses. Grey for a flat number; a zero is not a good
 *  day. */
function tone(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'text-slate-500';
  return n > 0 ? 'text-rose-600' : 'text-blue-600';
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
    // `min-w-0` on the column and on each section, or the tables never scroll: a flex item's
    // `min-width` defaults to `auto`, so the box grows to fit the widest row instead of letting
    // `overflow-x-auto` do its job, and the whole panel is what ends up cut off. The event detail
    // column is the one that reaches — it carries up to 200 characters of JSON on one nowrap line.
    <div className="flex min-w-0 flex-col gap-3">
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

      {/* Two halts with different consequences, so they are two banners. Saying "trading is
          stopped — loss limit or ledger mismatch, go find out which" made the reader do the
          triage, and it was wrong besides: a loss halt does not stop selling and does not need
          anybody to clear it. */}
      {data?.tripped && (
        <div className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-2.5 py-2 text-[11px] text-rose-700">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>
            매매가 멈춰 있습니다 — 원장 대조가 어긋났거나 사람이 정지시켰습니다.
            아래 이벤트에서 사유를 확인하고 설정에서 해제하십시오.
          </span>
        </div>
      )}
      {(data?.haltedCurrencies?.length ?? 0) > 0 && (
        <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-700">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>
            {data!.haltedCurrencies!.join(' · ')} 의 하루 손실 한도에 닿아 <b>그 통화의 신규 매수만</b>{' '}
            멈췄습니다. 손절·익절과 다른 통화는 그대로 돌고, 실현손익이 한도 안으로 돌아오면{' '}
            <b>스스로 풀립니다</b> — 해제 조작이 필요하지 않습니다.
          </span>
        </div>
      )}

      {/* The number the whole thing is for. It was computed nowhere and shown nowhere: the ledger
          had every row needed and the only consumer of a realised total was the daily loss limit,
          which asks whether to stop. Fees and taxes sit beside the gain rather than inside it —
          "made 2,080" and "made 2,080 after paying 240" are different sentences. */}
      {/* One line per currency, never a grand total. Won and dollars were being added into a single
          figure — a US round trip that lost $14 and a domestic one that made 1,300 won came out as
          1,286 of nothing. */}
      {pnl && (pnl.currencies ?? []).map(cur => {
        const slot = pnl.byCurrency?.[cur] ?? {};
        const un = pnl.unrealized?.[cur];
        return (
          <div key={cur} className="space-y-1">
            <div className="text-[10px] font-bold text-slate-400">{curLabel(cur)}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['오늘 실현', slot.realizedToday, slot.sold?.today],
                ['누적 실현', slot.realizedTotal, slot.sold?.total],
              ] as const).map(([label, value, leg]) => (
                <div key={label} className="rounded-lg border border-slate-200 px-2.5 py-2">
                  <div className="text-[10px] font-bold text-slate-400">{label}</div>
                  <div className={`text-sm font-bold ${tone(value)}`}>{money(value, cur)}</div>
                  <div className="text-[10px] text-slate-400">
                    {leg?.count
                      ? `${leg.count}회 · 비용 ${money(-((leg.fee ?? 0) + (leg.tax ?? 0)), cur)}`
                      : '거래 없음'}
                  </div>
                </div>
              ))}
              <div className="rounded-lg border border-slate-200 px-2.5 py-2">
                <div className="text-[10px] font-bold text-slate-400">평가손익</div>
                {/* Null on purpose when any holding has no price. A partial sum reads as the whole. */}
                <div className={`text-sm font-bold ${
                  un?.total == null ? 'text-slate-400' : tone(un.total)}`}>
                  {un?.total == null ? '가격 미조회' : money(un.total, cur)}
                </div>
                <div className="text-[10px] text-slate-400">
                  {un?.unpriced?.length
                    ? `${un.unpriced.length}종목 시세 없음`
                    : `${un?.priced ?? 0}종목`}
                </div>
              </div>
              {/* Shown only when it happened, because a transfer is rare and an always-zero box
                  beside the profit invites adding the two. */}
              {!!slot.transferred?.total?.count && (
                <div className="rounded-lg border border-slate-200 px-2.5 py-2">
                  <div className="text-[10px] font-bold text-slate-400">내부이전</div>
                  <div className={`text-sm font-bold ${tone(slot.transferred.total.pnl)}`}>
                    {money(slot.transferred.total.pnl, cur)}
                  </div>
                  <div className="text-[10px] text-slate-400">매도 아님 · 합산 금지</div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* 실현손익 두 칸으로 나눈 이유 — `realized_pnl` 은 그 전략·종목의 생애 누적이라 리셋되지
          않는다. 보유 행에 한 칸만 있으면 **끝난 왕복의 손익이 새로 산 주식에 붙어 보인다**(META 가
          3주 왕복으로 −3.57 을 내고 끝난 35분 뒤, 새로 산 3주 옆에 그대로 앉아 있었다). 지금 들고
          있는 것에 대한 답은 '이번 구간' 쪽이다. */}
      <Section title="보유" count={holdings.length}>
        <Table
          head={['전략', '종목', '수량', '평단', '이번 구간', '누적 실현', '상태']}
          empty="보유 중인 포지션이 없습니다."
          rows={holdings.map(p => [
            String(p.strategy_id ?? ''),
            String(p.symbol ?? ''),
            num(p.qty),
            num(p.avg_price),
            <span key="o" className={tone(p.realized_open)}>
              {p.realized_open == null ? '—' : money(p.realized_open, String(p.currency ?? ''))}
            </span> as any,
            <span key="r" className={tone(p.realized_pnl)}>
              {money(p.realized_pnl, String(p.currency ?? ""))}
            </span> as any,
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
            <span key="r" className={tone(p.realized_pnl)}>{money(p.realized_pnl, String(p.currency ?? ""))}</span> as any,
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
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-bold text-slate-700">{title}</span>
        <span className="text-[10px] text-slate-400">{count}</span>
      </div>
      {children}
    </div>
  );
}
