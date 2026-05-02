'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import StockChart from '../../admin/chat-components/StockChart';
import { useViewportMaxHeight } from '../../../lib/use-viewport-size';

// ── 타입 ────────────────────────────────────────────────────────────────────
interface ComponentDef {
  type: string;
  props?: Record<string, any>;
}

interface ComponentRendererProps {
  components: ComponentDef[];
}

// ── Component 렌더러 ───────────────────────────────────────────────────────
export function ComponentRenderer({ components, fullHeight }: ComponentRendererProps & { fullHeight?: boolean }) {
  return (
    <div className={fullHeight ? 'h-full' : 'flex flex-col gap-6'}>
      {components.map((comp, i) => (
        <ComponentSwitch key={i} comp={comp} />
      ))}
    </div>
  );
}

// 소문자·snake_case → PascalCase 정규화 (AI 가 잘못된 형식으로 보내도 관용)
const TYPE_ALIAS: Record<string, string> = {
  metric: 'Metric', timeline: 'Timeline', compare: 'Compare', key_value: 'KeyValue', keyvalue: 'KeyValue',
  status_badge: 'StatusBadge', statusbadge: 'StatusBadge', plan_card: 'PlanCard', plancard: 'PlanCard',
  stock_chart: 'StockChart', stockchart: 'StockChart', header: 'Header', text: 'Text', image: 'Image',
  form: 'Form', button: 'Button', divider: 'Divider', table: 'Table', card: 'Card', grid: 'Grid',
  html: 'Html', slider: 'Slider', tabs: 'Tabs', accordion: 'Accordion', progress: 'Progress',
  badge: 'Badge', alert: 'Alert', callout: 'Callout', list: 'List', carousel: 'Carousel',
  countdown: 'Countdown', chart: 'Chart', ad_slot: 'AdSlot', adslot: 'AdSlot',
};

function ComponentSwitch({ comp }: { comp: ComponentDef }) {
  const { type: rawType, props = {} } = comp;
  const p = props as any;
  const type = TYPE_ALIAS[(rawType || '').toLowerCase()] ?? rawType;

  switch (type) {
    case 'Header':        return <HeaderComp text={p.text ?? ''} level={p.level} align={p.align} />;
    case 'Text':          return <TextComp content={p.content ?? ''} />;
    case 'Image':         return <ImageComp src={p.src ?? ''} alt={p.alt} width={p.width} height={p.height} variants={p.variants} blurhash={p.blurhash} thumbnailUrl={p.thumbnailUrl} />;
    case 'Form':          return <FormComp bindModule={p.bindModule} inputs={p.inputs ?? []} submitText={p.submitText} />;
    case 'ResultDisplay': return null;
    case 'Button':        return <ButtonComp text={p.text ?? ''} href={p.href} variant={p.variant} />;
    case 'Divider':       return <DividerComp />;
    case 'Table':         return <TableComp headers={p.headers ?? []} rows={p.rows ?? []} stickyCol={p.stickyCol} striped={p.striped} align={p.align} cellAlign={p.cellAlign} />;
    case 'Card':          return <CardComp children={p.children ?? []} align={p.align} image={p.image} footer={p.footer} link={p.link} />;
    case 'Grid':          return <GridComp columns={p.columns} children={p.children ?? []} align={p.align} />;
    case 'AdSlot':        return <AdSlotComp slotId={p.slotId} format={p.format} />;
    case 'Html':          return <HtmlComp content={p.content ?? ''} dependencies={p.dependencies as string[] | undefined} />;
    case 'Slider':        return <SliderComp label={p.label} min={p.min} max={p.max} step={p.step} defaultValue={p.defaultValue} unit={p.unit} />;
    case 'Tabs':          return <TabsComp tabs={p.tabs ?? []} />;
    case 'Accordion':     return <AccordionComp items={p.items ?? []} />;
    case 'Progress':      return <ProgressComp value={p.value ?? 0} max={p.max} label={p.label} color={p.color} />;
    case 'Badge':         return <BadgeComp text={p.text ?? ''} color={p.color} />;
    case 'Alert':         return <AlertComp message={p.message ?? ''} type={p.type} title={p.title} action={p.action} />;
    case 'Callout':       return <AlertComp message={p.message ?? ''} type={p.type ?? 'info'} title={p.title} action={p.action} />;
    case 'List':          return <ListComp items={p.items ?? []} ordered={p.ordered} />;
    case 'Carousel':      return <CarouselComp children={p.children ?? []} autoPlay={p.autoPlay} interval={p.interval} />;
    case 'Countdown':     return <CountdownComp targetDate={p.targetDate ?? ''} label={p.label} />;
    case 'Chart':         return <ChartComp type={p.chartType ?? 'bar'} data={p.data ?? []} labels={p.labels ?? []} title={p.title} subtitle={p.subtitle} unit={p.unit} color={p.color} negColor={p.negColor} palette={p.palette} showValues={p.showValues} showPct={p.showPct} />;
    case 'StockChart':    return <StockChart symbol={p.symbol ?? ''} title={p.title} data={p.data ?? []} indicators={p.indicators} buyPoints={p.buyPoints} sellPoints={p.sellPoints} />;
    case 'Metric':        return <MetricComp label={p.label ?? ''} value={p.value ?? ''} unit={p.unit} delta={p.delta} deltaType={p.deltaType} subLabel={p.subLabel} icon={p.icon} link={p.link} align={p.align} labelAlign={p.labelAlign} valueAlign={p.valueAlign} deltaAlign={p.deltaAlign} subLabelAlign={p.subLabelAlign} />;
    case 'Timeline':      return <TimelineComp items={p.items ?? []} />;
    case 'Compare':       return <CompareComp title={p.title} left={p.left ?? { label: 'A', items: [] }} right={p.right ?? { label: 'B', items: [] }} />;
    case 'KeyValue':      return <KeyValueComp title={p.title} items={p.items ?? []} columns={p.columns} />;
    case 'StatusBadge':   return <StatusBadgeComp items={p.items ?? []} />;
    case 'PlanCard':      return <PlanCardComp title={p.title ?? ''} steps={p.steps ?? []} estimatedTime={p.estimatedTime} risks={p.risks} />;
    case 'Map':           return <MapComp markers={p.markers ?? []} circles={p.circles} legend={p.legend} center={p.center} zoom={p.zoom} height={p.height} provider={p.provider} />;
    case 'Diagram':       return <DiagramComp code={p.code ?? ''} theme={p.theme} />;
    case 'Math':          return <MathComp expression={p.expression ?? ''} block={p.block !== false} />;
    case 'Code':          return <CodeComp code={p.code ?? ''} language={p.language ?? 'plaintext'} showLineNumbers={p.showLineNumbers !== false} title={p.title} />;
    case 'Slideshow':     return <SlideshowComp images={p.images ?? []} autoplay={p.autoplay} autoplayDelay={p.autoplayDelay} height={p.height} />;
    case 'Lottie':        return <LottieComp src={p.src ?? ''} loop={p.loop !== false} autoplay={p.autoplay !== false} height={p.height} />;
    case 'Network':       return <NetworkComp nodes={p.nodes ?? []} edges={p.edges ?? []} layout={p.layout} height={p.height} />;
    default:
      // 알 수 없는 component type 은 silent skip — '지원되지 않는' 노란 박스 표시하지 않음
      // (개발자는 console 에서 확인 가능)
      if (typeof console !== 'undefined') console.warn('[ComponentSwitch] 알 수 없는 컴포넌트 type:', type, comp);
      return null;
  }
}

// ── Header ──────────────────────────────────────────────────────────────────
function HeaderComp({ text, level = 1, align }: { text: string; level?: number; align?: 'left' | 'right' | 'center' }) {
  const clampedLevel = Math.min(Math.max(level, 1), 6);
  const sizes: Record<number, string> = {
    1: 'text-3xl sm:text-4xl font-extrabold',
    2: 'text-2xl sm:text-3xl font-bold',
    3: 'text-xl sm:text-2xl font-bold',
    4: 'text-lg sm:text-xl font-semibold',
    5: 'text-base font-semibold',
    6: 'text-sm font-semibold',
  };
  const alignCls = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : '';
  const cls = `${sizes[clampedLevel] ?? sizes[1]} text-gray-900 leading-tight ${alignCls}`;
  const clean = cleanPlainText(text);
  if (clampedLevel === 1) return <h1 className={cls}>{clean}</h1>;
  if (clampedLevel === 2) return <h2 className={cls}>{clean}</h2>;
  if (clampedLevel === 3) return <h3 className={cls}>{clean}</h3>;
  if (clampedLevel === 4) return <h4 className={cls}>{clean}</h4>;
  if (clampedLevel === 5) return <h5 className={cls}>{clean}</h5>;
  return <h6 className={cls}>{clean}</h6>;
}

// ── Text ────────────────────────────────────────────────────────────────────
/** 문자열 내 literal "\n" / "\t" 이스케이프를 실제 개행·탭으로 치환.
 *  AI 가 JSON 에 개행 넣을 때 가끔 "\\n" (literal backslash-n) 로 직렬화해서 오는 경우 대응. */
function normalizeEscapes(s: string): string {
  if (!s || typeof s !== 'string') return s;
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/** Plain-text 필드(label/value/subLabel 등) HTML·마크다운 마커 제거와 숫자 콤마 포맷은
 *  백엔드 `core/utils/sanitize.ts` 의 sanitizeBlock 에서 일괄 처리됨 — 프론트는 받은 값 그대로 렌더.
 *
 *  아래 두 헬퍼는 null/undefined → '' 코어션 용도로만 남김 (이전 호출부 40+ 유지).
 *  실제 정제·포맷 로직 없음. */
function cleanPlainText(s: string | number | null | undefined): string {
  return s == null ? '' : String(s);
}

/** display-time 값 변환 — AI 가 이미 포맷팅한 값을 그대로 렌더.
 *  숫자 콤마·연도·전화번호 구분은 AI 책임 (context 판단 정확도 높음).
 *  number 타입은 "금액 맥락일 가능성 높음" 가정으로 toLocaleString 유지 — 연도는 보통 string. */
function formatNumberString(v: string | number | null | undefined): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString('ko-KR');
  return String(v);
}

function TextComp({ content }: { content: string }) {
  const normalized = normalizeEscapes(content);
  return (
    <div className="text-gray-700 text-base sm:text-lg leading-relaxed prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalized}</ReactMarkdown>
    </div>
  );
}

