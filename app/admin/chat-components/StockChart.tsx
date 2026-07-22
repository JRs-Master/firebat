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
  buyPoints?: Array<{ label: string; price: number; note?: string; date?: string }>;
  sellPoints?: Array<{ label: string; price: number; note?: string; date?: string }>;
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

// HTS식 매수/매도 화살표 폴리곤 — 몸통(shaft) + 머리(head). up=true: 위로(매수, 봉 아래서 위 가리킴) /
// false: 아래로(매도, 봉 위에서 아래). apex(y0)=머리 끝, 몸통이 s 방향으로 len 만큼 뻗음.
function arrowPath(x: number, y0: number, up: boolean): string {
  const hw = 7.5, sw = 3.2, hh = 8, len = 13; // 머리 반폭 / 몸통 반폭 / 머리 길이 / 전체 — HTS 식 굵고 짜리몽땅
  const s = up ? 1 : -1;
  return ([
    [x, y0],                  // 머리 끝(apex)
    [x - hw, y0 + s * hh],    // 머리 좌
    [x - sw, y0 + s * hh],    // 몸통 좌 위
    [x - sw, y0 + s * len],   // 몸통 좌 끝
    [x + sw, y0 + s * len],   // 몸통 우 끝
    [x + sw, y0 + s * hh],    // 몸통 우 위
    [x + hw, y0 + s * hh],    // 머리 우
  ] as [number, number][]).map(p => `${p[0]},${p[1]}`).join(' ');
}

