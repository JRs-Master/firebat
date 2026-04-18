'use client';

import { useMemo, useRef, useState, useCallback, useEffect } from 'react';

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

// 숫자를 간결하게 (한 줄에 들어가도록 짧게)
function compactKorean(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) {
    const v = n / 1e8;
    return (v >= 10 ? Math.round(v).toString() : v.toFixed(1)) + '억';
  }
  if (abs >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
  if (abs >= 1e3) return Math.round(n / 1e3).toLocaleString('ko-KR') + '천';
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

  // 유효 데이터만 + 오래된 → 최신 순서로 정렬 (API가 역순 반환 가능)
  // data가 undefined/null/비배열이어도 크래시 방지
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const fullData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    const valid = data.filter(d =>
      d && isNum(d.open) && isNum(d.high) && isNum(d.low) && isNum(d.close) && isNum(d.volume)
    );
    return [...valid].sort((a, b) => normalizeDate(a.date).localeCompare(normalizeDate(b.date)));
  }, [data]);
  const fullN = fullData.length;

  // 뷰 윈도우 (팬/줌) — null이면 전체 보기
  const [view, setView] = useState<{ s: number; e: number } | null>(null);
  useEffect(() => { setView(null); /* 데이터 변경 시 뷰 리셋 */ }, [fullN]);
  const viewStart = Math.max(0, Math.min(fullN - 1, view?.s ?? 0));
  const viewEnd = Math.max(viewStart, Math.min(fullN - 1, view?.e ?? fullN - 1));
  const safeData = useMemo(() => fullData.slice(viewStart, viewEnd + 1), [fullData, viewStart, viewEnd]);
  const n = safeData.length;

  // 줌/팬 내부 참조 (isDragging: 임계값 넘어야 팬 시작 — 그 전까지는 툴팁)
  const panRef = useRef<{ startX: number; startY: number; startS: number; startE: number; isDragging: boolean } | null>(null);
  const pinchRef = useRef<{ startDist: number; startS: number; startE: number } | null>(null);
  const PAN_THRESHOLD = 6;

  // 줌: 픽셀 X 위치 앵커로 범위 조정 (factor < 1 = 확대, > 1 = 축소)
  const zoomAround = useCallback((factor: number, clientX: number) => {
    if (!priceBoxRef.current || fullN < 2) return;
    const rect = priceBoxRef.current.getBoundingClientRect();
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const curRange = viewEnd - viewStart + 1;
    const anchorIdx = viewStart + relX * (curRange - 1);
    const newRange = Math.max(5, Math.min(fullN, Math.round(curRange * factor)));
    let newS = Math.round(anchorIdx - relX * (newRange - 1));
    newS = Math.max(0, Math.min(fullN - newRange, newS));
    setView({ s: newS, e: newS + newRange - 1 });
  }, [viewStart, viewEnd, fullN]);

  // PC 휠 줌 (preventDefault 필요 → native listener)
  useEffect(() => {
    const el = priceBoxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (fullN < 2) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      zoomAround(factor, e.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround, fullN]);

  // 모바일 2손가락 핀치: 브라우저 viewport 줌 차단 (차트 자체 핀치로 처리)
  useEffect(() => {
    const el = priceBoxRef.current;
    if (!el) return;
    const onTouchStartNative = (e: TouchEvent) => {
      if (e.touches.length === 2) e.preventDefault();
    };
    const onTouchMoveNative = (e: TouchEvent) => {
      if (e.touches.length === 2) e.preventDefault();
    };
    el.addEventListener('touchstart', onTouchStartNative, { passive: false });
    el.addEventListener('touchmove', onTouchMoveNative, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStartNative);
      el.removeEventListener('touchmove', onTouchMoveNative);
    };
  }, []);

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
    // 차트 관례: 우측에 2일치 여백 (마지막 캔들이 끝에 붙지 않게)
    const RIGHT_MARGIN_SLOTS = 2;
    const slots = n <= 1 ? 1 : (n - 1 + RIGHT_MARGIN_SLOTS);
    const xs = safeData.map((_, i) => padLeft + (n <= 1 ? 0 : (i / slots) * plotW));
    const yPrice = (p: number) => padTop + plotH - ((p - pMin) / (pMax - pMin)) * plotH;
    const yVol = (v: number) => 4 + volPlotH - (v / maxV) * volPlotH;
    const candleW = n > 1 ? (plotW / slots) * 0.55 : 10;
    const maLines = indicators.map(ind => {
      const period = parseInt(ind.replace('MA', ''), 10);
      const values = sma(closes, period);
      const pts = values.map((v, i) => v == null ? null : [xs[i], yPrice(v)] as [number, number]).filter(Boolean) as [number, number][];
      const d = pts.length ? 'M ' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ') : '';
      return { name: ind, d, color: MA_COLORS[ind] };
    });
    return { xs, yPrice, yVol, candleW, minP: pMin, maxP: pMax, maxV, maLines };
  }, [safeData, n, indicators, plotW, plotH, padLeft, padTop, volPlotH]);

  // clientX → viewData 인덱스 매핑 (툴팁/호버용)
  const updateHoverFromClientX = useCallback((clientX: number) => {
    if (!priceBoxRef.current || n === 0) return;
    const rect = priceBoxRef.current.getBoundingClientRect();
    const relX = clientX - rect.left;
    const svgX = (relX / rect.width) * W;
    const dataX = svgX - padLeft;
    const slots = n <= 1 ? 1 : (n - 1 + 2);
    const idx = Math.round((dataX / plotW) * slots);
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  }, [n, plotW]);

  const handlePointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    updateHoverFromClientX(e.clientX); // 팬 중에도 툴팁 유지
  }, [updateHoverFromClientX]);

  const handleLeave = useCallback(() => { setHoverIdx(null); }, []);

  // 줌 인 상태 여부: 현재 뷰 범위 < 전체 데이터 수 (팬 가능한지 판단)
  const canPan = viewEnd - viewStart + 1 < fullN;

  // PC: 호버 = 툴팁, 마우스다운+드래그 = 팬 (줌인 상태일 때만)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (fullN < 2) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, startS: viewStart, startE: viewEnd, isDragging: false };
  }, [viewStart, viewEnd, fullN]);
  const handleMouseMovePan = useCallback((e: React.MouseEvent) => {
    if (!panRef.current || !priceBoxRef.current) return;
    const dx = e.clientX - panRef.current.startX;
    if (!panRef.current.isDragging && Math.abs(dx) < PAN_THRESHOLD) return; // 아직 팬 아님
    panRef.current.isDragging = true;
    // 팬 중에도 툴팁 유지 (줌인/아웃 모두 커서 위치 표시)
    updateHoverFromClientX(e.clientX);
    if (!canPan) return; // 줌아웃이면 툴팁만 갱신
    const rect = priceBoxRef.current.getBoundingClientRect();
    const range = panRef.current.startE - panRef.current.startS + 1;
    const dxIdx = Math.round(-dx / rect.width * range);
    const newS = Math.max(0, Math.min(fullN - range, panRef.current.startS + dxIdx));
    if (newS !== viewStart) setView({ s: newS, e: newS + range - 1 });
  }, [viewStart, fullN, canPan, updateHoverFromClientX]);
  const handleMouseUp = useCallback(() => { panRef.current = null; }, []);

  // 모바일:
  // - 2손가락 핀치 = 줌
  // - 1손가락 세로 드래그 = 페이지 스크롤 (touchAction:pan-y가 브라우저에 위임)
  // - 1손가락 가로 드래그 = 줌인 상태일 때만 팬
  // - 1손가락 터치(거의 정지) = 툴팁
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (fullN < 2) return;
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      pinchRef.current = { startDist: d, startS: viewStart, startE: viewEnd };
      panRef.current = null;
      setHoverIdx(null);
    } else if (e.touches.length === 1) {
      panRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, startS: viewStart, startE: viewEnd, isDragging: false };
      pinchRef.current = null;
      // 터치 즉시 툴팁 표시 (정지 터치 = 툴팁 요구사항)
      updateHoverFromClientX(e.touches[0].clientX);
    }
  }, [viewStart, viewEnd, fullN, updateHoverFromClientX]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!priceBoxRef.current) return;
    if (e.touches.length === 2 && pinchRef.current) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const factor = pinchRef.current.startDist / Math.max(d, 1);
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const rect = priceBoxRef.current.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (centerX - rect.left) / rect.width));
      const startRange = pinchRef.current.startE - pinchRef.current.startS + 1;
      const anchorIdx = pinchRef.current.startS + relX * (startRange - 1);
      const newRange = Math.max(5, Math.min(fullN, Math.round(startRange * factor)));
      let newS = Math.round(anchorIdx - relX * (newRange - 1));
      newS = Math.max(0, Math.min(fullN - newRange, newS));
      setView({ s: newS, e: newS + newRange - 1 });
    } else if (e.touches.length === 1 && panRef.current) {
      const dx = e.touches[0].clientX - panRef.current.startX;
      const dy = e.touches[0].clientY - panRef.current.startY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      // 세로 의도 감지 → 이 제스처 전체 포기 (페이지 스크롤 양보)
      if (absDy > absDx + 4) {
        setHoverIdx(null);
        panRef.current = null;
        return;
      }
      // 가로 이동 — 줌인/아웃 모두 툴팁 항상 갱신
      updateHoverFromClientX(e.touches[0].clientX);
      if (!panRef.current.isDragging && absDx < PAN_THRESHOLD) return; // 짧은 이동: 툴팁만
      if (!canPan) return; // 줌아웃 상태: 툴팁만, 팬 없음
      panRef.current.isDragging = true;
      const rect = priceBoxRef.current.getBoundingClientRect();
      const range = panRef.current.startE - panRef.current.startS + 1;
      const dxIdx = Math.round(-dx / rect.width * range);
      const newS = Math.max(0, Math.min(fullN - range, panRef.current.startS + dxIdx));
      if (newS !== viewStart) setView({ s: newS, e: newS + range - 1 });
    }
  }, [viewStart, fullN, updateHoverFromClientX, canPan]);
  const handleTouchEnd = useCallback(() => { panRef.current = null; pinchRef.current = null; }, []);

  const priceTicks = useMemo(() => niceTicks(minP, maxP, 5), [minP, maxP]);
  const volTicks = useMemo(() => niceTicks(0, maxV, 3).filter(t => t > 0), [maxV]);

  // 헤더는 전체 데이터 기준 (가격), 기간/고가/저가는 가시 범위 기준
  const latest = fullData[fullN - 1];
  const viewFirst = safeData[0];
  const viewLatest = safeData[n - 1];
  const change = viewLatest && viewFirst ? viewLatest.close - viewFirst.close : 0;
  const changePct = viewFirst ? (change / viewFirst.close) * 100 : 0;
  const isUp = change > 0;
  const isDown = change < 0;
  const changeColor = isUp ? 'text-red-600' : isDown ? 'text-blue-600' : 'text-slate-400';
  const changeArrow = isUp ? '▲' : isDown ? '▼' : '–';
  const changeSign = isUp ? '+' : '';
  const firstDate = shortDate(viewFirst.date);
  const lastDate = shortDate(viewLatest.date);
  const periodLabel = firstDate === lastDate ? `${firstDate} · 1일` : `${firstDate} ~ ${lastDate} · ${n}일`;
  const titleText = title && title.trim() && title.trim() !== symbol ? title : symbol;
  const showSymbolChip = titleText !== symbol;
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
            <span className="text-[16px] sm:text-[18px] font-extrabold text-slate-900 tracking-tight">{titleText}</span>
            {showSymbolChip && <span className="text-[11px] text-slate-400 font-semibold">{symbol}</span>}
          </div>
          <span className="text-[11px] text-slate-400 mt-0.5">{periodLabel}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[20px] sm:text-[22px] font-extrabold text-slate-900 tabular-nums">{latest.close.toLocaleString('ko-KR')}</span>
          <span className={`text-[12px] font-bold tabular-nums ${changeColor}`}>
            {changeArrow} {Math.abs(change).toLocaleString('ko-KR')} ({changeSign}{changePct.toFixed(2)}%)
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
          <div key={i} className="bg-slate-50 rounded-xl p-2 sm:p-3 flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] sm:text-[11px] text-slate-400 font-semibold">{s.label}</span>
            <span className={`text-[12px] sm:text-[15px] font-extrabold tabular-nums whitespace-nowrap ${s.color}`}>
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

      {/* 가격 차트 (드래그 팬 + 휠/핀치 줌) */}
      <div
        ref={priceBoxRef}
        className={`relative select-none ${canPan ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}`}
        onPointerMove={handlePointer}
        onPointerLeave={handleLeave}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMovePan}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{ touchAction: 'pan-y' }}
      >
        <svg viewBox={`0 0 ${W} ${priceH}`} className="w-full h-auto block" preserveAspectRatio="xMidYMid meet" style={{ touchAction: 'pan-y' }}>
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

          {/* X축 라벨: 매월 첫 거래일 + 마지막 날짜 */}
          {(() => {
            const indices: number[] = [];
            let prevMonth = '';
            for (let i = 0; i < n; i++) {
              const dn = normalizeDate(safeData[i].date);
              const month = dn.slice(0, 7); // YYYY-MM
              if (month !== prevMonth) { indices.push(i); prevMonth = month; }
            }
            const last = n - 1;
            // 끝이 빠졌으면 추가. 끝과 직전 라벨이 너무 가까우면 직전 제거 (최소 간격 = 전체의 8%)
            const minGap = Math.max(2, Math.floor(n * 0.08));
            if (indices[indices.length - 1] !== last) {
              if (indices.length > 0 && last - indices[indices.length - 1] < minGap) indices.pop();
              indices.push(last);
            }
            return indices.map(i => (
              <text key={'xl' + i} x={xs[i]} y={priceH - 6} fill={MUTED} fontSize="10" textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{shortDate(safeData[i].date)}</text>
            ));
          })()}
        </svg>

        {/* 호버 툴팁 */}
        {hoverBar && hoverX != null && (
          <div
            className="absolute pointer-events-none bg-slate-900/95 text-white rounded-lg px-3 py-2 text-[11px] shadow-lg whitespace-nowrap"
            style={{ left: `${(hoverX / W) * 100}%`, top: 4, transform: hoverX > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)', minWidth: 140 }}
          >
            <div className="font-bold text-[11px] text-slate-300 mb-1.5">{normalizeDate(hoverBar.date)}</div>
            <div className="flex flex-col gap-0.5 tabular-nums">
              {[
                { k: '시가', v: hoverBar.open.toLocaleString('ko-KR'), c: '' },
                { k: '고가', v: hoverBar.high.toLocaleString('ko-KR'), c: 'text-red-300' },
                { k: '저가', v: hoverBar.low.toLocaleString('ko-KR'), c: 'text-blue-300' },
                { k: '종가', v: hoverBar.close.toLocaleString('ko-KR'), c: 'font-bold' },
                { k: '거래량', v: compactKorean(hoverBar.volume), c: 'text-slate-300' },
              ].map((row, i) => (
                <div key={i} className="flex items-baseline justify-between gap-4">
                  <span className="text-slate-400">{row.k}</span>
                  <span className={row.c}>{row.v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 거래량 차트 */}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${volH}`} className="w-full h-auto block" preserveAspectRatio="xMidYMid meet">
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
