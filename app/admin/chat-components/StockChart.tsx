'use client';

import { useMemo, useRef, useState, useCallback } from 'react';

export type OhlcvBar = {
  date: string; // YYYY-MM-DD or YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StockChartProps = {
  symbol: string;
  title?: string;
  data: OhlcvBar[];
  indicators?: Array<'MA5' | 'MA10' | 'MA20' | 'MA60'>;
  buyPoints?: Array<{ label: string; price: number; note?: string }>;
  sellPoints?: Array<{ label: string; price: number; note?: string }>;
};

const MA_COLORS: Record<string, string> = {
  MA5: '#f59e0b',
  MA10: '#8b5cf6',
  MA20: '#3b82f6',
  MA60: '#10b981',
};

const UP = '#ef4444';   // 상승 빨강
const DOWN = '#3b82f6'; // 하락 파랑
const FG = '#0f172a';
const MUTED = '#94a3b8';
const GRID = '#e2e8f0';

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function normalizeDate(d: string): string {
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

function shortDate(d: string): string {
  const n = normalizeDate(d);
  const parts = n.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : n;
}

// 숫자를 간결하게 (100000000 → 1.0억, 15000 → 1.5만)
function compactKorean(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(1) + '억';
  if (abs >= 1e4) return (n / 1e4).toFixed(1) + '만';
  return n.toLocaleString('ko-KR');
}

// Y축 tick 자동 생성
function niceTicks(min: number, max: number, count = 5): number[] {
  const range = max - min;
  if (range === 0) return [min];
  const rough = range / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / mag;
  let step: number;
  if (residual > 5) step = 10 * mag;
  else if (residual > 2) step = 5 * mag;
  else if (residual > 1) step = 2 * mag;
  else step = mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export default function StockChart({ symbol, title, data, indicators = ['MA5', 'MA20'], buyPoints, sellPoints }: StockChartProps) {
  const priceBoxRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 유효 데이터만
  const safeData = useMemo(() => data.filter(d => d && typeof d.close === 'number'), [data]);
  const n = safeData.length;

  // 차트 치수 (가변)
  const W = 720; // viewBox 기준 너비
  const priceH = 280;
  const volH = 80;
  const padLeft = 50;
  const padRight = 56;
  const padTop = 18;
  const padBottom = 24;
  const plotW = W - padLeft - padRight;
  const plotH = priceH - padTop - padBottom;
  const volPlotH = volH - 4 - 16;

  const { xs, yPrice, yVol, candleW, minP, maxP, maxV, maLines } = useMemo(() => {
    const closes = safeData.map(d => d.close);
    const highs = safeData.map(d => d.high);
    const lows = safeData.map(d => d.low);
    const volumes = safeData.map(d => d.volume);
    const maxP = Math.max(...highs);
    const minP = Math.min(...lows);
    const rangeP = maxP - minP || 1;
    const pMin = minP - rangeP * 0.05;
    const pMax = maxP + rangeP * 0.05;
    const maxV = Math.max(...volumes, 1);
    const xs = safeData.map((_, i) => padLeft + (n <= 1 ? 0 : (i / (n - 1)) * plotW));
    const yPrice = (p: number) => padTop + plotH - ((p - pMin) / (pMax - pMin)) * plotH;
    const yVol = (v: number) => 4 + volPlotH - (v / maxV) * volPlotH;
    const candleW = n > 1 ? (plotW / (n - 1)) * 0.55 : 10;
    const maLines = indicators.map(ind => {
      const period = parseInt(ind.replace('MA', ''), 10);
      const values = sma(closes, period);
      const pts = values.map((v, i) => v == null ? null : [xs[i], yPrice(v)] as [number, number]).filter(Boolean) as [number, number][];
      const d = pts.length ? 'M ' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ') : '';
      return { name: ind, d, color: MA_COLORS[ind] };
    });
    return { xs, yPrice, yVol, candleW, minP: pMin, maxP: pMax, maxV, maLines };
  }, [safeData, n, indicators, plotW, plotH, padLeft, padTop, volPlotH]);

  // 호버 → 인덱스 매핑
  const handlePointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!priceBoxRef.current || n === 0) return;
    const rect = priceBoxRef.current.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const svgX = (relX / rect.width) * W;
    const dataX = svgX - padLeft;
    const idx = Math.round((dataX / plotW) * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  }, [n, plotW]);

  const handleLeave = useCallback(() => setHoverIdx(null), []);

  const priceTicks = useMemo(() => niceTicks(minP, maxP, 5), [minP, maxP]);
  const volTicks = useMemo(() => niceTicks(0, maxV, 3).filter(t => t > 0), [maxV]);

  const latest = safeData[n - 1];
  const first = safeData[0];
  const change = latest && first ? latest.close - first.close : 0;
  const changePct = first ? (change / first.close) * 100 : 0;
  const isUp = change >= 0;
  const periodHigh = Math.max(...safeData.map(d => d.high));
  const periodLow = Math.min(...safeData.map(d => d.low));

  if (n === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-400 text-[13px]">
        차트 데이터가 없습니다.
      </div>
    );
  }

  const hoverBar = hoverIdx != null ? safeData[hoverIdx] : null;
  const hoverX = hoverIdx != null ? xs[hoverIdx] : null;

  return (
    <div className="flex flex-col gap-4 bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* 헤더 */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="flex flex-col">
          <div className="flex items-baseline gap-2">
            <span className="text-[16px] sm:text-[18px] font-extrabold text-slate-900 tracking-tight">{title || symbol}</span>
            <span className="text-[11px] text-slate-400 font-semibold">{symbol}</span>
          </div>
          <span className="text-[11px] text-slate-400 mt-0.5">{shortDate(safeData[0].date)} ~ {shortDate(latest.date)} · {n}일</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[20px] sm:text-[22px] font-extrabold text-slate-900 tabular-nums">{latest.close.toLocaleString('ko-KR')}</span>
          <span className={`text-[12px] font-bold tabular-nums ${isUp ? 'text-red-600' : 'text-blue-600'}`}>
            {isUp ? '▲' : '▼'} {Math.abs(change).toLocaleString('ko-KR')} ({isUp ? '+' : ''}{changePct.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* 스탯 카드 */}
      <div className="grid grid-cols-4 gap-2 sm:gap-3">
        {[
          { label: '시가', v: latest.open, color: 'text-slate-700' },
          { label: '고가', v: periodHigh, color: 'text-red-600' },
          { label: '저가', v: periodLow, color: 'text-blue-600' },
          { label: '거래량', v: latest.volume, color: 'text-slate-700', compact: true },
        ].map((s, i) => (
          <div key={i} className="bg-slate-50 rounded-xl p-2.5 sm:p-3 flex flex-col gap-0.5">
            <span className="text-[10px] sm:text-[11px] text-slate-400 font-semibold">{s.label}</span>
            <span className={`text-[13px] sm:text-[15px] font-extrabold tabular-nums ${s.color}`}>
              {s.compact ? compactKorean(s.v) : s.v.toLocaleString('ko-KR')}
            </span>
          </div>
        ))}
      </div>

      {/* 범례 */}
      {indicators.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-1">
          {maLines.map(m => (
            <span key={m.name} className="flex items-center gap-1.5 text-[11px] text-slate-500 font-semibold">
              <span className="w-3 h-[2px] rounded-full" style={{ background: m.color }} />
              {m.name}
            </span>
          ))}
        </div>
      )}

      {/* 가격 차트 */}
      <div ref={priceBoxRef} className="relative select-none" onPointerMove={handlePointer} onPointerLeave={handleLeave}>
        <svg viewBox={`0 0 ${W} ${priceH}`} className="w-full h-auto block" preserveAspectRatio="none" style={{ touchAction: 'pan-y' }}>
          {/* 가로 그리드 */}
          {priceTicks.map(t => {
            const y = yPrice(t);
            return (
              <g key={t}>
                <line x1={padLeft} x2={W - padRight} y1={y} y2={y} stroke={GRID} strokeWidth={1} strokeDasharray="2 3" />
                <text x={W - padRight + 4} y={y} fill={MUTED} fontSize="10" textAnchor="start" dominantBaseline="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif" className="tabular-nums">{t.toLocaleString('ko-KR')}</text>
              </g>
            );
          })}

          {/* 매수 구간 */}
          {buyPoints?.map((bp, i) => {
            const y = yPrice(bp.price);
            return (
              <g key={'bp' + i}>
                <line x1={padLeft} x2={W - padRight} y1={y} y2={y} stroke={UP} strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
                <text x={padLeft + 4} y={y - 4} fill={UP} fontSize="10" fontWeight="700" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{bp.label} {bp.price.toLocaleString('ko-KR')}</text>
              </g>
            );
          })}
          {sellPoints?.map((sp, i) => {
            const y = yPrice(sp.price);
            return (
              <g key={'sp' + i}>
                <line x1={padLeft} x2={W - padRight} y1={y} y2={y} stroke={DOWN} strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
                <text x={padLeft + 4} y={y - 4} fill={DOWN} fontSize="10" fontWeight="700" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{sp.label} {sp.price.toLocaleString('ko-KR')}</text>
              </g>
            );
          })}

          {/* 캔들 */}
          {safeData.map((d, i) => {
            const x = xs[i];
            const isUpDay = d.close >= d.open;
            const color = isUpDay ? UP : DOWN;
            const yH = yPrice(d.high);
            const yL = yPrice(d.low);
            const yO = yPrice(d.open);
            const yC = yPrice(d.close);
            const bodyTop = Math.min(yO, yC);
            const bodyH = Math.max(Math.abs(yC - yO), 1);
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={yH} y2={yL} stroke={color} strokeWidth={1} />
                <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={color} rx={1} />
              </g>
            );
          })}

          {/* 이동평균 라인 */}
          {maLines.map(m => (
            <path key={m.name} d={m.d} fill="none" stroke={m.color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
          ))}

          {/* 호버 크로스헤어 */}
          {hoverX != null && (
            <line x1={hoverX} x2={hoverX} y1={padTop} y2={priceH - padBottom} stroke={FG} strokeWidth={1} strokeDasharray="2 2" opacity={0.35} />
          )}

          {/* X축 라벨 (일부만) */}
          {(() => {
            const labelCount = Math.min(5, n);
            const step = Math.max(1, Math.floor((n - 1) / (labelCount - 1 || 1)));
            const indices: number[] = [];
            for (let i = 0; i < n; i += step) indices.push(i);
            if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
            return indices.map(i => (
              <text key={'xl' + i} x={xs[i]} y={priceH - 6} fill={MUTED} fontSize="10" textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{shortDate(safeData[i].date)}</text>
            ));
          })()}
        </svg>

        {/* 호버 툴팁 */}
        {hoverBar && hoverX != null && (
          <div
            className="absolute pointer-events-none bg-slate-900/95 text-white rounded-lg px-2.5 py-2 text-[11px] shadow-lg"
            style={{ left: `${(hoverX / W) * 100}%`, top: 4, transform: hoverX > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
          >
            <div className="font-bold text-[11px] text-slate-300 mb-1">{normalizeDate(hoverBar.date)}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
              <span className="text-slate-400">시가</span><span>{hoverBar.open.toLocaleString('ko-KR')}</span>
              <span className="text-slate-400">고가</span><span className="text-red-300">{hoverBar.high.toLocaleString('ko-KR')}</span>
              <span className="text-slate-400">저가</span><span className="text-blue-300">{hoverBar.low.toLocaleString('ko-KR')}</span>
              <span className="text-slate-400">종가</span><span className="font-bold">{hoverBar.close.toLocaleString('ko-KR')}</span>
              <span className="text-slate-400">거래량</span><span>{compactKorean(hoverBar.volume)}</span>
            </div>
          </div>
        )}
      </div>

      {/* 거래량 차트 */}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${volH}`} className="w-full h-auto block" preserveAspectRatio="none">
          {volTicks.map(t => {
            const y = yVol(t);
            return (
              <g key={t}>
                <line x1={padLeft} x2={W - padRight} y1={y} y2={y} stroke={GRID} strokeWidth={1} strokeDasharray="2 3" />
                <text x={W - padRight + 4} y={y} fill={MUTED} fontSize="9" textAnchor="start" dominantBaseline="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{compactKorean(t)}</text>
              </g>
            );
          })}
          {safeData.map((d, i) => {
            const x = xs[i];
            const isUpDay = i > 0 ? d.close >= safeData[i - 1].close : d.close >= d.open;
            const color = isUpDay ? UP : DOWN;
            const y = yVol(d.volume);
            const h = Math.max((4 + volPlotH) - y, 0);
            return <rect key={'v' + i} x={x - candleW / 2} y={y} width={candleW} height={h} fill={color} opacity={0.55} rx={1} />;
          })}
          {hoverX != null && (
            <line x1={hoverX} x2={hoverX} y1={0} y2={volH} stroke={FG} strokeWidth={1} strokeDasharray="2 2" opacity={0.3} />
          )}
        </svg>
      </div>

      {/* 매수/매도 포인트 */}
      {(buyPoints?.length || sellPoints?.length) ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-slate-100">
          {buyPoints && buyPoints.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-bold text-slate-500 tracking-wider uppercase">매수 포인트</div>
              {buyPoints.map((p, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="font-bold text-red-600 shrink-0">{p.label}</span>
                  <span className="text-slate-500 text-[11px] flex-1 truncate">{p.note || ''}</span>
                  <span className="tabular-nums font-bold text-slate-900 shrink-0">~{p.price.toLocaleString('ko-KR')}원</span>
                </div>
              ))}
            </div>
          )}
          {sellPoints && sellPoints.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-bold text-slate-500 tracking-wider uppercase">매도 포인트</div>
              {sellPoints.map((p, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="font-bold text-blue-600 shrink-0">{p.label}</span>
                  <span className="text-slate-500 text-[11px] flex-1 truncate">{p.note || ''}</span>
                  <span className="tabular-nums font-bold text-slate-900 shrink-0">~{p.price.toLocaleString('ko-KR')}원</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