// ── Image ───────────────────────────────────────────────────────────────────
// <picture> + AVIF/WebP srcset + blurhash placeholder
// 반응형: 부모 폭(대화창·페이지) 기준 max-w-full, 세로로 너무 길면 max-h-[70vh] 로 제한.
// figure 는 w-fit 으로 실제 이미지 렌더 너비에 딱 맞춰 — 오른쪽 흰 여백 방지.
// object-contain: 비율 유지 (crop 금지). width/height attribute 는 CLS 방지 hint.
// blurhash: 로딩 중 <canvas> 로 블러 프레임 표시 → 이미지 로드되면 페이드인.
interface ImageVariantProp {
  width: number;
  height?: number;
  format: string;
  url: string;
  bytes?: number;
}
function ImageComp({
  src, alt = '', width, height, variants, blurhash, thumbnailUrl,
}: {
  src: string; alt?: string; width?: number; height?: number;
  variants?: ImageVariantProp[]; blurhash?: string; thumbnailUrl?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  // blurhash decode — 마운트 시 1회. 서버/클라 분리 위해 dynamic import
  useEffect(() => {
    if (!blurhash || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const { decode } = await import('blurhash');
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const W = 32, H = 32;
        const pixels = decode(blurhash, W, H);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const imageData = ctx.createImageData(W, H);
        imageData.data.set(pixels);
        ctx.putImageData(imageData, 0, 0);
      } catch { /* blurhash 실패는 조용히 — 원본 이미지 로드는 계속 */ }
    })();
    return () => { cancelled = true; };
  }, [blurhash]);

  // variants 를 포맷별 srcset 으로 그룹핑
  const srcsetFor = (fmt: string) => {
    if (!variants || variants.length === 0) return '';
    return variants
      .filter(v => v.format === fmt && v.width > 0)
      .sort((a, b) => a.width - b.width)
      .map(v => `${v.url} ${v.width}w`)
      .join(', ');
  };
  const avifSrcset = srcsetFor('avif');
  const webpSrcset = srcsetFor('webp');
  const sizes = '(max-width: 640px) 100vw, (max-width: 1024px) 80vw, 1024px';
  const hasVariants = Boolean(avifSrcset || webpSrcset);

  return (
    <figure className="rounded-xl overflow-hidden shadow-sm border border-gray-100 w-fit max-w-full">
      <div className="relative">
        {/* blurhash 캔버스 — 이미지 로드 전까지만 보임 */}
        {blurhash && !loaded && (
          <canvas
            ref={canvasRef}
            width={32}
            height={32}
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover blur-sm scale-110"
            style={{ filter: 'blur(8px)' }}
          />
        )}
        {hasVariants ? (
          <picture>
            {avifSrcset && <source type="image/avif" srcSet={avifSrcset} sizes={sizes} />}
            {webpSrcset && <source type="image/webp" srcSet={webpSrcset} sizes={sizes} />}
            <img
              src={src}
              alt={alt}
              width={width}
              height={height}
              onLoad={() => setLoaded(true)}
              className={`block relative max-w-full max-h-[70vh] h-auto object-contain transition-opacity duration-300 ${loaded || !blurhash ? 'opacity-100' : 'opacity-0'}`}
              loading="lazy"
              decoding="async"
            />
          </picture>
        ) : (
          <img
            src={src}
            alt={alt}
            width={width}
            height={height}
            onLoad={() => setLoaded(true)}
            className={`block relative max-w-full max-h-[70vh] h-auto object-contain transition-opacity duration-300 ${loaded || !blurhash ? 'opacity-100' : 'opacity-0'}`}
            loading="lazy"
            decoding="async"
          />
        )}
      </div>
      {alt && <figcaption className="text-sm text-gray-500 px-4 py-2 bg-gray-50">{alt}</figcaption>}
    </figure>
  );
}