// 줌 = 한 화면 캔들 수. 봉 폭(px)으로 캡 — 화면폭 무관 일관.
// 기본 줌 = 봉 폭(슬롯 px)을 고정 → 한 화면 개수는 화면 폭에 맞춰 자동(넓으면 많이·좁으면 적게).
// 봉 크기가 화면·데이터에 따라 들쭉날쭉하지 않게(주식차트 가독). 보기 좋은 값으로 디바이스별 분리.
const DEFAULT_BAR_PX_PC = 18;     // PC 기본 캔들 슬롯 폭 (몸통 ~0.6×≈11px) — 넓은 화면서 보기 좋은 굵기
const DEFAULT_BAR_PX_MOBILE = 11; // 모바일 — 터치·가독 위해 약간 굵게 (→ 한 화면 개수도 더 적음)
const ZOOM_MAX_BAR = 36;     // 줌인 한계 (봉 ~36px, 그 이상 안 커짐)
const ZOOM_MIN_BAR = 3;      // 줌아웃 한계 (봉 ~3px, 그 이하 안 작아짐)
const ZOOM_RIGHT_PAD_SLOTS = 2; // 최신 캔들 우측 여백(slot 수) — 데이터 적으면 이 여백 맞춰 우측 정렬.

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
  // 날짜부만 MM/DD — ISO datetime("2026-01-02T00:00:00+09:00")이 그대로 와도 시각·TZ 를 흘리지 않는다.
  // "YYYYMMDD HH:MM"(분봉 시드/라이브) 도 앞 8자리로 MM/DD 추출 — 안 그러면 풀 문자열이 노출된다.
  const m = n.match(/^(\d{4})-(\d{2})-(\d{2})/) || n.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[2]}/${m[3]}` : n;
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

// 값을 1/2/5×10^k 로 올림 — 거래량 축 상한용. 보이는 구간 max 에 적용하면 깔끔한 눈금 + 막대 위 약간 여백.
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
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
  const pinnedRightRef = useRef(true); // 우측(최신) 고정 여부 — 좌로 스크롤하면 해제, 우측 끝 복귀 시 재고정

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
  const volChartHeightPx = Math.floor(chartAreaH * 80 / 360);
  const volChartHeight = `${volChartHeightPx}px`;      // 거래량 (옛 80/360 비율)

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
    // close + date 만 있으면 렌더 — 누락 OHLC 는 close 로 폴백(플랫 캔들), volume 누락은 0. 옛 isNum(전부) filter 는
    // AI 가 close-only/부분 OHLCV 보내면 전부 버려 빈 차트(silent skip)였음.
    // 튜플 형태 [date, open, high, low, close, volume] 도 수용 — AI 가 배열로 보낼 때 객체로 변환.
    const rows = (data as unknown[]).map((d) =>
      Array.isArray(d)
        ? { date: d[0], open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5] }
        : d,
    ) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    const valid = rows
      .filter(d => d && isNum(d.close) && !!d.date)
      .map(d => {
        const c = d.close;
        const o = isNum(d.open) ? d.open : c;
        return {
          ...d,
          open: o,
          high: isNum(d.high) ? d.high : Math.max(o, c),
          low: isNum(d.low) ? d.low : Math.min(o, c),
          close: c,
          volume: isNum(d.volume) ? d.volume : 0,
        };
      });
    // 날짜 canonical 화 (데이터셋 단위) — 서버 주입(dataCacheKey) records 는 캐시 원본 ISO
    // ("2026-01-02T00:00:00+09:00") 그대로 온다. 시각이 전부 자정이면 일봉 데이터 = 날짜만
    // 남긴다 — 안 그러면 "T00:00" 이 분/시간봉 감지 정규식에 걸려 mode='hourly'(매일 라벨
    // = 빼곡) + 헤더 기간에 시각·TZ 노출 (2026-07-06 실측). 인트라데이(자정 아닌 시각 존재)
    // 는 "YYYY-MM-DD HH:MM" 로 통일 (TZ·초 제거) — 분/시간봉 감지는 그대로 동작.
    const isoTime = (s: string) => {
      const m = s.match(/[T ](\d{2}):(\d{2})/);
      return m ? `${m[1]}:${m[2]}` : null;
    };
    const allMidnight = valid.every(d => {
      const t = isoTime(String(d.date));
      return t === null || t === '00:00';
    });
    const canon = valid.map(d => {
      const s = normalizeDate(String(d.date));
      const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
      if (!m) return d;
      return { ...d, date: allMidnight || !m[2] ? m[1] : `${m[1]} ${m[2]}:${m[3]}` };
    });
    return [...canon].sort((a, b) => normalizeDate(a.date).localeCompare(normalizeDate(b.date)));
  }, [data]);
  const fullN = fullData.length;

  // close-only 감지 — AI 가 종가 추이만 손으로 적어 보낸 경우(원본에 open/high/low 전무). 전부
  // flat-doji dash 봉으로 그려져 "그리다 만 봉차트"로 보이던 것(2026-07-06 실측) → 종가 라인으로
  // 렌더. 거래량도 전무(0 폴백)라 거래량 pane·카드도 숨긴다. 한 행이라도 OHLC 가 있으면 봉 유지.
  const closeOnly = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return false;
    const rows = (data as unknown[]).map(d =>
      Array.isArray(d) ? { open: d[1], high: d[2], low: d[3], close: d[4] } : d,
    ) as Array<Record<string, unknown>>;
    const valid = rows.filter(d => d && isNum(d.close));
    return valid.length > 0 && valid.every(d => !isNum(d.open) && !isNum(d.high) && !isNum(d.low));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // 줌 모델 — 봉 폭(슬롯 px)이 기본, 한 화면 개수는 화면 폭에 맞춰 자동. 사용자가 휠/핀치로 줌하면
  // 그때부터 cps(개수)를 사용(확대·축소 동작). 데이터 바뀌면 기본 줌으로 복원. 헤더용 뷰포트 폭 재사용해 PC/모바일 구분.
  const isMobileChart = (_vwForHeader ?? 1024) < 640;
  const [cps, setCps] = useState(60);                   // seed — 실제 기본 줌은 폭 기반 baseCps. 사용자 줌 시에만 사용.
  const [userZoomed, setUserZoomed] = useState(false);  // true = 휠/핀치로 줌함 → cps 사용. false = 폭 기반 기본 줌.
  const [zoomEndTick, setZoomEndTick] = useState(0);  // 줌 종료 시 +1 → Y축 라이브 재계산 트리거
  // 데이터 변경 시 기본 줌(폭 기반)·최신 보기로 복원.
  useEffect(() => { setUserZoomed(false); pinnedRightRef.current = true; }, [fullN]);
  // 줌 앵커 — 휠/핀치 후 커서 아래 캔들이 제자리 유지하도록 scrollLeft 보정 (useLayoutEffect 적용).
  const zoomAnchorRef = useRef<{ idx: number; offsetX: number } | null>(null);
  // 현재 barPx 미러 — native wheel 핸들러(stale closure)가 최신 barPx 를 읽게.
  const barPxRef = useRef(0);
  // 캔들 시작 x(좌측 여백 포함) 미러 — sparse 우측 정렬 시 native/callback 핸들러가 최신 leftPad 를 읽게.
  const leftPadRef = useRef(0);
  // 줌 경계 미러 — 현재 effCps(클램프됨) + 유효 [min, max]. 줌을 raw cps 가 아니라 화면에 실제
  // 보이는 effCps 기준으로 → cps 상태가 범위 밖에 떠 휠이 헛도는 dead-zone 제거.
  const zoomBoundsRef = useRef<{ eff: number; min: number; max: number }>({ eff: 60, min: 2, max: 2000 });
  // Y축 freeze — 줌 제스처 중엔 직전 라이브 Y 유지(가로 줌인데 세로 출렁임 방지), 끝나면 재스케일.
  const zoomingRef = useRef(false);
  const frozenYRef = useRef<{ pMin: number; pMax: number; maxV: number } | null>(null);
  const zoomEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markZooming = useCallback(() => {
    zoomingRef.current = true;
    if (zoomEndTimerRef.current) clearTimeout(zoomEndTimerRef.current);
    zoomEndTimerRef.current = setTimeout(() => {
      zoomingRef.current = false;
      setZoomEndTick(t => t + 1);  // 줌 종료 → 라이브 Y 재계산
    }, 220);
  }, []);
  const safeData = fullData;
  const n = fullN;

  // 줌/팬 내부 참조 (isDragging: 임계값 넘어야 팬 시작 — 그 전까지는 툴팁)
  const pinchRef = useRef<{ startDist: number; startCps: number } | null>(null);
  // 모바일 롱프레스 툴팁 — 1손가락 드래그 = 스크롤, 0.5초 누름 = 툴팁(MTS 표준). 스크롤↔툴팁 충돌 해소.
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipModeRef = useRef(false);   // 롱프레스 진입 후 true — native touchmove 가 스크롤 차단 + 툴팁 추적
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // 줌: 한 화면 캔들 수(cps) 조정. factor>1 = 줌아웃(많이·좁게), <1 = 줌인(적게·넓게).
  // 위치 앵커는 barPx 비례 scrollLeft 보정(아래 useLayoutEffect)으로 — 보던 구간 유지.
  const zoomAround = useCallback((factor: number) => {
    if (fullN < 2) return;
    // 현재 화면에 보이는 effCps 기준으로 줌 (raw cps 아님) → 매 휠이 즉시 반영, dead-zone 0.
    const b = zoomBoundsRef.current;
    const next = Math.round((b.eff || 60) * factor);
    setUserZoomed(true);  // 사용자 줌 진입 → 폭 기반 기본 대신 cps 사용 (확대·축소 동작).
    setCps(Math.max(b.min, Math.min(b.max, next)));
  }, [fullN]);

  // PC 휠 줌 (preventDefault 필요 → native listener)
  useEffect(() => {
    const el = priceBoxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (fullN < 2) return;
      e.preventDefault();
      // 커서 밑 캔들을 줌 후에도 커서 위치에 고정 — 줌 직전 {분수 idx, 커서 뷰포트 x} 저장.
      const bp = barPxRef.current;
      const rect = el.getBoundingClientRect();
      const cursorVX = e.clientX - rect.left;
      zoomAnchorRef.current = { idx: bp > 0 ? (cursorVX + el.scrollLeft - leftPadRef.current) / bp : 0, offsetX: cursorVX };
      pinnedRightRef.current = false;
      markZooming();
      zoomAround(e.deltaY > 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround, fullN, markZooming]);

  // 모바일 2손가락 핀치: 브라우저 viewport 줌 차단 (차트 자체 핀치로 처리)
  useEffect(() => {
    const el = priceBoxRef.current;
    if (!el) return;
    const onTouchStartNative = (e: TouchEvent) => {
      if (e.touches.length === 2) e.preventDefault();
    };
    const onTouchMoveNative = (e: TouchEvent) => {
      // 2손가락(핀치) 또는 롱프레스 툴팁 모드 = 브라우저 스크롤 차단 (툴팁이 1손가락으로 봉 추적).
      if (e.touches.length === 2 || tooltipModeRef.current) e.preventDefault();
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
  const volH = volChartHeightPx;  // viewBox 높이 = 실제 박스 px. 옛 고정 80 → preserveAspectRatio="none" 에서 거래량 축 라벨 세로 찌그러짐. 동일화로 왜곡 0.
  const padLeft = 8;  // 좌측 여백 — 가격축 라벨은 우측 거터라 좌측 축이 없음. 옛 50 은 가장 옛날 봉 앞에 며칠치 빈 공간만 만들어 작게.
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
  const cpsMin = Math.max(2, Math.round(plotBoxW / ZOOM_MAX_BAR));         // 줌인 한계 (봉 ~36px)
  const cpsMax = Math.max(cpsMin + 1, Math.round(plotBoxW / ZOOM_MIN_BAR)); // 줌아웃 한계 (봉 ~3px)
  // 기본 줌 = 디바이스별 고정 봉 폭 → 한 화면 개수 자동(넓을수록 많이·좁을수록 적게, 봉 크기는 일정).
  const baseCps = Math.round(plotBoxW / (isMobileChart ? DEFAULT_BAR_PX_MOBILE : DEFAULT_BAR_PX_PC));
  const targetCps = userZoomed ? cps : baseCps;  // 사용자 줌 시 cps, 아니면 폭 기반 기본.
  // 데이터 수와 무관하게 봉 폭 고정 (옛 min(cps, fullN) 폐기 — 데이터 적다고 봉이 커지지 않게).
  const effCps = Math.max(cpsMin, Math.min(cpsMax, targetCps));            // 한 화면 캔들 수
  const barPx = plotBoxW / effCps;                                          // 캔들 슬롯 px (기본 = 고정 폭)
  barPxRef.current = barPx;
  zoomBoundsRef.current = { eff: effCps, min: cpsMin, max: cpsMax };
  // 데이터가 화면보다 적으면 봉을 늘리지 않고 우측 정렬 — 우측 여백 슬롯 맞춰 끝에서 시작, 남는 만큼 좌측 여백.
  const contentW = padLeft + (fullN + ZOOM_RIGHT_PAD_SLOTS) * barPx;
  const slack = Math.max(0, Math.round(boxW) - Math.round(contentW));
  const leftPad = padLeft + slack;                                          // 캔들 시작 x (sparse 시 우측 정렬)
  leftPadRef.current = leftPad;
  const W = Math.max(Math.round(boxW), Math.round(contentW));
  const plotH = priceH - padTop - padBottom;
  const volPlotH = volH - 4 - 16;

  // 스크롤 위치 보정 — 지오메트리(boxW/W/barPx) 변할 때마다 실행.
  //  · 우측 고정 상태(pinnedRight): 끝(최신)으로 — ResizeObserver 가 boxW 를 늦게 확정해도 항상 우측에 닿음.
  //  · 아니면: 줌 시 보던 구간 유지 (콘텐츠 폭 ∝ barPx → scrollLeft 비례 보정).
  const prevBarRef = useRef(barPx);
  useLayoutEffect(() => {
    const el = priceBoxRef.current;
    if (!el) return;
    if (zoomAnchorRef.current) {
      // 커서/핀치 앵커 — 저장한 캔들이 줌 후에도 같은 화면 위치에 오게 scrollLeft 직접 계산(왕복 없음).
      const { idx, offsetX } = zoomAnchorRef.current;
      el.scrollLeft = leftPad + idx * barPx - offsetX;
      zoomAnchorRef.current = null;
    } else if (pinnedRightRef.current) {
      el.scrollLeft = el.scrollWidth;
    } else if (prevBarRef.current && prevBarRef.current !== barPx) {
      el.scrollLeft = el.scrollLeft * (barPx / prevBarRef.current);
    }
    prevBarRef.current = barPx;
  }, [barPx, boxW, fullN, leftPad]);

  const { xs, yPrice, yVol, candleW, minP, maxP, maxV, maLines } = useMemo(() => {
    const closes = safeData.map(d => d.close);
    // 화면에 보이는 구간(scrollX ~ scrollX+boxW)만 추출 → Y축(가격·거래량)을 그 구간 min/max 로 동적 스케일.
    // 전체 범위 고정 시 과거 저가 구간 봉이 납작해지던 문제 해결. xs/캔들은 전체 렌더(가로 스크롤) 유지.
    const firstVis = Math.max(0, Math.floor((scrollX - leftPad) / barPx));
    const lastVis = Math.min(safeData.length - 1, Math.ceil((scrollX + boxW - leftPad) / barPx));
    const vis = lastVis >= firstVis ? safeData.slice(firstVis, lastVis + 1) : safeData;
    const liveMaxP = Math.max(...vis.map(d => d.high));
    const liveMinP = Math.min(...vis.map(d => d.low));
    const rangeP = liveMaxP - liveMinP || 1;
    const livePMin = liveMinP - rangeP * 0.05;
    const livePMax = liveMaxP + rangeP * 0.05;
    const liveMaxV = niceCeil(Math.max(...vis.map(d => d.volume), 1));  // 거래량 축 상한 = 보이는 구간 max 의 nice 올림.
    // Y축 freeze — 줌 제스처 중엔 직전 라이브 Y 유지(가로 줌인데 세로 출렁임 방지), 끝나면(zoomEndTick) 라이브 재스케일.
    let pMin = livePMin, pMax = livePMax, maxV = liveMaxV;
    if (zoomingRef.current && frozenYRef.current) {
      ({ pMin, pMax, maxV } = frozenYRef.current);
    } else {
      frozenYRef.current = { pMin: livePMin, pMax: livePMax, maxV: liveMaxV };
    }
    // 캔들 x = 각 캔들 슬롯(barPx) 중앙. 폭은 barPx 비례.
    const xs = safeData.map((_, i) => leftPad + i * barPx + barPx / 2);
    const yPrice = (p: number) => padTop + plotH - ((p - pMin) / (pMax - pMin)) * plotH;
    const yVol = (v: number) => 4 + volPlotH - (v / maxV) * volPlotH;
    const candleW = Math.max(1.5, barPx * 0.6);
    const maLines = indicators.map(ind => {
      const period = parseInt(ind.replace('MA', ''), 10);
      const values = sma(closes, period);
      const pts = values.map((v, i) => v == null ? null : [xs[i], yPrice(v)] as [number, number]).filter(Boolean) as [number, number][];
      const d = pts.length ? 'M ' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ') : '';
      return { name: ind, d, color: MA_COLORS[ind], values };
    });
    return { xs, yPrice, yVol, candleW, minP: pMin, maxP: pMax, maxV, maLines };
  }, [safeData, indicators, barPx, plotH, leftPad, padTop, volPlotH, scrollX, boxW, zoomEndTick]);

  // clientX → 캔들 인덱스 (툴팁/호버용) — 가로 스크롤(scrollLeft) 반영.
  const updateHoverFromClientX = useCallback((clientX: number) => {
    const el = priceBoxRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const contentX = (clientX - rect.left) + el.scrollLeft; // 1:1 이라 콘텐츠 px = svg 단위
    const idx = Math.round((contentX - leftPadRef.current - barPx / 2) / barPx);
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  }, [n, barPx]);

  const handlePointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 터치는 롱프레스(tooltipMode) 일 때만 툴팁 — 일반 터치 드래그는 스크롤(툴팁 X). 마우스는 항상 hover.
    if (e.pointerType === 'touch' && !tooltipModeRef.current) return;
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
      if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
      tooltipModeRef.current = false;
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      pinchRef.current = { startDist: d, startCps: zoomBoundsRef.current.eff };
      setHoverIdx(null);
    } else if (e.touches.length === 1) {
      // 1손가락: 바로 툴팁 안 띄움 — 0.5초 누르고 있으면(롱프레스) 툴팁 진입. 그 전 이동은 스크롤.
      const t = e.touches[0];
      touchStartRef.current = { x: t.clientX, y: t.clientY };
      tooltipModeRef.current = false;
      lastPointerXRef.current = null;  // 스크롤 중 onScroll 가 옛 커서로 크로스헤어 띄우지 않게.
      if (longPressRef.current) clearTimeout(longPressRef.current);
      longPressRef.current = setTimeout(() => {
        tooltipModeRef.current = true;
        const s = touchStartRef.current;
        if (s) {
          updateHoverFromClientX(s.x);
          const el = priceBoxRef.current;
          if (el) { const r = el.getBoundingClientRect(); setHoverPos({ x: s.x - r.left, y: s.y - r.top }); }
        }
      }, 500);
    }
  }, [fullN, cps, updateHoverFromClientX]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      // 핀치 중심 밑 캔들 고정 — 두 손가락 중점을 앵커로.
      const pel = priceBoxRef.current;
      if (pel) {
        const rect = pel.getBoundingClientRect();
        const midVX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const bp = barPxRef.current;
        zoomAnchorRef.current = { idx: bp > 0 ? (midVX + pel.scrollLeft - leftPadRef.current) / bp : 0, offsetX: midVX };
        pinnedRightRef.current = false;
      }
      markZooming();
      // 핀치 벌림(d↑) = 줌인(적게·넓게) = cps↓. startCps × (startDist / d).
      const b = zoomBoundsRef.current;
      const next = Math.round(pinchRef.current.startCps * (pinchRef.current.startDist / Math.max(d, 1)));
      setUserZoomed(true);  // 핀치 줌 진입 → 폭 기반 기본 대신 cps 사용 (모바일 줌 동작 — 옛 누락 fix).
      setCps(Math.max(b.min, Math.min(b.max, next)));
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      if (tooltipModeRef.current) {
        // 롱프레스 진입 후 — 손가락 따라 봉 추적 (스크롤은 native 리스너가 차단).
        updateHoverFromClientX(t.clientX);
        const el = priceBoxRef.current;
        if (el) { const r = el.getBoundingClientRect(); setHoverPos({ x: t.clientX - r.left, y: t.clientY - r.top }); }
      } else if (touchStartRef.current) {
        // 롱프레스 전 이동 = 스크롤 의도 → 타이머 취소 + 크로스헤어/툴팁·커서참조 제거 (스크롤 중엔 세로 기준선 안 뜸).
        const dx = Math.abs(t.clientX - touchStartRef.current.x);
        const dy = Math.abs(t.clientY - touchStartRef.current.y);
        if (dx > 8 || dy > 8) {
          if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
          lastPointerXRef.current = null;
          setHoverIdx(null); setHoverPos(null);
        }
      }
    }
  }, [updateHoverFromClientX, markZooming]);
  const handleTouchEnd = useCallback(() => {
    pinchRef.current = null;
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    tooltipModeRef.current = false;
    setHoverIdx(null); setHoverPos(null);
  }, []);

  const priceTicks = useMemo(() => niceTicks(minP, maxP, 5), [minP, maxP]);
  const volTicks = useMemo(() => [maxV / 2, maxV], [maxV]);  // 거래량 축 = 중간·상한 2단계 (maxV = nice 올림된 동적 상한, 라벨 항상 표시).

  // 빈 데이터 가드 — 아래 파생(viewFirst.date 등)이 undefined 참조로 크래시하기 *전*에.
  // (옛엔 이 가드가 파생 계산 뒤(514)에 있어 데이터 없는 카드가 ErrorBoundary 로 죽었음 —
  // 2026-07-06 실측: dataCacheKey 미주입 메시지 리로드. 마지막 hook(volTicks) 뒤라 순서 안전.)
  if (n === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-400 text-[13px]">
        차트 데이터가 없습니다.
      </div>
    );
  }

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
  // 기간 라벨 — 인트라데이(분/시간봉)면 봉 개수를 "일"로 세면 안 됨("25일" 버그). 시각(HH:MM)이
  // 있고 자정이 아닌 봉이 있으면 인트라데이로 보고 범위는 시:분 위주, 개수 단위는 "봉".
  const timeOf = (d: string): string => {
    const m = normalizeDate(d).match(/(\d{2}:\d{2})/);
    return m ? m[1] : '';
  };
  const isIntraday = safeData.some(d => { const t = timeOf(d.date); return t && t !== '00:00'; });
  const rangeLabel = (d: string): string => {
    if (!isIntraday) return shortDate(d);
    const t = timeOf(d);
    return t ? `${shortDate(d)} ${t}` : shortDate(d);
  };
  const firstDate = rangeLabel(viewFirst.date);
  const lastDate = rangeLabel(viewLatest.date);
  const countUnit = isIntraday ? '봉' : '일';
  const periodLabel = firstDate === lastDate
    ? `${firstDate} · 1${countUnit}`
    : `${firstDate} ~ ${lastDate} · ${n}${countUnit}`;
  const titleText = title && title.trim() && title.trim() !== symbol ? title : symbol;
  const showSymbolChip = titleText !== symbol;
  const periodHigh = Math.max(...safeData.map(d => d.high));
  const periodLow = Math.min(...safeData.map(d => d.low));
  const periodVolume = safeData.reduce((sum, d) => sum + d.volume, 0);
  // 가격 표시 반올림 — yfinance 수정주가가 소수점을 달고 와("119,951.722") 헤더·카드가 지저분.
  // 1000 이상(원화권) = 정수, 미만(저가·해외 주식) = 소수 2자리.
  const fmtPrice = (x: number) =>
    x >= 1000
      ? Math.round(x).toLocaleString('ko-KR')
      : x.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

  const hoverBar = hoverIdx != null ? safeData[hoverIdx] : null;
  const hoverX = hoverIdx != null ? xs[hoverIdx] : null;
  // 십자선 가로 + 가격축 태그 — hoverPos.y(priceBox px) = viewBox y (priceH=priceChartHeightPx 라 1:1).
  const hoverY = hoverPos ? Math.max(padTop, Math.min(priceH - padBottom, hoverPos.y)) : null;
  const hoverPrice = hoverY != null ? minP + ((padTop + plotH - hoverY) / plotH) * (maxP - minP) : null;
  // 툴팁용 — 호버 봉의 "그려진" 이평선 값만 (indicators 에 있는 것만, null 제외).
  const hoverMAs = hoverIdx != null
    ? maLines.map(m => ({ name: m.name, color: m.color, value: m.values[hoverIdx] })).filter(m => m.value != null)
    : [];

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
          <span className="text-[20px] sm:text-[22px] font-extrabold text-slate-900 tabular-nums">{fmtPrice(latest.close)}</span>
          <span className={`text-[12px] font-bold tabular-nums ${changeColor}`}>
            {changeArrow} {fmtPrice(Math.abs(change))} ({changeSign}{changePct.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* 스탯 카드 — 전부 기간 기준으로 통일. 옛엔 시가·거래량=최신 봉 / 고가·저가=기간 혼재라
          "시가 118K 인데 저가 49K" 처럼 한 줄에 다른 기준이 섞여 이상하게 읽혔다(2026-07-06 실측).
          기간 라벨(01/02~12/30·N일)이 바로 위라 기간 기준이 자연스럽게 읽힘. 현재가·전일대비는 헤더. */}
      <div className={`grid ${closeOnly ? 'grid-cols-3' : 'grid-cols-4'} gap-2 sm:gap-3`}>
        {(closeOnly
          ? [
              // close-only = 시가·거래량 데이터가 없음 — 종가 기반 카드만 (시작=첫 종가).
              { label: '시작', v: viewFirst.close, color: 'text-slate-700' },
              { label: '최고', v: periodHigh, color: 'text-red-600' },
              { label: '최저', v: periodLow, color: 'text-blue-600' },
            ]
          : [
              { label: '시가', v: viewFirst.open, color: 'text-slate-700' },
              { label: '고가', v: periodHigh, color: 'text-red-600' },
              { label: '저가', v: periodLow, color: 'text-blue-600' },
              { label: '거래량', v: periodVolume, color: 'text-slate-700', compact: true },
            ]
        ).map((s: { label: string; v: number; color: string; compact?: boolean }, i) => (
          <div key={i} className="bg-slate-50 rounded-xl p-2 sm:p-3 flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] sm:text-[11px] text-slate-400 font-semibold">{s.label}</span>
            <span className={`text-[12px] sm:text-[15px] font-extrabold tabular-nums whitespace-nowrap ${s.color}`}>
              {s.compact ? compactKorean(s.v) : fmtPrice(s.v)}
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
          const el = e.currentTarget;
          const sl = el.scrollLeft;
          pinnedRightRef.current = sl >= (el.scrollWidth - el.clientWidth) - 2; // 우측 끝이면 최신 고정 유지
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

          {/* 매수 — date 있으면 해당 봉 아래 ↑ 화살표(매수 시점), 없으면 price 레벨 수평선(지지) */}
          {buyPoints?.map((bp, i) => {
            const idx = bp.date ? safeData.findIndex(d => normalizeDate(d.date).slice(0, 10) === normalizeDate(bp.date!).slice(0, 10)) : -1;
            if (idx >= 0) {
              const x = xs[idx];
              const ay = yPrice(safeData[idx].low) + 4; // 봉 저가 아래 — 위로 가리킴
              return (
                <g key={'bp' + i}>
                  <polygon points={arrowPath(x, ay, true)} fill={UP} />
                  {bp.label && <text x={x} y={ay + 26} fill={UP} fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{bp.label}</text>}
                </g>
              );
            }
            const y = yPrice(bp.price);
            return (
              <g key={'bp' + i}>
                <line x1={padLeft} x2={W} y1={y} y2={y} stroke={UP} strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
                <text x={padLeft + 4} y={y - 4} fill={UP} fontSize="10" fontWeight="700" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{bp.label} {bp.price.toLocaleString('ko-KR')}</text>
              </g>
            );
          })}
          {/* 매도 — date 있으면 해당 봉 위 ↓ 화살표(매도 시점), 없으면 price 레벨 수평선(저항) */}
          {sellPoints?.map((sp, i) => {
            const idx = sp.date ? safeData.findIndex(d => normalizeDate(d.date).slice(0, 10) === normalizeDate(sp.date!).slice(0, 10)) : -1;
            if (idx >= 0) {
              const x = xs[idx];
              const ay = yPrice(safeData[idx].high) - 4; // 봉 고가 위 — 아래로 가리킴
              return (
                <g key={'sp' + i}>
                  <polygon points={arrowPath(x, ay, false)} fill={DOWN} />
                  {sp.label && <text x={x} y={ay - 22} fill={DOWN} fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{sp.label}</text>}
                </g>
              );
            }
            const y = yPrice(sp.price);
            return (
              <g key={'sp' + i}>
                <line x1={padLeft} x2={W} y1={y} y2={y} stroke={DOWN} strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
                <text x={padLeft + 4} y={y - 4} fill={DOWN} fontSize="10" fontWeight="700" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{sp.label} {sp.price.toLocaleString('ko-KR')}</text>
              </g>
            );
          })}

          {/* 캔들 — close-only 데이터(open/high/low 없음)는 종가 라인으로 (flat-doji dash 방지) */}
          {closeOnly ? (
            <g>
              <path
                d={safeData.map((d, i) => `${i === 0 ? 'M' : 'L'}${xs[i]},${yPrice(d.close)}`).join(' ')}
                fill="none" stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              />
              {n <= 40 && safeData.map((d, i) => (
                <circle key={'cd' + i} cx={xs[i]} cy={yPrice(d.close)} r={2.5} fill="#2563eb" />
              ))}
            </g>
          ) : safeData.map((d, i) => {
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
          {/* 십자선 가로 — 마우스 높이(가격 수평선) */}
          {hoverY != null && (
            <line x1={padLeft} x2={W} y1={hoverY} y2={hoverY} stroke={FG} strokeWidth={1} strokeDasharray="2 2" opacity={0.35} />
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
            return pruned.map((i, pi) => {
              // 양 끝 라벨 — 중앙 정렬 시 SVG 밖으로 잘리므로 안쪽 정렬 + clamp (좌:start / 우:end). padLeft 축소로 좌측 끝도 보강.
              const isLast = i === n - 1;
              const isFirst = pi === 0;
              const anchor = isLast ? 'end' : isFirst ? 'start' : 'middle';
              const lx = isLast ? Math.min(xs[i] + barPx * 0.5, W - 2) : isFirst ? Math.max(xs[i] - barPx * 0.5, 2) : xs[i];
              return (
                <text key={'xl' + i} x={lx} y={priceH - 6} fill={MUTED} fontSize="10" textAnchor={anchor} fontFamily="'Pretendard Variable', Pretendard, sans-serif">{formatLabel(safeData[i].date)}</text>
              );
            });
          })()}

        </svg>

        {/* 호버 툴팁 — 마우스 위치 기준 (커서 하단 가까울 때 위로 flip, 컨테이너 안 clamp) */}
        {hoverBar && hoverPos && (() => {
          const containerH = priceBoxRef.current?.clientHeight ?? 280;
          const containerW = priceBoxRef.current?.clientWidth ?? 800;
          const compact = isMobileChart;  // 모바일 — 폰트·여백·폭 축소
          // 실제 높이 추정(행 수 기반) — 옛 고정 130 underestimate 라 컨테이너(overflow-y-hidden)서 MA20 행이 잘리던 것.
          const rowCount = 5 + hoverMAs.length;  // 시·고·저·종·거래량 + 그려진 이평선
          const rowH = compact ? 14 : 17;
          const tooltipH = (compact ? 26 : 38) + rowCount * rowH + (hoverMAs.length ? (compact ? 8 : 10) : 0);
          const flipUp = hoverPos.y + tooltipH + 16 > containerH;
          const top = flipUp
            ? Math.max(4, hoverPos.y - tooltipH - 8)
            : Math.min(containerH - tooltipH - 4, Math.max(4, hoverPos.y - 8));
          // 가로 위치 — 크로스헤어 우측 기본, 우측 넘치면 왼쪽으로. visible 컨테이너 안으로 clamp 후 content 좌표(+scrollX).
          const tipW = compact ? 128 : 185;
          const rightLeft = hoverPos.x + 14;
          const visLeft = rightLeft + tipW > containerW ? hoverPos.x - tipW - 14 : rightLeft;
          const tipLeft = Math.max(4, Math.min(visLeft, containerW - tipW - 4)) + scrollX;
          return (
          <div
            className={`absolute pointer-events-none bg-slate-900/95 text-white rounded-lg shadow-lg whitespace-nowrap z-10 ${compact ? 'px-2 py-1.5 text-[10px]' : 'px-3 py-2 text-[11px]'}`}
            style={{
              left: tipLeft,
              top,
              minWidth: compact ? 104 : 140,
            }}
          >
            <div className={`font-bold text-slate-300 ${compact ? 'mb-1 text-[10px]' : 'mb-1.5 text-[11px]'}`}>{normalizeDate(hoverBar.date)}</div>
            <div className={`flex flex-col tabular-nums leading-tight ${compact ? 'gap-0' : 'gap-0.5'}`}>
              {(closeOnly
                ? [{ k: '종가', v: hoverBar.close.toLocaleString('ko-KR'), c: 'font-bold' }]
                : [
                    { k: '시가', v: hoverBar.open.toLocaleString('ko-KR'), c: '' },
                    { k: '고가', v: hoverBar.high.toLocaleString('ko-KR'), c: 'text-red-300' },
                    { k: '저가', v: hoverBar.low.toLocaleString('ko-KR'), c: 'text-blue-300' },
                    { k: '종가', v: hoverBar.close.toLocaleString('ko-KR'), c: 'font-bold' },
                    { k: '거래량', v: compactKorean(hoverBar.volume), c: 'text-slate-300' },
                  ]
              ).map((row, i) => (
                <div key={i} className={`flex items-baseline justify-between ${compact ? 'gap-2' : 'gap-4'}`}>
                  <span className="text-slate-400">{row.k}</span>
                  <span className={row.c}>{row.v}</span>
                </div>
              ))}
              {hoverMAs.length > 0 && (
                <div className={`border-t border-white/15 flex flex-col leading-tight ${compact ? 'mt-0.5 pt-0.5 gap-0' : 'mt-1 pt-1 gap-0.5'}`}>
                  {hoverMAs.map(m => (
                    <div key={m.name} className={`flex items-baseline justify-between ${compact ? 'gap-2' : 'gap-4'}`}>
                      <span style={{ color: m.color }}>{m.name}</span>
                      <span className="tabular-nums" style={{ color: m.color }}>{Math.round(m.value as number).toLocaleString('ko-KR')}</span>
                    </div>
                  ))}
                </div>
              )}
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
          {/* 호버 가격 태그 — HTS 식, 십자선 높이의 가격을 강조 박스로 */}
          {hoverY != null && hoverPrice != null && (
            <g>
              <rect x={0} y={hoverY - 8} width={padRight} height={16} fill={FG} rx={2} />
              <text x={4} y={hoverY} fill="#fff" fontSize="10" textAnchor="start" dominantBaseline="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif" className="tabular-nums">{Math.round(hoverPrice).toLocaleString('ko-KR')}</text>
            </g>
          )}
        </svg>
      </div>
      </div>

      {/* 거래량 차트 — 가격과 가로 스크롤 동기화 (width=W + overflow-hidden, price onScroll 이 scrollLeft 맞춤). 우측 padRight 거터로 거래량축 분리.
          close-only 데이터는 거래량이 전무(0 폴백)라 pane 자체를 숨김. */}
      {!closeOnly && (
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
            // 상단 라벨(maxV)은 y≈4 라 middle baseline 시 윗부분이 viewBox 위로 잘림 → 최소 y 클램프.
            <text key={'va' + t} x={4} y={Math.max(7, yVol(t))} fill={MUTED} fontSize="9" textAnchor="start" dominantBaseline="middle" fontFamily="'Pretendard Variable', Pretendard, sans-serif">{compactKorean(t)}</text>
          ))}
        </svg>
      </div>
      </div>
      )}

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
