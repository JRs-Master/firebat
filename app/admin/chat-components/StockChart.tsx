'use client';

import { useMemo, useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { useViewportMaxHeight, useViewportSize } from '../../../lib/use-viewport-size';

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

// 줌 = 한 화면 캔들 수. 봉 폭(px)으로 캡 — 화면폭 무관 일관.
const ZOOM_DEFAULT_CPS = 90; // 기본 한 화면 캔들 수
const ZOOM_MAX_BAR = 36;     // 최대 봉 px (줌인 한계 — 그 이상 안 커짐)
const ZOOM_MIN_BAR = 3;      // 최소 봉 px (줌아웃 한계 — 그 이하 안 작아짐)
const ZOOM_RIGHT_PAD_SLOTS = 1; // 마지막 캔들 우측 여백 (slot 수)

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
  const volScrollRef = useRef<HTMLDivElement>(null); // 거래량 차트 — 가격과 가로 스크롤 동기화
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // 툴팁 위치용 실시간 마우스 좌표 (컨테이너 기준)
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  // 가로 스크롤 위치 — 가격축 라벨/툴팁을 뷰포트 우측·커서에 고정시키기 위해 추적.
  const [scrollX, setScrollX] = useState(0);
  const lastPointerXRef = useRef<number | null>(null); // 스크롤 시 마지막 커서 X 로 호버 재계산

  // 차트 전체 영역 cap — 모바일 320px / PC 480px. breakpoint 640 (sm). SSR null 시 320 fallback.
  // 사용자 정정 (2026-05-26): 차트 전체 영역 (헤더 + 4 카드 + 범례 + 봉 + 거래량) 에 cap 적용.
  // 봉 영역 = 차트 영역 (헤더 뺀 나머지) 의 약 78% (옛 280/360 비율) — 봉 ≥ 2/3 요청 충족.
  // flexbox (flex-1 + SVG h-full) 폐기 — 봉/거래량 겹침 발생 → 명시 px 방식 복원.
  const containerMaxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.6, breakpoint: 640, mobileMaxPx: 320, desktopMaxPx: 480 });
  // 헤더 영역 (제목+가격+4카드+범례+gap+padding) 추정 px — breakpoint 640 기준. 정확 measure 대신 근사.
  const { vw: _vwForHeader } = useViewportSize();
  const headerEstPx = (_vwForHeader != null && _vwForHeader < 640) ? 125 : 155;
  const cap = containerMaxH ?? 320;
  // 차트 영역 (봉 + 거래량) = 전체 cap - 헤더 추정. 최소 140 보장.
  const chartAreaH = Math.max(cap - headerEstPx, 140);
  const priceChartHeightPx = Math.floor(chartAreaH * 280 / 360);  // 봉 영역 px (옛 280/360 비율)
  const priceChartHeight = `${priceChartHeightPx}px`;
  const volChartHeight = `${Math.floor(chartAreaH * 80 / 360)}px`;      // 거래량 (옛 80/360 비율)

  // 봉 영역 실제 렌더 width 측정 — viewBox 동적 (찌그러짐 fix). preserveAspectRatio="none" 를 쓴
  // 경우 viewBox aspect (W:priceH) ≠ box aspect (boxW:priceChartHeightPx) 면 봉이 가로/세로 stretch
  // 찌그러짐. viewBox priceH 영역을 box 비율 맞춰 동적 계산 → 찌그러짐 0 + 크로스헤어 1:1 유지.
  const [boxW, setBoxW] = useState(720);
  useEffect(() => {
    if (!priceBoxRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setBoxW(w);
    });
    ro.observe(priceBoxRef.current);
    return () => ro.disconnect();
  }, []);

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

  // 줌 = 한 화면 캔들 수(cps). 데이터(slice)는 항상 전체 — 줌은 캔들 폭만 바꾸고, 화면에 다 안
  // 들어가면 가로 스크롤. (옛 slice 기반 줌 폐기 — "보여줄 개수"가 아니라 "캔들 폭/밀도")
  const [cps, setCps] = useState(ZOOM_DEFAULT_CPS);
  useEffect(() => { setCps(ZOOM_DEFAULT_CPS); /* 데이터 변경 시 기본 줌 */ }, [fullN]);
  // 줌 앵커 — 휠/핀치 후 커서 아래 캔들이 제자리 유지하도록 scrollLeft 보정 (useLayoutEffect 적용).
  const zoomAnchorRef = useRef<{ idx: number; offsetX: number } | null>(null);
  const safeData = fullData;
  const n = fullN;

  // 줌/팬 내부 참조 (isDragging: 임계값 넘어야 팬 시작 — 그 전까지는 툴팁)
  const pinchRef = useRef<{ startDist: number; startCps: number } | null>(null);

  // 줌: 한 화면 캔들 수(cps) 조정. factor>1 = 줌아웃(많이·좁게), <1 = 줌인(적게·넓게).
  // 위치 앵커는 barPx 비례 scrollLeft 보정(아래 useLayoutEffect)으로 — 보던 구간 유지.
  const zoomAround = useCallback((factor: number) => {
    if (fullN < 2) return;
    setCps(c => Math.max(5, Math.min(2000, Math.round(c * factor))));
  }, [fullN]);

  // PC 휠 줌 (preventDefault 필요 → native listener)
  useEffect(() => {
    const el = priceBoxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (fullN < 2) return;
      e.preventDefault();
      zoomAround(e.deltaY > 0 ? 1.15 : 1 / 1.15);
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

  // 차트 치수 — 항상 1:1 스크롤 스타일 (viewBox 가 픽셀과 1:1 → 텍스트 10px 고정, 줌해도 안 바뀜).
  // 줌 = 캔들 폭(barPx) 조절, 데이터는 전체 렌더, 화면 넘치면 가로 스크롤바.
  const priceH = priceChartHeightPx;
  const volH = 80;
  const padLeft = 50;
  // Y축 라벨 폭 — 가격 자릿수 기반 동적. toLocaleString 폰트 10px 기준 자릿수 × ~6px + 12 여백.
  // 작은 가격대 (5만, 6자리) = 56 그대로. 큰 가격대 (1억, 11자리) ≈ 78px. 라벨 잘림 0.
  // padRight 는 캔들 스크롤 영역 밖 우측 고정 거터(별도 컬럼) 폭 — 가격축이 캔들 위를 덮지 않게 분리.
  const maxPriceDigits = safeData.length > 0
    ? Math.max(...safeData.map(d => d.high)).toLocaleString('ko-KR').length
    : 8;
  const padRight = Math.max(56, maxPriceDigits * 6 + 12);
  const padTop = 18;
  const padBottom = 24;
  // boxW = 캔들 스크롤 뷰포트 폭 (부모 paddingRight 로 거터 제외됨). plot 폭 = boxW - padLeft.
  // 줌(한 화면 캔들 수) → 캔들 폭(barPx). 봉 폭 캡 [MIN_BAR, MAX_BAR] 안.
  const plotBoxW = Math.max(1, Math.round(boxW) - padLeft); // box 에 보이는 plot 폭 (우측 거터는 외부)
  const cpsMin = Math.max(2, Math.round(plotBoxW / ZOOM_MAX_BAR));         // 최대 줌인 (봉 ~36px)
  const cpsMax = Math.max(cpsMin + 1, Math.round(plotBoxW / ZOOM_MIN_BAR)); // 최대 줌아웃 (봉 ~3px)
  const effCps = Math.max(cpsMin, Math.min(cpsMax, Math.min(cps, fullN)));  // 실제 한 화면 캔들 수
  const barPx = plotBoxW / effCps;                                          // 캔들 슬롯 px
  // 전체 W = 좌측 inset + 봉 전체 + 우측 여백 슬롯. box 보다 넓으면 가로 스크롤. 좁으면(소량 데이터) box 채움.
  const W = Math.max(Math.round(boxW), Math.round(padLeft + (fullN + ZOOM_RIGHT_PAD_SLOTS) * barPx));
  const plotH = priceH - padTop - padBottom;
  const volPlotH = volH - 4 - 16;

  // 줌 시 보던 구간 유지 — barPx 변하면 scrollLeft 를 비례 보정 (콘텐츠 폭 ∝ barPx → 같은 구간 유지).
  const prevBarRef = useRef(barPx);
  useLayoutEffect(() => {
    const el = priceBoxRef.current;
    if (el && prevBarRef.current && prevBarRef.current !== barPx) {
      el.scrollLeft = el.scrollLeft * (barPx / prevBarRef.current);
    }
    prevBarRef.current = barPx;
  }, [barPx]);
  // 데이터 로드 시 최신(우측)부터 보기.
  useEffect(() => {
    const el = priceBoxRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [fullN]);

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
    // 캔들 x = 각 캔들 슬롯(barPx) 중앙. 폭은 barPx 비례.
    const xs = safeData.map((_, i) => padLeft + i * barPx + barPx / 2);
    const yPrice = (p: number) => padTop + plotH - ((p - pMin) / (pMax - pMin)) * plotH;
    const yVol = (v: number) => 4 + volPlotH - (v / maxV) * volPlotH;
    const candleW = Math.max(1.5, barPx * 0.6);
    const maLines = indicators.map(ind => {
      const period = parseInt(ind.replace('MA', ''), 10);
      const values = sma(closes, period);
      const pts = values.map((v, i) => v == null ? null : [xs[i], yPrice(v)] as [number, number]).filter(Boolean) as [number, number][];
      const d = pts.length ? 'M ' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ') : '';
      return { name: ind, d, color: MA_COLORS[ind] };
    });
    return { xs, yPrice, yVol, candleW, minP: pMin, maxP: pMax, maxV, maLines };
  }, [safeData, indicators, barPx, plotH, padLeft, padTop, volPlotH]);

  // clientX → 캔들 인덱스 (툴팁/호버용) — 가로 스크롤(scrollLeft) 반영.
  const updateHoverFromClientX = useCallback((clientX: number) => {
    const el = priceBoxRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const contentX = (clientX - rect.left) + el.scrollLeft; // 1:1 이라 콘텐츠 px = svg 단위
    const idx = Math.round((contentX - padLeft - barPx / 2) / barPx);
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  }, [n, barPx, padLeft]);

  const handlePointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    lastPointerXRef.current = e.clientX;
    updateHoverFromClientX(e.clientX);
    if (priceBoxRef.current) {
      const rect = priceBoxRef.current.getBoundingClientRect();
      setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
  }, [updateHoverFromClientX]);

  const handleLeave = useCallback(() => { setHoverIdx(null); setHoverPos(null); }, []);

  // 모바일: 2손가락 핀치 = 줌(cps 조절) / 1손가락 = 툴팁. 1손가락 가로 이동 = 컨테이너 native 스크롤.
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (fullN < 2) return;
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      pinchRef.current = { startDist: d, startCps: cps };
      setHoverIdx(null);
    } else if (e.touches.length === 1) {
      updateHoverFromClientX(e.touches[0].clientX);
    }
  }, [fullN, cps, updateHoverFromClientX]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      // 핀치 벌림(d↑) = 줌인(적게·넓게) = cps↓. startCps × (startDist / d).
      const next = Math.round(pinchRef.current.startCps * (pinchRef.current.startDist / Math.max(d, 1)));
      setCps(Math.max(5, Math.min(2000, next)));
    } else if (e.touches.length === 1) {
      updateHoverFromClientX(e.touches[0].clientX);
    }
  }, [updateHoverFromClientX]);
  const handleTouchEnd = useCallback(() => { pinchRef.current = null; }, []);

  const priceTicks = useMemo(() => niceTicks(minP, maxP, 5), [minP, maxP]);
  const volTicks = useMemo(() => niceTicks(0, maxV, 3).filter(t => t > 0), [maxV]);

  // 헤더는 전체 데이터 기준 (가격), 기간/고가/저가는 가시 범위 기준
  const latest = fullData[fullN - 1];
  const viewFirst = safeData[0];
  // 헤더 변동: 전일 종가 대비 (일간 변동, 증권앱 표준). 전일 없으면 기간 시작 대비 폴백.
  const prevClose = fullData[fullN - 2]?.close;
  const viewLatest = safeData[n - 1];
  const baseClose = prevClose ?? viewFirst?.close ?? 0;
  const change = latest && baseClose ? latest.close - baseClose : 0;
  const changePct = baseClose ? (change / baseClose) * 100 : 0;
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
    <div className="flex flex-col gap-2.5 bg-white border border-slate-200 rounded-2xl p-3 sm:p-4 shadow-sm">
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

      {/* 가격 차트 (드래그 팬 + 휠/핀치 줌) — 우측 padRight 만큼 고정 가격축 거터 확보 (캔들 위 안 덮음) */}
      <div className="relative" style={{ paddingRight: padRight }}>
      <div
        ref={priceBoxRef}
        className="relative select-none overflow-x-auto overflow-y-hidden scrollbar-thin"
        onPointerMove={handlePointer}
        onPointerLeave={handleLeave}
        onScroll={(e) => {
          const sl = e.currentTarget.scrollLeft;
          setScrollX(sl);
          if (volScrollRef.current) volScrollRef.current.scrollLeft = sl;
          if (lastPointerXRef.current != null) updateHoverFromClientX(lastPointerXRef.current);
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{ touchAction: 'pan-x pan-y' }}
      >
        <svg
          viewBox={`0 0 ${W} ${priceH}`}
          className="block"
          width={W}
          preserveAspectRatio="none"
          style={{ height: priceChartHeight }}
        >
          {/* 가로 그리드 (가격 라벨은 우측 고정축으로 별도 렌더 — 스크롤해도 항상 보이게) */}
          {priceTicks.map(t => {
            const y = yPrice(t);
            return <line key={t} x1={padLeft} x2={W} y1={y} y2={y} stroke={GRID} strokeWidth={1} strokeDasharray="2 3" />;
          })}

          {/* 매수 구간 */}
          {buyPoints?.map((bp, i) => {
            const y = yPrice(bp.price);
            return (
              <g key={'bp' + i}>
                <line x1={padLeft} x2={W} y1={y} y2={y} stroke={UP} strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
                <text x={padLeft + 4} y={y - 4} fill={UP} fontSize="10" fontWeight="700" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{bp.label} {bp.price.toLocaleString('ko-KR')}</text>
              </g>
            );
          })}
          {sellPoints?.map((sp, i) => {
            const y = yPrice(sp.price);
            return (
              <g key={'sp' + i}>
                <line x1={padLeft} x2={W} y1={y} y2={y} stroke={DOWN} strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
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

          {/* X축 라벨 — interval 자동 감지로 단위 분기:
              - 분봉 (date 에 HH:MM 포함, 같은 날 인접 봉) → 매시 정각 (09:00, 10:00, ...)
              - 시간봉 (HH:MM 포함, 다른 날 인접 봉) → 매일 첫 봉 (MM/DD HH:MM)
              - 일/주봉 (HH:MM 없음) → 매월 첫 거래일 (MM/DD)
              일관 — 매월 1일이 휴장이면 그 달 첫 거래일 자동 표시 (기존 동작 유지). */}
          {(() => {
            const indices: number[] = [];
            // 분봉/시간봉 detection
            const firstD = normalizeDate(safeData[0].date);
            const firstT = firstD.match(/(\d{1,2}):(\d{2})/);
            const secondD = n > 1 ? normalizeDate(safeData[1].date) : firstD;
            const sameDate = firstD.slice(0, 10) === secondD.slice(0, 10);
            let mode: 'minute' | 'hourly' | 'daily' | 'monthly' = !firstT
              ? 'daily'
              : (sameDate ? 'minute' : 'hourly');

            // daily 후보 — 모든 데이터가 다른 월 + 12개+ 면 monthly (매봉 = 1개월).
            // 매년 1월만 라벨 표시해서 라벨 밀집 회피.
            if (mode === 'daily' && n >= 12) {
              const uniqueMonths = new Set(safeData.map(d => normalizeDate(d.date).slice(0, 7))).size;
              if (uniqueMonths === n) mode = 'monthly';
            }

            if (mode === 'minute') {
              // 매시 정각만 — 같은 hour 첫 봉만 라벨
              let prevHour = '';
              for (let i = 0; i < n; i++) {
                const dn = normalizeDate(safeData[i].date);
                const m = dn.match(/(\d{1,2}):(\d{2})/);
                if (!m) continue;
                const hour = m[1].padStart(2, '0');
                if (hour !== prevHour) { indices.push(i); prevHour = hour; }
              }
            } else if (mode === 'hourly') {
              // 매일 첫 봉 — 같은 date 첫 봉만 라벨
              let prevDate = '';
              for (let i = 0; i < n; i++) {
                const dn = normalizeDate(safeData[i].date);
                const date = dn.slice(0, 10);
                if (date !== prevDate) { indices.push(i); prevDate = date; }
              }
            } else if (mode === 'monthly') {
              // 월봉 — 매년 1월 (또는 그 해 첫 봉) 만 라벨. 라벨 밀집 회피.
              let prevYear = '';
              for (let i = 0; i < n; i++) {
                const dn = normalizeDate(safeData[i].date);
                const year = dn.slice(0, 4);
                if (year !== prevYear) { indices.push(i); prevYear = year; }
              }
            } else {
              // 일/주봉 — 매월 첫 거래일 (1일이 휴장이면 그 달 첫 거래일)
              let prevMonth = '';
              for (let i = 0; i < n; i++) {
                const dn = normalizeDate(safeData[i].date);
                const month = dn.slice(0, 7);
                if (month !== prevMonth) { indices.push(i); prevMonth = month; }
              }
            }
            const last = n - 1;
            if (indices.length > 0 && indices[indices.length - 1] !== last) indices.push(last);
            // 픽셀 간격 dedup — 라벨 폭보다 가까운 인접 라벨 제거 (줌/barPx 무관, 12/31·1/1 겹침 방지). 끝 라벨 우선 보존.
            const MIN_LABEL_GAP = 42;
            const pruned: number[] = [];
            for (const i of indices) {
              const prev = pruned[pruned.length - 1];
              if (prev === undefined || xs[i] - xs[prev] >= MIN_LABEL_GAP) pruned.push(i);
              else if (i === last) { pruned.pop(); pruned.push(i); } // 끝 라벨이 직전과 충돌하면 직전 대신 끝 유지
            }
            // 라벨 텍스트 — mode 별 분기
            const formatLabel = (d: string) => {
              const dn = normalizeDate(d);
              if (mode === 'minute') {
                const m = dn.match(/(\d{1,2}):(\d{2})/);
                return m ? `${m[1].padStart(2, '0')}:${m[2]}` : shortDate(d);
              }
              if (mode === 'hourly') {
                // MM/DD 만 (시간봉은 매일 단위라 시각 라벨 불필요)
                return shortDate(d);
              }
              if (mode === 'monthly') {
                // YYYY 만 (월봉은 연 단위 라벨로 충분 — hover 시 정확한 월 표시)
                return dn.slice(0, 4);
              }
              return shortDate(d);
            };
            return pruned.map(i => (
              <text key={'xl' + i} x={xs[i]} y={priceH - 6} fill={MUTED} fontSize="10" textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{formatLabel(safeData[i].date)}</text>
            ));
          })()}

        </svg>

        {/* 호버 툴팁 — 마우스 위치 기준 (커서 하단 가까울 때 위로 flip, 컨테이너 안 clamp) */}
        {hoverBar && hoverPos && (() => {
          const containerH = priceBoxRef.current?.clientHeight ?? 280;
          const containerW = priceBoxRef.current?.clientWidth ?? 800;
          const tooltipH = 130;
          const flipUp = hoverPos.y + tooltipH + 16 > containerH;
          const top = flipUp
            ? Math.max(4, hoverPos.y - tooltipH - 8)
            : Math.min(containerH - tooltipH - 4, Math.max(4, hoverPos.y - 8));
          return (
          <div
            className="absolute pointer-events-none bg-slate-900/95 text-white rounded-lg px-3 py-2 text-[11px] shadow-lg whitespace-nowrap z-10"
            style={{
              left: hoverPos.x + scrollX + 14,
              top,
              transform: hoverPos.x > 0.6 * containerW
                ? 'translateX(calc(-100% - 28px))' : undefined,
              minWidth: 140,
            }}
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
          );
        })()}
      </div>
      {/* 우측 고정 가격축 — 캔들 스크롤과 무관한 별도 컬럼 (캔들 위를 안 덮음). yPrice 동일 viewBox(priceH)+동일 높이라 그리드와 수직 정렬. */}
      <div className="absolute top-0 right-0 pointer-events-none" style={{ width: padRight, height: priceChartHeight }}>
        <svg viewBox={`0 0 ${padRight} ${priceH}`} className="block" width={padRight} preserveAspectRatio="none" style={{ height: priceChartHeight }}>
          {priceTicks.map(t => (
            <text key={'pa' + t} x={4} y={yPrice(t)} fill={MUTED} fontSize="10" textAnchor="start" dominantBaseline="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif" className="tabular-nums">{t.toLocaleString('ko-KR')}</text>
          ))}
        </svg>
      </div>
      </div>

      {/* 거래량 차트 — 가격과 가로 스크롤 동기화 (width=W + overflow-hidden, price onScroll 이 scrollLeft 맞춤). 우측 padRight 거터로 거래량축 분리. */}
      <div className="relative" style={{ paddingRight: padRight }}>
      <div ref={volScrollRef} className="relative overflow-x-hidden">
        <svg viewBox={`0 0 ${W} ${volH}`} className="block" width={W} preserveAspectRatio="none" style={{ height: volChartHeight }}>
          {volTicks.map(t => {
            const y = yVol(t);
            return <line key={t} x1={padLeft} x2={W} y1={y} y2={y} stroke={GRID} strokeWidth={1} strokeDasharray="2 3" />;
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
      {/* 우측 고정 거래량축 — 가격축과 동일 패턴 (별도 컬럼, yVol 동일 viewBox(volH)+동일 높이로 그리드와 수직 정렬) */}
      <div className="absolute top-0 right-0 pointer-events-none" style={{ width: padRight, height: volChartHeight }}>
        <svg viewBox={`0 0 ${padRight} ${volH}`} className="block" width={padRight} preserveAspectRatio="none" style={{ height: volChartHeight }}>
          {volTicks.map(t => (
            <text key={'va' + t} x={4} y={yVol(t)} fill={MUTED} fontSize="9" textAnchor="start" dominantBaseline="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{compactKorean(t)}</text>
          ))}
        </svg>
      </div>
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