// ── Form (+ 인라인 ResultDisplay) ───────────────────────────────────────────
function FormComp({ bindModule, inputs = [], submitText = '실행' }: {
  bindModule?: string;
  inputs: { name: string; label: string; type?: string; required?: boolean; placeholder?: string }[];
  submitText?: string;
}) {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback((name: string, value: string) => {
    setFormData(prev => ({ ...prev, [name]: value }));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bindModule) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const payload: Record<string, any> = {};
      for (const input of inputs) {
        const val = formData[input.name] ?? '';
        if (input.type === 'number') payload[input.name] = parseFloat(val) || 0;
        else payload[input.name] = val;
      }

      const res = await fetch('/api/module/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: bindModule, data: payload }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setResult(data.data?.data ?? data.data);
      } else {
        setError(data.error ?? '실행 실패');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [bindModule, formData, inputs]);

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="bg-white border border-gray-100 rounded-xl p-6 shadow-sm space-y-4">
        {inputs.map(input => (
          <div key={input.name} className="flex flex-col gap-1.5">
            <label htmlFor={`f-${input.name}`} className="text-sm font-semibold text-gray-700">
              {input.label}{input.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
            <input
              id={`f-${input.name}`}
              type={input.type ?? 'text'}
              required={input.required}
              placeholder={input.placeholder ?? ''}
              value={formData[input.name] ?? ''}
              onChange={e => handleChange(input.name, e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-800 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
            />
          </div>
        ))}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-bold rounded-xl transition-colors shadow-sm text-base"
        >
          {loading ? '처리 중...' : submitText}
        </button>
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-sm">
          {error}
        </div>
      )}
      {result && (
        <div className="bg-green-50 border border-green-200 p-5 rounded-xl">
          {typeof result === 'object' ? (
            <div className="space-y-2">
              {Object.entries(result).map(([key, val]) => (
                <div key={key} className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-gray-600 min-w-[80px]">{key}:</span>
                  <span className="text-base font-bold text-gray-900">{String(val)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-base font-bold text-gray-900">{String(result)}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Button ──────────────────────────────────────────────────────────────────
function ButtonComp({ text, href, variant = 'primary' }: { text: string; href?: string; variant?: string }) {
  const base = 'inline-flex items-center justify-center px-6 py-3 rounded-xl font-bold text-base transition-all shadow-sm';
  const styles: Record<string, string> = {
    primary: `${base} bg-blue-600 hover:bg-blue-700 text-white`,
    secondary: `${base} bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-200`,
    outline: `${base} bg-white hover:bg-gray-50 text-blue-600 border-2 border-blue-600`,
  };
  const cls = styles[variant] ?? styles.primary;

  if (href) {
    return <a href={href} className={cls}>{text}</a>;
  }
  return <button className={cls}>{text}</button>;
}

// ── Divider ─────────────────────────────────────────────────────────────────
function DividerComp() {
  return <hr className="border-gray-200 my-2" />;
}

// ── Table ───────────────────────────────────────────────────────────────────
type AlignOpt = 'left' | 'right' | 'center';
function TableComp({ headers = [], rows = [], stickyCol, striped, align, cellAlign }: {
  headers: string[]; rows: string[][]; stickyCol?: boolean;
  /** zebra 행 — 짝수 row 배경 살짝 어둡게. 행 많을 때 가독성 ↑. 기본 false. */
  striped?: boolean;
  /** 컬럼별 정렬 — AI 명시 가능. 미지정 시 자동(숫자 컬럼→우측, 그 외→좌측). */
  align?: (AlignOpt | null | undefined)[];
  /** 셀별 정렬 override — cellAlign[ri][ci]. 특정 행·셀만 따로 조절할 때 사용. */
  cellAlign?: ((AlignOpt | null | undefined)[] | null | undefined)[];
}) {
  // 헤더 행은 항상 sticky (세로 스크롤 시)
  // stickyCol: 미지정 시 4열 이상이면 자동 활성 (첫 열 = 행 라벨 추정)
  const firstColSticky = stickyCol ?? (headers.length >= 4);

  // viewport quirk 우회 — MUI/Antd 표준 (400px 캡) + 작은 폰만 50% 비율 보호. 데스크톱 70%.
  const maxHeightPx = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 400 });

  /** 정렬: AI 가 align 배열로 명시한 값만 사용. 미지정 시 column 전체 left (cells), center (header).
   *  per-cell 자동 감지 제거 — column 안에서 cell 마다 정렬 다르게 보이는 문제 차단. */
  const alignClass = (ci: number, ri?: number) => {
    // 셀별 override (최우선) — AI 가 명시한 경우만
    if (ri != null) {
      const cellExplicit = cellAlign?.[ri]?.[ci];
      if (cellExplicit === 'left') return 'text-left';
      if (cellExplicit === 'right') return 'text-right tabular-nums';
      if (cellExplicit === 'center') return 'text-center';
    }
    // 컬럼 명시
    const explicit = align?.[ci];
    if (explicit === 'left') return 'text-left';
    if (explicit === 'right') return 'text-right tabular-nums';
    if (explicit === 'center') return 'text-center';
    // 미지정: 좌측 (column 안 일관성 유지)
    return 'text-left';
  };

  /** 헤더 정책: 명시값 우선, 그 외 짧으면(≤20자) 가운데, 길면 좌측. */
  const headerAlignClass = (ci: number, headerText: string) => {
    const explicit = align?.[ci];
    if (explicit === 'left') return 'text-left';
    if (explicit === 'right') return 'text-right tabular-nums';
    if (explicit === 'center') return 'text-center';
    const len = (headerText || '').trim().length;
    if (len > 20) return 'text-left';
    return 'text-center';
  };

  return (
    // 박스 max-height = JS 측정 픽셀 (toolbar 변동 무관). SSR fallback = 70vh.
    // overscroll-behavior 글로벌 미지정 = default auto → 끝 도달 시 페이지 chain 자연.
    <div
      className="overflow-auto rounded-xl border border-gray-100 shadow-sm scrollbar-thin"
      style={{ maxHeight: maxHeightPx ? `${maxHeightPx}px` : '70vh' }}
    >
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {headers.map((h, i) => {
              const isStickyCell = firstColSticky && i === 0;
              const headerText = cleanPlainText(h);
              return (
                <th
                  key={i}
                  // border-b 한 줄만 — 이전엔 thead.bg + th.bg + th.border-b + 첫 td.border-b 가
                  // 시각적으로 두 줄처럼 보이던 buf. bg 는 th 만 명시 (thead 의 bg 제거).
                  className={`px-4 py-3 text-[13px] font-bold text-gray-600 uppercase tracking-wider border-b border-gray-100 bg-gray-50 sticky top-0 min-w-[120px] ${headerAlignClass(i, headerText)} ${isStickyCell ? 'left-0 z-20 shadow-[2px_0_0_0_#f3f4f6]' : 'z-10'}`}
                >
                  {headerText}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className={`hover:bg-gray-50 transition-colors ${striped && ri % 2 === 1 ? 'bg-gray-50/40' : ''}`}
            >
              {row.map((cell, ci) => {
                const isStickyCell = firstColSticky && ci === 0;
                const s = typeof cell === 'string' ? cell.trim() : String(cell);
                // 색상만 유지 — ▲▼ 패턴 (등락 시각화). 정렬은 column 단위 AI 명시.
                const isPositive = /^[▲+]/.test(s);
                const isNegative = /^[▼\-−]/.test(s);
                const numClass = isPositive ? 'text-red-600 font-semibold' : isNegative ? 'text-blue-600 font-semibold' : '';
                const displayCell = formatNumberString(cell);
                return (
                  <td
                    key={ci}
                    className={`px-4 py-3 text-[13px] border-b border-gray-100 align-top min-w-[120px] break-words ${alignClass(ci, ri)} ${isStickyCell ? 'sticky left-0 z-10 bg-white shadow-[2px_0_0_0_#f3f4f6] font-semibold whitespace-nowrap text-gray-800' : numClass || 'text-gray-800'}`}
                  >
                    {displayCell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────
function CardComp({ children = [], align, image, footer, link }: {
  children: ComponentDef[];
  align?: AlignOpt;
  /** 카드 상단 이미지 (선택). src + alt. magazine·card 변형 케이스. */
  image?: { src?: string; alt?: string };
  /** 카드 하단 텍스트·메타 (선택). 작성일·읽는시간 등. */
  footer?: string;
  /** 카드 전체 클릭 link (선택). */
  link?: { href?: string };
}) {
  const alignCls = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : '';
  const cardCls = `bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden ${alignCls} ${link?.href ? 'hover:shadow-md hover:border-gray-200 transition-all cursor-pointer no-underline block' : ''}`;
  const inner = (
    <>
      {image?.src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image.src} alt={image.alt ?? ''} className="w-full h-48 object-cover" />
      )}
      <div className="p-6">
        <ComponentRenderer components={children} />
        {footer && (
          <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
            {cleanPlainText(footer)}
          </div>
        )}
      </div>
    </>
  );
  if (link?.href) {
    return <a href={link.href} className={cardCls}>{inner}</a>;
  }
  return <div className={cardCls}>{inner}</div>;
}

// ── Grid ────────────────────────────────────────────────────────────────────
function GridComp({ columns = 2, children = [], align }: { columns?: number; children: ComponentDef[]; align?: AlignOpt }) {
  // 모바일 baseline 2개 — Metric 카드 8개 같은 케이스에서 한 줄 1개씩 길게 늘어지는 거 방지.
  // 좁은 화면(< 768px)에서 2개, 태블릿(md, 768+)부터 3개, PC(lg, 1024+)에서 지정 columns.
  const gridCls: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  };
  const alignCls = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : '';
  return (
    <div className={`grid ${gridCls[columns] ?? gridCls[2]} gap-4 ${alignCls}`}>
      {children.map((comp, i) => (
        <ComponentSwitch key={i} comp={comp} />
      ))}
    </div>
  );
}

// ── AdSlot ──────────────────────────────────────────────────────────────────
function AdSlotComp({ slotId, format = 'auto' }: { slotId?: string; format?: string }) {
  if (!slotId) return null;
  return (
    <div className="flex items-center justify-center py-4">
      <ins
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-slot={slotId}
        data-ad-format={format}
        data-full-width-responsive="true"
      />
    </div>
  );
}

// ── Html (분기: dependencies 유무로 inline DOM vs iframe srcDoc) ─────────────
import { buildCdnTags, IFRAME_CSP_META } from '../../../lib/cdn-libraries';
import DOMPurify from 'isomorphic-dompurify';
import postcss from 'postcss';
import prefixer from 'postcss-prefix-selector';

/** sanitize 허용 정책 — 페이지 본문 inline DOM 용.
 *  DOMPurify v3 가 보안 default 로 <style> 태그 자체 차단해 ALLOWED_TAGS 명시해도 제거.
 *  → style 태그를 본문에서 별도 추출 → CSS 위험 패턴 (expression/javascript:/behavior:/@import)
 *  검사 후 통과하면 그대로 prepend, body 부분만 DOMPurify 통과.
 *  AI 생성 본문이 admin 만 작성 가능하지만 sanitize 로 defense-in-depth. */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    // 텍스트·구조
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup',
    'code', 'pre', 'blockquote', 'kbd', 'samp', 'q', 'cite',
    // 시맨틱
    'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption',
    'details', 'summary', 'time', 'address',
    // 표
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    // 리스트
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // 링크·미디어
    'a', 'img', 'picture', 'source',
  ],
  ALLOWED_ATTR: [
    'class', 'id', 'style', 'lang', 'dir', 'title',
    'href', 'target', 'rel',
    'src', 'alt', 'width', 'height', 'srcset', 'sizes', 'loading',
    'colspan', 'rowspan', 'scope', 'headers',
    'datetime',
  ],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#|data:image\/)/i,
};

/** CSS 위험 패턴 — XSS·외부 추적·광고 fraud 차단. */
const CSS_DANGER_RE = /(?:expression\s*\(|javascript\s*:|behavior\s*:|@import\s|url\s*\(\s*['"]?\s*javascript:)/i;

/** AI 가 박은 style 의 selector 를 wrapper class scope 로 한정.
 *  `body { ... }` 같은 page-level selector 가 사이트 root 영향 주지 못하게 prefix.
 *  body/html 자체는 wrapper class 로 대체, 그 외는 wrapper 안 nested. */
const SCOPE_CLASS = '.firebat-html-block';
function scopeStyleCss(css: string): string {
  try {
    const result = postcss()
      .use(prefixer({
        prefix: SCOPE_CLASS,
        transform(prefix, selector) {
          // body / html selector 자체는 wrapper class 로 대체.
          if (selector === 'body' || selector === 'html') return prefix;
          // body / html 로 시작하는 복합 selector 는 prefix 부분만 대체 (예: body > h1 → wrapper > h1)
          if (selector.startsWith('body ')) return prefix + selector.slice(4);
          if (selector.startsWith('html ')) return prefix + selector.slice(4);
          if (selector.startsWith('body>')) return prefix + ' ' + selector.slice(5);
          if (selector.startsWith('html>')) return prefix + ' ' + selector.slice(5);
          if (selector.startsWith(':root')) return prefix + selector.slice(5);
          // 이미 wrapper class 로 시작하는 selector (idempotent) 그대로
          if (selector.startsWith(prefix)) return selector;
          // 그 외 — prefix nested
          return `${prefix} ${selector}`;
        },
      }))
      .process(css, { from: undefined })
      .css;
    return result;
  } catch {
    // CSS 파싱 실패 — 원본 그대로 반환 (사용자 페이지 깨지지 않게 graceful fallback).
    return css;
  }
}

/** style 태그 별도 추출 + 위험 CSS 차단 + selector scope 한정 + body 만 DOMPurify. */
function sanitizeHtmlBlock(content: string): string {
  const styleTags: string[] = [];
  // 1) <style>...</style> 추출 (다중 + 속성 모두 매칭). 위험 CSS 만 제거. scope 한정.
  const bodyHtml = content.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
    if (CSS_DANGER_RE.test(css)) return '';
    const scoped = scopeStyleCss(css);
    styleTags.push(`<style>${scoped}</style>`);
    return '';
  });
  // 2) body 부분만 sanitize (style 태그 없음 → DOMPurify 정상 처리)
  const sanitizedBody = DOMPurify.sanitize(bodyHtml, SANITIZE_CONFIG);
  // 3) style 태그 prepend
  return styleTags.join('') + sanitizedBody;
}

function HtmlComp({ content, dependencies }: { content: string; dependencies?: string[] }) {
  // 분기 — dependencies 있으면 iframe srcDoc 격리 (Leaflet/Mermaid 등 CDN library 시각화).
  //        없으면 sanitize 후 inline DOM (광고 게재·SEO 인덱싱 정상).
  const hasDeps = !!(dependencies && dependencies.length > 0);

  if (!hasDeps) {
    // inline DOM — sanitize 후 직접 박음.
    // wrapper class 로 scope 한정 — AI 가 박은 <style> 안 body/html selector 가 페이지 root 영향 주지 않게.
    // 광고·SEO 인덱싱 정상 + iframe height squeeze 문제 자연 해결.
    const sanitized = sanitizeHtmlBlock(content);
    return (
      <div
        className="firebat-html-block max-w-none"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  // CDN library 격리 필요 케이스 — iframe srcDoc 유지.
  const cdnTags = buildCdnTags(dependencies);
  // AI 가 자체 body{margin:0; max-width:none} 같은 style 로 default 깨는 패턴 자주.
  // outer wrapper div 로 max-width 강제 — AI 가 어떻게 body style 짜도 layout 영향 X.
  // CSP meta — sandbox=allow-scripts 위에 defense-in-depth: script src 화이트리스트 + frame/form/base 차단.
  const srcdoc = `<!DOCTYPE html>
<html><head>
${IFRAME_CSP_META}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
${cdnTags}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; min-height: 100%; overflow: auto; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 15px; line-height: 1.6; color: #1e293b;
  }
  #firebat-wrap { max-width: 1024px; margin: 0 auto; padding: 24px 16px; }
  img, video { max-width: 100%; height: auto; }

  /* AI 가 raw HTML 박을 때 mobile 안전망 — design tokens 도입 전 임시 fix.
     AI 의 inline style·class 가 박아둔 4-grid · width 고정 등을 강제 override.
     향후 design tokens + component-based 전환 시 이 블록 자연 deprecation. */
  @media (max-width: 640px) {
    /* mobile padding 16px — 텍스트 들여쓰기 충분, AI body padding 의 자연 크기. table 은 negative margin 으로 끝까지 */
    #firebat-wrap { padding: 0 !important; max-width: 100% !important; }
    body { padding: 16px !important; max-width: 100% !important; }

    h1 { font-size: 22px !important; }
    h2 { font-size: 18px !important; }
    h3 { font-size: 16px !important; }

    /* 표 — full-bleed 패턴 (어느 nested level 이든 화면 정확히 끝까지) */
    table {
      display: block !important;
      overflow-x: auto !important;
      width: 100vw !important;
      max-width: 100vw !important;
      position: relative !important;
      left: 50% !important;
      right: 50% !important;
      margin-left: -50vw !important;
      margin-right: -50vw !important;
      font-size: 12px !important;
      -webkit-overflow-scrolling: touch;
    }
    th, td { padding: 4px 6px !important; white-space: nowrap; }

    /* grid (KPI 카드 등) 자동 fallback — class="grid" 단독 / class*='grid-cols' / inline style / kpi 모두 매칭 */
    [style*='grid-template-columns'],
    [class~='grid'],
    [class*='grid-cols'],
    [class*='kpi'] {
      grid-template-columns: repeat(3, 1fr) !important;
      gap: 6px !important;
    }
    /* 카드 padding·폰트 축소 — 3개 한 줄도 들어가게 */
    [class~='card'], [class*='kpi-card'] { padding: 8px !important; }
    [class~='card'] .value, [class*='kpi-card'] .value, .card .value { font-size: 15px !important; }
    [class~='card'] .label, [class*='kpi-card'] .label, .card .label { font-size: 11px !important; }
  }
  /* 더 좁은 화면 — 3개 빡빡하면 2개로 fallback */
  @media (max-width: 380px) {
    [style*='grid-template-columns'],
    [class~='grid'],
    [class*='grid-cols'],
    [class*='kpi'] {
      grid-template-columns: repeat(2, 1fr) !important;
    }
  }
</style>
</head><body><div id="firebat-wrap">${content}</div></body></html>`;

  return (
    <iframe
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      className="w-full min-h-[500px] h-[500px] border-0 bg-white"
      title="Html content"
    />
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 새 컴포넌트
// ════════════════════════════════════════════════════════════════════════════

// ── Slider ──────────────────────────────────────────────────────────────────
function SliderComp({ label, min = 0, max = 100, step = 1, defaultValue, unit = '' }: {
  label?: string; min?: number; max?: number; step?: number; defaultValue?: number; unit?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? min);
  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">{label}</span>
          <span className="text-sm font-bold text-blue-600">{value}{unit}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => setValue(Number(e.target.value))}
        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
      />
      {!label && <div className="text-right text-sm font-bold text-blue-600">{value}{unit}</div>}
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function TabsComp({ tabs }: { tabs: { label: string; children: ComponentDef[] }[] }) {
  const [active, setActive] = useState(0);
  if (tabs.length === 0) return null;

  return (
    <div>
      <div className="flex border-b border-gray-200 gap-1 overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors ${
              active === i
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-4">
        <ComponentRenderer components={tabs[active].children ?? []} />
      </div>
    </div>
  );
}

// ── Accordion ───────────────────────────────────────────────────────────────
function AccordionComp({ items }: { items: { title: string; children: ComponentDef[] }[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-200">
      {items.map((item, i) => (
        <div key={i}>
          <button
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
            className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            <span className="text-sm font-semibold text-gray-800">{item.title}</span>
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform ${openIndex === i ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {openIndex === i && (
            <div className="px-5 pb-4">
              <ComponentRenderer components={item.children ?? []} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Progress ────────────────────────────────────────────────────────────────
function ProgressComp({ value, max = 100, label, color = 'blue' }: {
  value: number; max?: number; label?: string; color?: string;
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const colors: Record<string, string> = {
    blue: 'bg-blue-500', green: 'bg-green-500', red: 'bg-red-500',
    yellow: 'bg-yellow-500', purple: 'bg-purple-500', orange: 'bg-orange-500',
  };
  const barColor = colors[color] ?? colors.blue;

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">{cleanPlainText(label)}</span>
          <span className="text-sm font-bold text-gray-500">{Math.round(pct)}%</span>
        </div>
      )}
      <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────
function BadgeComp({ text, color = 'blue' }: { text: string; color?: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    purple: 'bg-purple-100 text-purple-700',
    gray: 'bg-gray-100 text-gray-700',
    orange: 'bg-orange-100 text-orange-700',
  };
  const cls = colors[color] ?? colors.blue;

  return (
    <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${cls}`}>
      {cleanPlainText(text)}
    </span>
  );
}

// ── Alert ───────────────────────────────────────────────────────────────────
// Alert/Callout 내부에서만 쓰는 경량 마크다운 렌더러 — AI가 **bold**, 1./2. 목록, \n 줄바꿈 섞어 보내는 경우 대응
const alertMdComponents = {
  p: (props: any) => <p className="mb-1 last:mb-0" {...props} />,
  strong: (props: any) => <strong className="font-bold" {...props} />,
  em: (props: any) => <em className="italic" {...props} />,
  ul: (props: any) => <ul className="list-disc list-outside ml-5 space-y-0.5" {...props} />,
  ol: (props: any) => <ol className="list-decimal list-outside ml-5 space-y-0.5" {...props} />,
  li: (props: any) => <li {...props} />,
  code: (props: any) => <code className="px-1 py-0.5 bg-black/10 rounded text-[12px] font-mono" {...props} />,
  a: (props: any) => <a className="underline" target="_blank" rel="noopener noreferrer" {...props} />,
  br: () => <br />,
};

function AlertComp({ message, type = 'info', title, action }: {
  message: string;
  type?: string;
  title?: string;
  /** CTA 버튼 — 박혀있으면 본문 아래에 link 버튼. label 없으면 미렌더. */
  action?: { label?: string; href?: string };
}) {
  const styles: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    info:    { bg: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-800',   icon: 'ℹ️' },
    success: { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-800',  icon: '✅' },
    warn:    { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-800',  icon: '⚠️' },
    warning: { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-800',  icon: '⚠️' },
    error:   { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-800',    icon: '❌' },
    danger:  { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-800',    icon: '❌' },
    tip:       { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-800', icon: '💡' },
    accent:    { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-800', icon: '🔥' },
    highlight: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800', icon: '⭐' },
    neutral:   { bg: 'bg-slate-50',  border: 'border-slate-200',  text: 'text-slate-700',  icon: '📎' },
  };
  const s = styles[type] ?? styles.info;

  const normTitle = title ? normalizeEscapes(title) : undefined;
  const normMessage = normalizeEscapes(message);
  return (
    <div className={`${s.bg} ${s.border} border rounded-xl p-4 flex gap-3`}>
      <span className="text-lg shrink-0">{s.icon}</span>
      <div className="min-w-0 flex-1">
        {normTitle && (
          <div className={`font-bold text-sm mb-1 ${s.text}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={alertMdComponents}>{normTitle}</ReactMarkdown>
          </div>
        )}
        <div className={`text-sm ${s.text} prose-sm break-words`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={alertMdComponents}>{normMessage}</ReactMarkdown>
        </div>
        {action?.label && action?.href && (
          <a
            href={action.href}
            className={`inline-block mt-2 px-3 py-1.5 text-xs font-bold rounded ${s.text} bg-white/60 hover:bg-white/90 transition-colors no-underline border ${s.border}`}
          >
            {action.label} →
          </a>
        )}
      </div>
    </div>
  );
}

// ── List ────────────────────────────────────────────────────────────────────
function ListComp({ items, ordered = false }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={`space-y-1.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} text-gray-700`}>
      {items.map((item, i) => (
        <li key={i} className="text-base leading-relaxed">{cleanPlainText(item)}</li>
      ))}
    </Tag>
  );
}

// ── Carousel ────────────────────────────────────────────────────────────────
function CarouselComp({ children, autoPlay = false, interval = 5000 }: {
  children: ComponentDef[]; autoPlay?: boolean; interval?: number;
}) {
  const [current, setCurrent] = useState(0);
  const total = children.length;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (autoPlay && total > 1) {
      timerRef.current = setInterval(() => setCurrent(prev => (prev + 1) % total), interval);
      return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }
  }, [autoPlay, interval, total]);

  if (total === 0) return null;

  const go = (dir: -1 | 1) => {
    setCurrent((current + dir + total) % total);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-xl border border-gray-200">
        <ComponentSwitch comp={children[current]} />
      </div>
      {total > 1 && (
        <>
          <button
            onClick={() => go(-1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 shadow flex items-center justify-center hover:bg-white transition-colors"
          >
            <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => go(1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 shadow flex items-center justify-center hover:bg-white transition-colors"
          >
            <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div className="flex justify-center gap-1.5 mt-3">
            {children.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={`w-2 h-2 rounded-full transition-colors ${i === current ? 'bg-blue-600' : 'bg-gray-300'}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Countdown ───────────────────────────────────────────────────────────────
function CountdownComp({ targetDate, label }: { targetDate: string; label?: string }) {
  const [remaining, setRemaining] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const update = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) { setExpired(true); return; }
      setRemaining({
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      });
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetDate]);

  if (expired) {
    return (
      <div className="text-center py-4">
        {label && <div className="text-sm text-gray-500 mb-2">{cleanPlainText(label)}</div>}
        <div className="text-xl font-bold text-gray-800">종료되었습니다</div>
      </div>
    );
  }

  const units = [
    { value: remaining.days, label: '일' },
    { value: remaining.hours, label: '시간' },
    { value: remaining.minutes, label: '분' },
    { value: remaining.seconds, label: '초' },
  ];

  return (
    <div className="text-center py-4">
      {label && <div className="text-sm text-gray-500 mb-3">{cleanPlainText(label)}</div>}
      <div className="flex justify-center gap-3">
        {units.map((u, i) => (
          <div key={i} className="flex flex-col items-center bg-gray-50 rounded-xl px-4 py-3 min-w-[60px] border border-gray-200">
            <span className="text-2xl sm:text-3xl font-extrabold text-gray-900 tabular-nums">
              {String(u.value).padStart(2, '0')}
            </span>
            <span className="text-xs text-gray-500 mt-1">{u.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Chart (SVG, 외부 라이브러리 없음) ──────────────────────────────────────
const COLOR_MAP: Record<string, { bar: string; hex: string }> = {
  blue:   { bar: 'bg-blue-500',   hex: '#3b82f6' },
  green:  { bar: 'bg-green-500',  hex: '#22c55e' },
  red:    { bar: 'bg-red-500',    hex: '#ef4444' },
  purple: { bar: 'bg-purple-500', hex: '#a855f7' },
  orange: { bar: 'bg-orange-500', hex: '#f97316' },
  teal:   { bar: 'bg-teal-500',   hex: '#14b8a6' },
  pink:   { bar: 'bg-pink-500',   hex: '#ec4899' },
  yellow: { bar: 'bg-yellow-500', hex: '#eab308' },
  slate:  { bar: 'bg-slate-500',  hex: '#64748b' },
};

const PALETTE_MAP: Record<string, string[]> = {
  default: ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#f97316', '#14b8a6', '#ec4899'],
  pastel:  ['#93c5fd', '#86efac', '#fde68a', '#fca5a5', '#d8b4fe', '#fdba74', '#5eead4', '#f9a8d4'],
  'mono-blue':  ['#1e3a8a', '#1d4ed8', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe'],
  'mono-green': ['#14532d', '#15803d', '#22c55e', '#4ade80', '#86efac', '#bbf7d0'],
  'red-green':  ['#ef4444', '#f87171', '#fca5a5', '#86efac', '#22c55e', '#15803d'],
  // earth — 갈색 계열만이면 세그먼트 구분 불가. 인접 슬롯 간 hue 간격 확보 (갈/녹/주황 교차).
  earth:        ['#b45309', '#166534', '#d97706', '#78350f', '#65a30d', '#f59e0b'],
};

function ChartComp({ type = 'bar', data, labels, title, subtitle, unit, color, negColor, palette, showValues = true, showPct = true }: {
  type: 'bar' | 'pie' | 'line' | 'doughnut';
  data: number[];
  labels: string[];
  title?: string;
  subtitle?: string;
  unit?: string;
  /** 양수 막대 색 — COLOR_MAP key (red/blue/orange/green 등). 단방향 mode 에선 모든 막대에 적용. */
  color?: string;
  /** 음수 막대 색 — 양방향 mode 에서만 사용. 미지정 시 기본 빨강(글로벌 자산 차트 패턴).
   *  한국 수급 차트 같이 한국 관습 (양수=빨강, 음수=파랑) 따르려면 AI 가 color='red' + negColor='blue' 명시. */
  negColor?: string;
  palette?: string;
  showValues?: boolean;
  /** pie/doughnut tooltip 에 자동 계산 pct 표시 여부 (기본 true). data 자체가 이미 퍼센트면 false 권장. */
  showPct?: boolean;
}) {
  if (data.length === 0) return null;
  const maxVal = Math.max(...data, 1);
  const minVal = Math.min(...data, 0);

  // line chart
  if (type === 'line') {
    return <LineChartInteractive data={data} labels={labels} title={title} unit={unit} minVal={minVal} maxVal={maxVal} />;
  }

  const barColor = (color && COLOR_MAP[color]) ? COLOR_MAP[color].bar : 'bg-blue-500';
  // 음수 막대 색 — default 빨강 (글로벌 자산 차트). 한국 수급 차트는 AI 가 negColor='blue' 명시.
  const negBarColor = (negColor && COLOR_MAP[negColor]) ? COLOR_MAP[negColor].bar : 'bg-red-500';
  const pieColors = PALETTE_MAP[palette ?? 'default'] ?? PALETTE_MAP.default;
  const fmtVal = (v: number) => {
    const base = Math.abs(v) >= 10000 ? v.toLocaleString('ko-KR') : v.toString();
    return unit ? `${base}${unit}` : base;
  };

  const titleBlock = (title || subtitle) && (
    <div className="space-y-0.5">
      {title && <div className="text-sm font-bold text-gray-800">{title}</div>}
      {subtitle && <div className="text-xs text-gray-500">{subtitle}</div>}
    </div>
  );

  if (type === 'pie' || type === 'doughnut') {
    const total = data.reduce((s, v) => s + v, 0) || 1;
    // 세그먼트 정보 사전 계산 — 호버 툴팁용
    const segments = data.map((v, i) => {
      const pct = (v / total) * 100;
      return { label: labels[i] ?? `#${i}`, value: v, pct, color: pieColors[i % pieColors.length] };
    });
    let cum = 0;
    const gradientParts = segments.map(seg => {
      const start = cum; cum += seg.pct;
      return `${seg.color} ${start}% ${cum}%`;
    });
    const gradient = `conic-gradient(${gradientParts.join(', ')})`;

    return <PieChartInteractive segments={segments} gradient={gradient} titleBlock={titleBlock} unit={unit} showPct={showPct} />;
  }

  // bar / line chart — hover 상세 툴팁 포함
  return <BarChartInteractive data={data} labels={labels} titleBlock={titleBlock} unit={unit} showValues={showValues} barColor={barColor} negBarColor={negBarColor} maxVal={maxVal} fmtVal={fmtVal} type={type} />;
}

function LineChartInteractive({ data, labels, title, unit, minVal, maxVal }: {
  data: number[]; labels: string[]; title?: string; unit?: string; minVal: number; maxVal: number;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [cursorPos, setCursorPos] = React.useState<{ x: number; y: number } | null>(null);
  const W = 720, H = 260, padL = 56, padR = 24, padT = 20, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const range = maxVal - minVal || 1;
  const yMin = minVal - range * 0.05;
  const yMax = maxVal + range * 0.05;
  const xs = data.map((_, i) => padL + (data.length <= 1 ? 0 : (i / (data.length - 1)) * plotW));
  const ys = data.map(v => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH);
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const area = `${path} L ${xs[xs.length - 1].toFixed(1)},${padT + plotH} L ${xs[0].toFixed(1)},${padT + plotH} Z`;
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yMin + (yMax - yMin) * (i / ticks));
  const xStep = Math.max(1, Math.floor(data.length / 6));
  const containerRef = React.useRef<HTMLDivElement>(null);

  // 가장 가까운 데이터 포인트 찾기 (SVG viewBox 좌표계 기준)
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let minDist = Infinity, idx = -1;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - relX);
      if (d < minDist) { minDist = d; idx = i; }
    }
    if (idx >= 0) setHovered(idx);
    setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div className="space-y-2">
      {title && <div className="text-sm font-bold text-gray-800">{title}</div>}
      <div
        ref={containerRef}
        className="relative"
        onMouseMove={handleMove}
        onMouseLeave={() => { setHovered(null); setCursorPos(null); }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
          <defs>
            <linearGradient id="line-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((t, i) => {
            const y = padT + plotH - (i / ticks) * plotH;
            return (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="2 3" />
                <text x={padL - 6} y={y} fill="#94a3b8" fontSize="10" textAnchor="end" dominantBaseline="middle">{Math.round(t).toLocaleString('ko-KR')}</text>
              </g>
            );
          })}
          <path d={area} fill="url(#line-grad)" />
          <path d={path} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {xs.map((x, i) => <circle key={i} cx={x} cy={ys[i]} r={hovered === i ? 5 : 3} fill="#3b82f6" />)}
          {data.map((_, i) => i % xStep === 0 || i === data.length - 1 ? (
            <text key={i} x={xs[i]} y={H - 8} fill="#94a3b8" fontSize="10" textAnchor="middle">{labels[i] ?? i}</text>
          ) : null)}
        </svg>
        {hovered != null && cursorPos && (
          <div
            className="absolute pointer-events-none bg-white/95 shadow-lg rounded-lg px-3 py-2 text-center border border-slate-200 z-10"
            style={{ left: cursorPos.x + 14, top: cursorPos.y + 14 }}
          >
            <div className="text-[11px] font-bold text-slate-800 whitespace-nowrap">{labels[hovered] ?? hovered}</div>
            <div className="text-[14px] font-extrabold text-slate-900">
              {data[hovered].toLocaleString('ko-KR')}{unit || ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BarChartInteractive({ data, labels, titleBlock, unit: _unit, showValues, barColor, negBarColor, maxVal, fmtVal, type: _type }: {
  data: number[]; labels: string[]; titleBlock: React.ReactNode; unit?: string; showValues: boolean;
  barColor: string; negBarColor: string; maxVal: number; fmtVal: (v: number) => string; type: 'bar' | 'line';
}) {
  // 툴팁 제거 (v0.1, 2026-04-22) — AI 가 잘못 넣은 데이터가 tooltip 의 derived 계산
  // (pct 등) 을 거치면서 증폭됨. showValues inline 값으로 충분.
  //
  // 음수 값 처리 (v0.1, 2026-04-29 v2) — 0 baseline 중앙 + 양수 오른쪽 / 음수 왼쪽 (financial chart 표준).
  //   데이터 모두 양수면 기존 단방향 (왼쪽→오른쪽), 음수 혼재면 양방향. 일반 로직 — 자동 감지.
  //   maxAbs 기준 비례 (트랙 절반 영역 활용). 음수 막대는 빨강 + 텍스트도 빨강.
  // 단위 중복 제거 (v0.1, 2026-04-29) — fmtVal 이 이미 unit 포함하므로 별도 unit 추가 X.
  //   이전: `{fmtVal(v)}{unit||''}` → "3570억원억원" 버그.
  const hasNegative = data.some(v => v < 0);
  const maxAbs = hasNegative ? Math.max(...data.map(v => Math.abs(v)), 1) : maxVal;
  return (
    <div className="space-y-3">
      {titleBlock}
      <div className="space-y-2">
        {data.map((v, i) => {
          const isNegative = v < 0;
          // 양수 = barColor (사용자 color prop), 음수 = negBarColor (사용자 negColor prop, default 빨강).
          // 한국 수급 차트면 AI 가 color='red' + negColor='blue' 명시. 글로벌 자산 차트는 default
          // (color='orange' 등 + 음수 빨강).
          const fillCls = isNegative ? negBarColor : barColor;
          // 양방향 mode: width 는 트랙 절반 영역 (50%) 안에서 비례.
          // 음수: 가운데부터 왼쪽으로 (right-1/2 + width). 양수: 가운데부터 오른쪽으로 (left-1/2 + width).
          // 단방향 mode: 기존 동작 (left:0 + width 100% 까지 활용).
          const widthPct = hasNegative
            ? (Math.abs(v) / maxAbs) * 50
            : (Math.abs(v) / maxAbs) * 100;
          return (
            <div
              key={i}
              className="flex items-center gap-3 px-1 py-0.5 rounded cursor-default"
            >
              <span className="text-xs w-20 truncate text-right text-gray-600">{labels[i] ?? i}</span>
              <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden relative">
                <div
                  className={`absolute top-0 bottom-0 ${fillCls} transition-all duration-500 opacity-85 ${
                    hasNegative
                      ? isNegative
                        ? 'right-1/2 rounded-l-full'
                        : 'left-1/2 rounded-r-full'
                      : 'left-0 rounded-full'
                  }`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              {showValues && (
                <span className={`text-xs font-bold min-w-[3rem] text-right ${isNegative ? negBarColor.replace('bg-', 'text-').replace('-500', '-600') : 'text-gray-700'}`}>
                  {fmtVal(v)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 파이/도넛 차트 호버 인터랙션 분리 — 클라이언트 상태 보유
function PieChartInteractive({ segments, gradient, titleBlock, unit, showPct = true }: {
  segments: Array<{ label: string; value: number; pct: number; color: string }>;
  gradient: string;
  titleBlock: React.ReactNode;
  unit?: string;
  showPct?: boolean;
}) {
  // 툴팁 제거 (v0.1, 2026-04-22) — legend 에 label + value + pct 이미 표시됨.
  // tooltip 은 derived 계산 (pct toFixed 등) 이 AI 잘못된 데이터를 증폭시킴.
  return (
    <div className="space-y-3">
      {titleBlock}
      <div className="flex items-center justify-center gap-6">
        <div
          className="relative w-40 h-40 rounded-full shadow-sm border border-gray-100"
          style={{ background: gradient }}
        />
        <div className="space-y-1.5">
          {segments.map((seg, i) => (
            <div key={i} className="flex items-center gap-2 text-sm px-1 py-0.5">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="text-gray-700">{seg.label}</span>
              <span className="text-gray-500 ml-2">{seg.value.toLocaleString('ko-KR')}{unit || ''}</span>
              {showPct && <span className="text-gray-400 ml-auto">{seg.pct.toFixed(1)}%</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Metric ──────────────────────────────────────────────────────────────────
// 라벨 + 대표값 + 증감(delta) 전용 카드. Card + Text 3개 조합 대체.
function MetricComp({ label, value, unit, delta, deltaType, subLabel, icon, link, align, labelAlign, valueAlign, deltaAlign, subLabelAlign }: {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string | number;
  deltaType?: 'up' | 'down' | 'neutral';
  subLabel?: string;
  icon?: string;
  /** 카드 전체 클릭 시 이동할 link (선택). 박혀있으면 카드가 anchor 로 wrap. */
  link?: { label?: string; href?: string };
  /** 전체 정렬 일괄 지정 (하위 4개 개별 align 이 없으면 이 값 사용). */
  align?: 'left' | 'right' | 'center';
  /** 필드별 정렬 override — 각각 따로 지정 가능. 미지정 시 한국 금융 카드 스타일:
   *  label·subLabel=가운데, value=(숫자→우측 / 텍스트→가운데), delta=우측. */
  labelAlign?: 'left' | 'right' | 'center';
  valueAlign?: 'left' | 'right' | 'center';
  deltaAlign?: 'left' | 'right' | 'center';
  subLabelAlign?: 'left' | 'right' | 'center';
}) {
  // up/down 색은 CMS 토큰 사용 (한국 주식 컨벤션 — 사용자가 어드민에서 변경 가능). neutral 만 hardcoded.
  const deltaStyle: React.CSSProperties =
    deltaType === 'up' ? { color: 'var(--cms-up)' } :
    deltaType === 'down' ? { color: 'var(--cms-down)' } :
    {};
  const deltaColor = deltaType === 'neutral' || !deltaType ? 'text-gray-500' : '';
  const deltaArrow = deltaType === 'up' ? '▲' : deltaType === 'down' ? '▼' : '';
  const valStr = formatNumberString(value);

  // value 가 숫자 패턴인지 (콤마·부호·단위·approximate prefix 허용)
  // 우선순위: 필드별 명시 > 전체 align > 기본값 (자동 numeric 감지 제거 — AI 명시 안 하면 일관)
  const la = labelAlign    ?? align ?? 'center';
  const va = valueAlign    ?? align ?? 'center';
  const da = deltaAlign    ?? align ?? 'right';
  const sa = subLabelAlign ?? align ?? 'center';

  const justify = (a: string) => a === 'center' ? 'justify-center' : a === 'right' ? 'justify-end' : 'justify-start';
  const text    = (a: string) => a === 'center' ? 'text-center'    : a === 'right' ? 'text-right'   : 'text-left';

  // link 박혀있으면 카드 전체 anchor 로 wrap, 없으면 div.
  const cardCls = `bg-white border border-gray-100 rounded-xl p-4 shadow-sm flex flex-col ${link?.href ? 'hover:shadow-md hover:border-gray-200 transition-all cursor-pointer no-underline' : ''}`;
  const inner = (
    <>
      <div className={`flex items-center gap-1.5 text-xs text-gray-500 mb-1 ${justify(la)}`}>
        {icon && <span>{icon}</span>}
        <span className="font-medium">{cleanPlainText(label)}</span>
      </div>
      <div className={`flex items-baseline gap-1 w-full ${justify(va)}`}>
        <span className="text-2xl font-bold text-gray-900 tabular-nums">{valStr}</span>
        {unit && <span className="text-sm text-gray-500">{cleanPlainText(unit)}</span>}
      </div>
      {delta != null && (
        <div className={`text-xs font-bold mt-1 tabular-nums ${deltaColor} ${text(da)}`} style={deltaStyle}>
          {deltaArrow} {formatNumberString(delta)}
        </div>
      )}
      {subLabel && <div className={`text-xs text-gray-400 mt-1 ${text(sa)}`}>{cleanPlainText(subLabel)}</div>}
      {link?.href && link?.label && (
        <div className="text-[11px] font-bold mt-2 pt-2 border-t border-gray-100" style={{ color: 'var(--cms-primary)' }}>
          {link.label} →
        </div>
      )}
    </>
  );
  if (link?.href) {
    return <a href={link.href} className={cardCls}>{inner}</a>;
  }
  return <div className={cardCls}>{inner}</div>;
}

// ── Timeline ────────────────────────────────────────────────────────────────
// 연대기 / 이벤트 타임라인. 세로로 점+선+날짜+제목+설명.
function TimelineComp({ items }: {
  items: Array<{ date: string; title: string; description?: string; type?: 'default' | 'success' | 'warning' | 'error'; href?: string }>;
}) {
  const dotColor: Record<string, string> = {
    default: 'bg-blue-500',
    success: 'bg-green-500',
    warning: 'bg-amber-500',
    error:   'bg-red-500',
  };
  return (
    <div className="relative pl-6">
      <div className="absolute left-[11px] top-2 bottom-2 w-px bg-gray-200" />
      <div className="space-y-5">
        {items.map((item, i) => {
          const inner = (
            <>
              <div className={`absolute -left-[18px] top-1 w-3 h-3 rounded-full border-2 border-white ${dotColor[item.type ?? 'default']} shadow-sm`} />
              <div className="text-xs text-gray-500 font-mono mb-0.5">{cleanPlainText(item.date)}</div>
              <div className="font-bold text-sm text-gray-900">{cleanPlainText(item.title)}</div>
              {item.description && <div className="text-sm text-gray-600 mt-0.5 leading-relaxed">{cleanPlainText(item.description)}</div>}
            </>
          );
          // href 박혀있으면 항목 전체 anchor wrap (호버 시 미세 강조)
          if (item.href) {
            return (
              <a
                key={i}
                href={item.href}
                className="relative block no-underline hover:opacity-80 transition-opacity"
                style={{ color: 'inherit' }}
              >
                {inner}
              </a>
            );
          }
          return <div key={i} className="relative">{inner}</div>;
        })}
      </div>
    </div>
  );
}

// ── Compare (A vs B) ────────────────────────────────────────────────────────
function CompareComp({ title, left, right }: {
  title?: string;
  left: { label: string; items: Array<{ key: string; value: string }> };
  right: { label: string; items: Array<{ key: string; value: string }> };
}) {
  const allKeys = Array.from(new Set([...left.items.map(i => i.key), ...right.items.map(i => i.key)]));
  const leftMap = new Map(left.items.map(i => [i.key, i.value]));
  const rightMap = new Map(right.items.map(i => [i.key, i.value]));
  return (
    <div className="space-y-3">
      {title && <div className="text-base font-bold text-gray-800">{cleanPlainText(title)}</div>}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-0 bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="p-4 bg-blue-50 border-b border-blue-100">
          <div className="text-xs text-blue-600 font-bold uppercase tracking-wider">{cleanPlainText(left.label)}</div>
        </div>
        <div className="bg-gray-50 border-b border-gray-200" />
        <div className="p-4 bg-amber-50 border-b border-amber-100">
          <div className="text-xs text-amber-700 font-bold uppercase tracking-wider">{cleanPlainText(right.label)}</div>
        </div>
        {allKeys.map(k => {
          const lv = leftMap.get(k);
          const rv = rightMap.get(k);
          // diff highlight — 같은 key 의 left·right 값이 다르면 양쪽 cell 굵게.
          // null/undefined (한쪽만 박힌 케이스) 도 diff 로 간주.
          const isDiff = lv !== rv;
          const cellCls = `p-3 text-sm border-t border-gray-100 first:border-t-0 ${isDiff ? 'font-bold text-gray-900' : 'text-gray-700'}`;
          return (
            <React.Fragment key={k}>
              <div className={cellCls}>{lv != null ? formatNumberString(lv) : '—'}</div>
              <div className="px-3 py-2 text-xs text-gray-400 font-medium flex items-center justify-center bg-gray-50 border-t border-gray-100 first:border-t-0">{cleanPlainText(k)}</div>
              <div className={cellCls}>{rv != null ? formatNumberString(rv) : '—'}</div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ── KeyValue ────────────────────────────────────────────────────────────────
// 라벨:값 구조적 나열. 종목 정보, 제품 스펙 등.
function KeyValueComp({ title, items, columns = 2 }: {
  title?: string;
  items: Array<{ key: string; value: string | number; highlight?: boolean; href?: string }>;
  columns?: number;
}) {
  const gridCls: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  };
  return (
    <div className="space-y-2">
      {title && <div className="text-sm font-bold text-gray-800">{cleanPlainText(title)}</div>}
      <div className={`grid ${gridCls[columns] ?? gridCls[2]} gap-x-4 gap-y-2`}>
        {items.map((item, i) => {
          const rowCls = `flex items-baseline justify-between gap-3 py-1.5 border-b border-gray-100 ${item.href ? 'hover:opacity-80 transition-opacity cursor-pointer no-underline' : ''}`;
          const inner = (
            <>
              <span className="text-xs text-gray-500 shrink-0">{cleanPlainText(item.key)}</span>
              <span className={`text-sm text-right tabular-nums ${item.highlight ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
                {formatNumberString(item.value)}
              </span>
            </>
          );
          if (item.href) {
            return <a key={i} href={item.href} className={rowCls} style={{ color: 'inherit' }}>{inner}</a>;
          }
          return <div key={i} className={rowCls}>{inner}</div>;
        })}
      </div>
    </div>
  );
}

// ── StatusBadge ─────────────────────────────────────────────────────────────
// 의미 기반 상태 뱃지 세트 (정배열/과열/중립 등).
function StatusBadgeComp({ items }: {
  items: Array<{ label: string; status: 'positive' | 'negative' | 'neutral' | 'warning' | 'info' }>;
}) {
  const styles: Record<string, string> = {
    positive: 'bg-green-50 text-green-700 border-green-200',
    negative: 'bg-red-50 text-red-700 border-red-200',
    neutral:  'bg-gray-50 text-gray-700 border-gray-200',
    warning:  'bg-amber-50 text-amber-700 border-amber-200',
    info:     'bg-blue-50 text-blue-700 border-blue-200',
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span key={i} className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${styles[item.status] ?? styles.neutral}`}>
          {cleanPlainText(item.label)}
        </span>
      ))}
    </div>
  );
}

// ── PlanCard ────────────────────────────────────────────────────────────────
// 복합 작업 실행 전 승인 플랜. AI 가 propose_plan MCP 도구로 호출 → 이 카드 +
// suggest 버튼(실행/수정/취소)이 같이 표시됨.
function PlanCardComp({ title, steps, estimatedTime, risks }: {
  title: string;
  steps: Array<{ title: string; description?: string; tool?: string }>;
  estimatedTime?: string;
  risks?: string[];
}) {
  return (
    <div className="border border-indigo-200 bg-gradient-to-br from-indigo-50 to-blue-50 rounded-2xl p-4 my-2">
      <div className="flex items-center gap-2 mb-3">
        <div className="shrink-0 px-2 py-0.5 rounded-md bg-indigo-600 text-white text-[10px] font-bold tracking-wider leading-none flex items-center">PLAN</div>
        <h3 className="text-sm sm:text-base font-bold text-indigo-900 flex-1 min-w-0 truncate">{cleanPlainText(title)}</h3>
        {estimatedTime && (
          <span className="shrink-0 text-[11px] font-medium text-indigo-600 bg-white/60 px-2 py-0.5 rounded-full border border-indigo-200">
            ⏱ {cleanPlainText(estimatedTime)}
          </span>
        )}
      </div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 items-start">
            <div className="shrink-0 w-5 h-5 rounded-full bg-white border-2 border-indigo-400 text-indigo-700 text-[10px] font-bold flex items-center justify-center leading-none tabular-nums">
              {i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-slate-800">{cleanPlainText(s.title)}</div>
              {s.description && <div className="text-[11px] text-slate-600 mt-0.5">{cleanPlainText(s.description)}</div>}
              {s.tool && (
                <div className="text-[10px] text-indigo-500 mt-0.5 font-mono">→ {s.tool}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {risks && risks.length > 0 && (
        <div className="mt-3 pt-3 border-t border-indigo-200">
          <div className="text-[11px] font-bold text-amber-700 mb-1">⚠ 주의사항</div>
          <ul className="text-[11px] text-amber-800 space-y-0.5 list-disc ml-4">
            {risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Map ─────────────────────────────────────────────────────────────────────
/**
 * Map 컴포넌트 — Leaflet (default) + 카카오맵 (provider='kakao' 또는 한국 좌표 자동).
 *
 * 흐름:
 *   1. provider 결정 — 명시 / auto (한국 좌표 → 카카오) / 카카오 키 없으면 leaflet 폴백
 *   2. Leaflet: CDN script 동적 로드 → L.map() 초기화 → L.marker() 추가
 *   3. 카카오: window.__KAKAO_MAP_JS_KEY 박혀있으면 SDK 동적 로드 → kakao.maps.Map() → kakao.maps.Marker()
 *
 * SSR 안전: useEffect 안에서만 window 접근. 첫 렌더 시 placeholder div.
 */
type MapMarker = {
  lat: number;
  lon: number;
  label: string;
  popup?: string | null;
  color?: string | null;
  type?: string | null;
};

type MapCircle = {
  lat: number;
  lon: number;
  /** 반경 m (예: 1500 = 1.5km) */
  radius: number;
  color?: string | null;
  /** 'solid' | 'dashed' (기본 dashed). Leaflet 은 dashArray, 카카오는 strokeStyle */
  style?: 'solid' | 'dashed' | null;
};

type MapLegend = {
  color: string;
  label: string;
};

const COLOR_TO_HEX: Record<string, string> = {
  red: '#ef4444', blue: '#3b82f6', green: '#22c55e',
  orange: '#f97316', purple: '#a855f7', yellow: '#eab308', gray: '#6b7280',
};

function colorHex(c?: string | null, fallback = '#3b82f6'): string {
  if (!c) return fallback;
  if (c.startsWith('#')) return c;
  return COLOR_TO_HEX[c] || fallback;
}

function isKoreaCoord(lat: number, lon: number): boolean {
  return lat >= 33 && lat <= 38.7 && lon >= 124.5 && lon <= 132;
}

function MapComp({
  markers, circles, legend, center, zoom, height, provider,
}: {
  markers: MapMarker[];
  circles?: MapCircle[] | null;
  legend?: MapLegend[] | null;
  center?: { lat: number; lon: number } | null;
  zoom?: number | null;
  height?: string | null;
  provider?: 'auto' | 'leaflet' | 'kakao' | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const safeMarkers = Array.isArray(markers) ? markers.filter(m => typeof m?.lat === 'number' && typeof m?.lon === 'number') : [];
  const safeCircles = Array.isArray(circles) ? circles.filter(c => typeof c?.lat === 'number' && typeof c?.lon === 'number' && typeof c?.radius === 'number' && c.radius > 0) : [];
  const safeLegend = Array.isArray(legend) ? legend.filter(l => l?.color && l?.label) : [];
  const finalHeight = height || '400px';
  const finalZoom = typeof zoom === 'number' ? zoom : 12;

  // 중심 좌표 — center 명시 우선, 없으면 markers 평균
  const finalCenter = center && typeof center.lat === 'number' && typeof center.lon === 'number'
    ? center
    : safeMarkers.length > 0
      ? {
          lat: safeMarkers.reduce((a, m) => a + m.lat, 0) / safeMarkers.length,
          lon: safeMarkers.reduce((a, m) => a + m.lon, 0) / safeMarkers.length,
        }
      : { lat: 37.5665, lon: 126.9780 };  // 기본 서울

  useEffect(() => {
    if (!ref.current) return;
    const container = ref.current;
    container.innerHTML = '';

    // provider 결정
    const kakaoKey = (typeof window !== 'undefined' && (window as any).__KAKAO_MAP_JS_KEY) || '';
    const wantsKakao = provider === 'kakao' || (provider !== 'leaflet' && isKoreaCoord(finalCenter.lat, finalCenter.lon) && kakaoKey);
    const useKakao = wantsKakao && kakaoKey;

    if (useKakao) {
      // 카카오맵 SDK 동적 로드
      const initKakao = () => {
        const w = window as any;
        w.kakao.maps.load(() => {
          const map = new w.kakao.maps.Map(container, {
            center: new w.kakao.maps.LatLng(finalCenter.lat, finalCenter.lon),
            level: Math.max(1, Math.min(14, 15 - finalZoom)),  // Leaflet zoom (12=도시) → kakao level (3=동네)
          });
          // 반경 원 (circles) — 카카오 strokeStyle: 'dashed' / 'solid'
          for (const c of safeCircles) {
            new w.kakao.maps.Circle({
              center: new w.kakao.maps.LatLng(c.lat, c.lon),
              radius: c.radius,
              strokeWeight: 2,
              strokeColor: colorHex(c.color, '#3b82f6'),
              strokeOpacity: 0.6,
              strokeStyle: c.style === 'solid' ? 'solid' : 'dashed',
              fillColor: colorHex(c.color, '#3b82f6'),
              fillOpacity: 0.05,
            }).setMap(map);
          }
          // 마커 — m.color 명시 시 컬러 svg, 없으면 카카오 기본 (한국 사용자에게 익숙).
          // 클릭 시 항상 우리 popup 표시 (label 또는 m.popup), kakao 기본 place_url javascript:void 링크 회피.
          const makeColorMarkerImage = (color: string) => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="${color}" stroke="white" stroke-width="2"/></svg>`;
            const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
            return new w.kakao.maps.MarkerImage(url, new w.kakao.maps.Size(22, 22), { offset: new w.kakao.maps.Point(11, 11) });
          };
          for (const m of safeMarkers) {
            const opts: { position: any; title: string; image?: any } = {
              position: new w.kakao.maps.LatLng(m.lat, m.lon),
              title: m.label,
            };
            if (m.color) opts.image = makeColorMarkerImage(colorHex(m.color, '#ef4444'));
            const marker = new w.kakao.maps.Marker(opts);
            marker.setMap(map);
            // popup — m.popup 우선, 없으면 m.label. <a> 태그 제거 (kakao place_url javascript:void 회피)
            const rawPopup = m.popup ? String(m.popup) : m.label;
            const popupText = rawPopup.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
            if (popupText) {
              const info = new w.kakao.maps.InfoWindow({
                content: `<div style="padding:6px 10px;font-size:12px;max-width:240px;">${popupText}</div>`,
                removable: true,
              });
              w.kakao.maps.event.addListener(marker, 'click', () => info.open(map, marker));
            }
          }
          // 마커 2+ 시 자동 bounds fit — 모든 마커 + 원 보이도록 줌 자동
          if (safeMarkers.length + safeCircles.length >= 2) {
            const bounds = new w.kakao.maps.LatLngBounds();
            for (const m of safeMarkers) bounds.extend(new w.kakao.maps.LatLng(m.lat, m.lon));
            for (const c of safeCircles) {
              // 원의 외곽 4점 추가 (라디안 기준 m → degree 근사)
              const dLat = c.radius / 111000;
              const dLon = c.radius / (111000 * Math.cos(c.lat * Math.PI / 180));
              bounds.extend(new w.kakao.maps.LatLng(c.lat + dLat, c.lon));
              bounds.extend(new w.kakao.maps.LatLng(c.lat - dLat, c.lon));
              bounds.extend(new w.kakao.maps.LatLng(c.lat, c.lon + dLon));
              bounds.extend(new w.kakao.maps.LatLng(c.lat, c.lon - dLon));
            }
            if (!bounds.isEmpty()) map.setBounds(bounds);
          }
        });
      };
      const w = window as any;
      if (w.kakao && w.kakao.maps) {
        initKakao();
      } else {
        const existing = document.querySelector(`script[src*="dapi.kakao.com"]`);
        if (existing) existing.addEventListener('load', initKakao);
        else {
          const s = document.createElement('script');
          s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoKey}&autoload=false`;
          s.onload = initKakao;
          document.head.appendChild(s);
        }
      }
    } else {
      // Leaflet (default fallback)
      const w = window as any;
      const initLeaflet = () => {
        const L = w.L;
        if (!L) return;
        const map = L.map(container).setView([finalCenter.lat, finalCenter.lon], finalZoom);
        // OSM 공식 타일은 Referer 정책으로 403 차단 — CartoDB light_all 사용 (밝은 톤, OSM 데이터 기반)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          attribution: '© OpenStreetMap © CARTO',
          subdomains: 'abcd',
          maxZoom: 19,
        }).addTo(map);
        // 반경 원 (circles) — Leaflet L.circle, dashArray 로 점선
        for (const c of safeCircles) {
          const color = colorHex(c.color, '#3b82f6');
          L.circle([c.lat, c.lon], {
            radius: c.radius,
            color,
            weight: 2,
            opacity: 0.6,
            fillColor: color,
            fillOpacity: 0.05,
            ...(c.style === 'solid' ? {} : { dashArray: '6 6' }),
          }).addTo(map);
        }
        for (const m of safeMarkers) {
          const color = colorHex(m.color, '#ef4444');
          const icon = L.divIcon({
            className: 'firebat-map-marker',
            html: `<div style="background:${color};border:2px solid white;border-radius:50%;width:18px;height:18px;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });
          const mk = L.marker([m.lat, m.lon], { icon, title: m.label }).addTo(map);
          // popup — m.popup 우선, 없으면 m.label. <a> 태그 제거 (외부 링크 → 우리 컨텐츠만)
          const rawPopup = m.popup ? String(m.popup) : m.label;
          const popupText = rawPopup.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
          if (popupText) mk.bindPopup(popupText);
        }
        // 마커 2+ 시 자동 bounds fit — 모든 마커 + 원 보이도록 줌 자동
        if (safeMarkers.length + safeCircles.length >= 2) {
          const layers = [
            ...safeMarkers.map(m => L.latLng(m.lat, m.lon)),
            ...safeCircles.flatMap(c => {
              const dLat = c.radius / 111000;
              const dLon = c.radius / (111000 * Math.cos(c.lat * Math.PI / 180));
              return [
                L.latLng(c.lat + dLat, c.lon),
                L.latLng(c.lat - dLat, c.lon),
                L.latLng(c.lat, c.lon + dLon),
                L.latLng(c.lat, c.lon - dLon),
              ];
            }),
          ];
          if (layers.length > 0) map.fitBounds(L.latLngBounds(layers), { padding: [30, 30] });
        }
      };
      if (w.L) initLeaflet();
      else {
        const existingCss = document.querySelector(`link[href*="leaflet"]`);
        if (!existingCss) {
          const css = document.createElement('link');
          css.rel = 'stylesheet';
          css.href = 'https://unpkg.com/leaflet@1/dist/leaflet.css';
          document.head.appendChild(css);
        }
        const existing = document.querySelector(`script[src*="leaflet.js"]`);
        if (existing) existing.addEventListener('load', initLeaflet);
        else {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/leaflet@1/dist/leaflet.js';
          s.onload = initLeaflet;
          document.head.appendChild(s);
        }
      }
    }
  }, [safeMarkers, safeCircles, finalCenter.lat, finalCenter.lon, finalZoom, provider]);

  return (
    <div
      className="relative rounded-xl border border-gray-100 shadow-sm overflow-hidden"
      style={{ height: finalHeight, width: '100%' }}
    >
      <div ref={ref} style={{ height: '100%', width: '100%' }} />
      {/* 사용자 정의 범례 — 우상단 오버레이. AI 가 카테고리별 색상 의미 명시할 때 사용 */}
      {safeLegend.length > 0 && (
        <div
          className="absolute top-2 right-2 bg-white/95 rounded-md shadow border border-gray-200 px-2 py-1.5 text-[11px] z-[400]"
          style={{ pointerEvents: 'none' }}
        >
          {safeLegend.map((l, i) => (
            <div key={i} className="flex items-center gap-1.5 leading-tight py-0.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: colorHex(l.color, '#3b82f6') }}
              />
              <span className="text-gray-700">{l.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 동적 CDN 로드 헬퍼 ───────────────────────────────────────────────────────
/** CDN script + CSS 동적 로드. 이미 박혀있으면 skip. onload 보장. */
function loadCdn(opts: { js?: string[]; css?: string[]; globalCheck?: () => boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    if (opts.globalCheck?.()) return resolve();
    for (const css of opts.css ?? []) {
      if (!document.querySelector(`link[href="${css}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = css;
        document.head.appendChild(l);
      }
    }
    const jsList = opts.js ?? [];
    if (jsList.length === 0) return resolve();
    let pending = jsList.length;
    const onDone = () => { pending--; if (pending === 0) resolve(); };
    for (const js of jsList) {
      const existing = document.querySelector(`script[src="${js}"]`) as HTMLScriptElement | null;
      if (existing) {
        if ((existing as any)._loaded) onDone();
        else existing.addEventListener('load', onDone);
      } else {
        const s = document.createElement('script');
        s.src = js;
        s.onload = () => { (s as any)._loaded = true; onDone(); };
        s.onerror = onDone;
        document.head.appendChild(s);
      }
    }
  });
}

// ── Diagram (mermaid) ───────────────────────────────────────────────────────
function DiagramComp({ code, theme }: { code: string; theme?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !code) return;
    const container = ref.current;
    container.innerHTML = '';
    loadCdn({
      js: ['https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'],
      globalCheck: () => !!(window as any).mermaid,
    }).then(() => {
      const w = window as any;
      if (!w.mermaid) return;
      try {
        w.mermaid.initialize({ startOnLoad: false, theme: theme || 'default', securityLevel: 'loose' });
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        w.mermaid.render(id, code).then((res: { svg: string }) => {
          container.innerHTML = res.svg;
        }).catch((err: Error) => {
          container.innerHTML = `<div style="color:#ef4444;padding:12px;font-size:12px">Mermaid 렌더 실패: ${err.message}</div>`;
        });
      } catch (e) {
        container.innerHTML = `<div style="color:#ef4444;padding:12px;font-size:12px">Mermaid 오류: ${(e as Error).message}</div>`;
      }
    });
  }, [code, theme]);
  return <div ref={ref} className="my-3 rounded-xl border border-gray-100 shadow-sm p-4 bg-white overflow-x-auto" />;
}

// ── Math (KaTeX) ────────────────────────────────────────────────────────────
function MathComp({ expression, block }: { expression: string; block: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current || !expression) return;
    const target = ref.current;
    loadCdn({
      js: ['https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js'],
      css: ['https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css'],
      globalCheck: () => !!(window as any).katex,
    }).then(() => {
      const w = window as any;
      if (!w.katex) return;
      try {
        w.katex.render(expression, target, { throwOnError: false, displayMode: block });
      } catch (e) {
        target.textContent = `KaTeX 오류: ${(e as Error).message}`;
      }
    });
  }, [expression, block]);
  if (block) return <div className="my-3 text-center" ref={ref as any} />;
  return <span ref={ref} />;
}

// ── Code (highlight.js) ─────────────────────────────────────────────────────
function CodeComp({ code, language, showLineNumbers, title }: {
  code: string; language: string; showLineNumbers: boolean; title?: string | null;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current || !code) return;
    const target = ref.current;
    loadCdn({
      js: ['https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js'],
      css: ['https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css'],
      globalCheck: () => !!(window as any).hljs,
    }).then(() => {
      const w = window as any;
      if (!w.hljs) return;
      try {
        const langClass = w.hljs.getLanguage(language) ? language : 'plaintext';
        const result = w.hljs.highlight(code, { language: langClass });
        target.innerHTML = result.value;
        target.className = `hljs language-${langClass}`;
      } catch {
        target.textContent = code;
      }
    });
  }, [code, language]);

  const lines = showLineNumbers ? code.split('\n') : [];
  return (
    <div className="my-3 rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {title && (
        <div className="bg-gray-50 px-4 py-2 text-[12px] font-mono text-gray-600 border-b border-gray-100">
          {title}
        </div>
      )}
      <div className="flex">
        {showLineNumbers && (
          <div className="bg-gray-50 px-3 py-3 text-[12px] font-mono text-gray-400 select-none text-right border-r border-gray-100">
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
        )}
        <pre className="flex-1 p-3 text-[13px] overflow-x-auto" style={{ margin: 0 }}>
          <code ref={ref}>{code}</code>
        </pre>
      </div>
    </div>
  );
}

// ── Slideshow (Swiper) ──────────────────────────────────────────────────────
type SlideImage = { src: string; alt?: string | null; caption?: string | null };

function SlideshowComp({ images, autoplay, autoplayDelay, height }: {
  images: SlideImage[]; autoplay?: boolean | null; autoplayDelay?: number | null; height?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const finalHeight = height || '400px';
  useEffect(() => {
    if (!ref.current || images.length === 0) return;
    const container = ref.current;
    loadCdn({
      js: ['https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js'],
      css: ['https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css'],
      globalCheck: () => !!(window as any).Swiper,
    }).then(() => {
      const w = window as any;
      if (!w.Swiper) return;
      try {
        new w.Swiper(container, {
          loop: images.length > 1,
          autoplay: autoplay ? { delay: autoplayDelay || 3000, disableOnInteraction: false } : false,
          pagination: { el: container.querySelector('.swiper-pagination'), clickable: true },
          navigation: { nextEl: container.querySelector('.swiper-button-next'), prevEl: container.querySelector('.swiper-button-prev') },
        });
      } catch { /* ignore */ }
    });
  }, [images, autoplay, autoplayDelay]);

  return (
    <div ref={ref} className="swiper my-3 rounded-xl border border-gray-100 shadow-sm overflow-hidden" style={{ height: finalHeight }}>
      <div className="swiper-wrapper">
        {images.map((img, i) => (
          <div key={i} className="swiper-slide flex items-center justify-center bg-gray-50 relative">
            <img src={img.src} alt={img.alt ?? ''} className="max-w-full max-h-full object-contain" />
            {img.caption && (
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white p-3 text-sm">{img.caption}</div>
            )}
          </div>
        ))}
      </div>
      <div className="swiper-pagination" />
      <div className="swiper-button-next" />
      <div className="swiper-button-prev" />
    </div>
  );
}

// ── Lottie ──────────────────────────────────────────────────────────────────
function LottieComp({ src, loop, autoplay, height }: {
  src: string; loop: boolean; autoplay: boolean; height?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const finalHeight = height || '300px';
  useEffect(() => {
    if (!ref.current || !src) return;
    const container = ref.current;
    container.innerHTML = '';
    loadCdn({
      js: ['https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie.min.js'],
      globalCheck: () => !!(window as any).lottie,
    }).then(() => {
      const w = window as any;
      if (!w.lottie) return;
      try {
        w.lottie.loadAnimation({ container, renderer: 'svg', loop, autoplay, path: src });
      } catch (e) {
        container.innerHTML = `<div style="color:#ef4444;padding:12px;font-size:12px">Lottie 오류: ${(e as Error).message}</div>`;
      }
    });
  }, [src, loop, autoplay]);
  return <div ref={ref} className="my-3 rounded-xl border border-gray-100 shadow-sm bg-white" style={{ height: finalHeight, width: '100%' }} />;
}

// ── Network (Cytoscape) ─────────────────────────────────────────────────────
type NetworkNode = { id: string; label: string; color?: string | null };
type NetworkEdge = { source: string; target: string; label?: string | null };

function NetworkComp({ nodes, edges, layout, height }: {
  nodes: NetworkNode[]; edges: NetworkEdge[]; layout?: string | null; height?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const finalHeight = height || '400px';
  useEffect(() => {
    if (!ref.current || nodes.length === 0) return;
    const container = ref.current;
    container.innerHTML = '';
    loadCdn({
      js: ['https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js'],
      globalCheck: () => !!(window as any).cytoscape,
    }).then(() => {
      const w = window as any;
      if (!w.cytoscape) return;
      try {
        w.cytoscape({
          container,
          elements: [
            ...nodes.map(n => ({ data: { id: n.id, label: n.label }, style: n.color ? { 'background-color': COLOR_TO_HEX[n.color] || n.color } : {} })),
            ...edges.map(e => ({ data: { id: `${e.source}-${e.target}`, source: e.source, target: e.target, label: e.label || '' } })),
          ],
          style: [
            { selector: 'node', style: { 'background-color': '#3b82f6', 'label': 'data(label)', 'color': '#1e293b', 'font-size': 12, 'text-valign': 'center', 'text-halign': 'center' } },
            { selector: 'edge', style: { 'width': 2, 'line-color': '#94a3b8', 'target-arrow-color': '#94a3b8', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'label': 'data(label)', 'font-size': 10, 'color': '#64748b' } },
          ],
          layout: { name: layout || 'cose', animate: false },
        });
      } catch (e) {
        container.innerHTML = `<div style="color:#ef4444;padding:12px;font-size:12px">Cytoscape 오류: ${(e as Error).message}</div>`;
      }
    });
  }, [nodes, edges, layout]);
  return <div ref={ref} className="my-3 rounded-xl border border-gray-100 shadow-sm bg-white" style={{ height: finalHeight, width: '100%' }} />;
}
