'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import StockChart from '../../admin/chat-components/StockChart';

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
    case 'Image':         return <ImageComp src={p.src ?? ''} alt={p.alt} width={p.width} height={p.height} />;
    case 'Form':          return <FormComp bindModule={p.bindModule} inputs={p.inputs ?? []} submitText={p.submitText} />;
    case 'ResultDisplay': return null;
    case 'Button':        return <ButtonComp text={p.text ?? ''} href={p.href} variant={p.variant} />;
    case 'Divider':       return <DividerComp />;
    case 'Table':         return <TableComp headers={p.headers ?? []} rows={p.rows ?? []} stickyCol={p.stickyCol} align={p.align} cellAlign={p.cellAlign} />;
    case 'Card':          return <CardComp children={p.children ?? []} align={p.align} />;
    case 'Grid':          return <GridComp columns={p.columns} children={p.children ?? []} align={p.align} />;
    case 'AdSlot':        return <AdSlotComp slotId={p.slotId} format={p.format} />;
    case 'Html':          return <HtmlComp content={p.content ?? ''} />;
    case 'Slider':        return <SliderComp label={p.label} min={p.min} max={p.max} step={p.step} defaultValue={p.defaultValue} unit={p.unit} />;
    case 'Tabs':          return <TabsComp tabs={p.tabs ?? []} />;
    case 'Accordion':     return <AccordionComp items={p.items ?? []} />;
    case 'Progress':      return <ProgressComp value={p.value ?? 0} max={p.max} label={p.label} color={p.color} />;
    case 'Badge':         return <BadgeComp text={p.text ?? ''} color={p.color} />;
    case 'Alert':         return <AlertComp message={p.message ?? ''} type={p.type} title={p.title} />;
    case 'Callout':       return <AlertComp message={p.message ?? ''} type={p.type ?? 'info'} title={p.title} />;
    case 'List':          return <ListComp items={p.items ?? []} ordered={p.ordered} />;
    case 'Carousel':      return <CarouselComp children={p.children ?? []} autoPlay={p.autoPlay} interval={p.interval} />;
    case 'Countdown':     return <CountdownComp targetDate={p.targetDate ?? ''} label={p.label} />;
    case 'Chart':         return <ChartComp type={p.chartType ?? 'bar'} data={p.data ?? []} labels={p.labels ?? []} title={p.title} subtitle={p.subtitle} unit={p.unit} color={p.color} palette={p.palette} showValues={p.showValues} showPct={p.showPct} />;
    case 'StockChart':    return <StockChart symbol={p.symbol ?? ''} title={p.title} data={p.data ?? []} indicators={p.indicators} buyPoints={p.buyPoints} sellPoints={p.sellPoints} />;
    case 'Metric':        return <MetricComp label={p.label ?? ''} value={p.value ?? ''} unit={p.unit} delta={p.delta} deltaType={p.deltaType} subLabel={p.subLabel} icon={p.icon} align={p.align} labelAlign={p.labelAlign} valueAlign={p.valueAlign} deltaAlign={p.deltaAlign} subLabelAlign={p.subLabelAlign} />;
    case 'Timeline':      return <TimelineComp items={p.items ?? []} />;
    case 'Compare':       return <CompareComp title={p.title} left={p.left ?? { label: 'A', items: [] }} right={p.right ?? { label: 'B', items: [] }} />;
    case 'KeyValue':      return <KeyValueComp title={p.title} items={p.items ?? []} columns={p.columns} />;
    case 'StatusBadge':   return <StatusBadgeComp items={p.items ?? []} />;
    case 'PlanCard':      return <PlanCardComp title={p.title ?? ''} steps={p.steps ?? []} estimatedTime={p.estimatedTime} risks={p.risks} />;
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

/** display-time 숫자 포맷 — 차트 내부 원시 숫자(backend 가 preserve 하는 Chart data) 전용.
 *  - number 타입 → toLocaleString
 *  - "1000000" 순수 숫자 문자열 → "1,000,000"
 *  - "216000원", "▲1500" 처럼 접두·접미가 있는 경우도 숫자부만 콤마 처리
 *  - 이미 콤마 있거나 4자리 미만이면 그대로 */
function formatNumberString(v: string | number | null | undefined): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString('ko-KR');
  const s = String(v);
  if (s.includes(',')) return s;
  const pure = s.trim().match(/^([+\-]?)(\d{4,})(\.\d+)?$/);
  if (pure) return pure[1] + Number(pure[2]).toLocaleString('ko-KR') + (pure[3] ?? '');
  const wrapped = s.match(/^(\D*)(\d{4,})(\D*)$/);
  if (wrapped) return wrapped[1] + Number(wrapped[2]).toLocaleString('ko-KR') + wrapped[3];
  return s;
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
// 반응형: 부모 폭(대화창·페이지) 기준 max-w-full, 세로로 너무 길면 max-h-[70vh] 로 제한.
// object-contain: 비율 유지 (crop 금지). width/height attribute 는 CLS 방지용 hint.
function ImageComp({ src, alt = '', width, height }: { src: string; alt?: string; width?: number; height?: number }) {
  return (
    <figure className="rounded-xl overflow-hidden shadow-sm border border-gray-100 max-w-full inline-block align-top">
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        className="block max-w-full max-h-[70vh] w-auto h-auto object-contain"
        loading="lazy"
      />
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
      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm space-y-4">
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
function TableComp({ headers = [], rows = [], stickyCol, align, cellAlign }: {
  headers: string[]; rows: string[][]; stickyCol?: boolean;
  /** 컬럼별 정렬 — AI 명시 가능. 미지정 시 자동(숫자 컬럼→우측, 그 외→좌측). */
  align?: (AlignOpt | null | undefined)[];
  /** 셀별 정렬 override — cellAlign[ri][ci]. 특정 행·셀만 따로 조절할 때 사용. */
  cellAlign?: ((AlignOpt | null | undefined)[] | null | undefined)[];
}) {
  // 헤더 행은 항상 sticky (세로 스크롤 시)
  // stickyCol: 미지정 시 4열 이상이면 자동 활성 (첫 열 = 행 라벨 추정)
  const firstColSticky = stickyCol ?? (headers.length >= 4);

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
    <div className="overflow-auto rounded-xl border border-gray-200 shadow-sm max-h-[70vh]">
      <table className="min-w-full border-separate border-spacing-0">
        <thead className="bg-gray-50">
          <tr>
            {headers.map((h, i) => {
              const isStickyCell = firstColSticky && i === 0;
              const headerText = cleanPlainText(h);
              return (
                <th
                  key={i}
                  className={`px-4 py-3 text-[13px] font-bold text-gray-600 uppercase tracking-wider border-b border-gray-200 bg-gray-50 sticky top-0 min-w-[120px] ${headerAlignClass(i, headerText)} ${isStickyCell ? 'left-0 z-20 shadow-[2px_0_0_0_#e5e7eb]' : 'z-10'}`}
                >
                  {headerText}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="hover:bg-gray-50 transition-colors">
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
function CardComp({ children = [], align }: { children: ComponentDef[]; align?: AlignOpt }) {
  const alignCls = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : '';
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl p-6 shadow-sm ${alignCls}`}>
      <ComponentRenderer components={children} />
    </div>
  );
}

// ── Grid ────────────────────────────────────────────────────────────────────
function GridComp({ columns = 2, children = [], align }: { columns?: number; children: ComponentDef[]; align?: AlignOpt }) {
  const gridCls: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
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

// ── Html (iframe sandbox) ───────────────────────────────────────────────────
function HtmlComp({ content }: { content: string }) {
  const srcdoc = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: auto; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.6; color: #1e293b; }
  img, video { max-width: 100%; height: auto; }
</style>
</head><body>${content}</body></html>`;

  return (
    <iframe
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      className="w-full h-full border-0 bg-white"
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

function AlertComp({ message, type = 'info', title }: { message: string; type?: string; title?: string }) {
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

function ChartComp({ type = 'bar', data, labels, title, subtitle, unit, color, palette, showValues = true, showPct = true }: {
  type: 'bar' | 'pie' | 'line' | 'doughnut';
  data: number[];
  labels: string[];
  title?: string;
  subtitle?: string;
  unit?: string;
  color?: string;
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
  return <BarChartInteractive data={data} labels={labels} titleBlock={titleBlock} unit={unit} showValues={showValues} barColor={barColor} maxVal={maxVal} fmtVal={fmtVal} type={type} />;
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

function BarChartInteractive({ data, labels, titleBlock, unit, showValues, barColor, maxVal, fmtVal, type: _type }: {
  data: number[]; labels: string[]; titleBlock: React.ReactNode; unit?: string; showValues: boolean;
  barColor: string; maxVal: number; fmtVal: (v: number) => string; type: 'bar' | 'line';
}) {
  // 툴팁 제거 (v0.1, 2026-04-22) — AI 가 잘못 넣은 데이터가 tooltip 의 derived 계산
  // (pct 등) 을 거치면서 증폭됨. showValues inline 값으로 충분.
  return (
    <div className="space-y-3">
      {titleBlock}
      <div className="space-y-2">
        {data.map((v, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-1 py-0.5 rounded cursor-default"
          >
            <span className="text-xs w-20 truncate text-right text-gray-600">{labels[i] ?? i}</span>
            <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden relative">
              <div
                className={`h-full rounded-full ${barColor} transition-all duration-500 opacity-85`}
                style={{ width: `${(v / maxVal) * 100}%` }}
              />
            </div>
            {showValues && <span className="text-xs font-bold text-gray-700 min-w-[3rem] text-right">{fmtVal(v)}{unit || ''}</span>}
          </div>
        ))}
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
function MetricComp({ label, value, unit, delta, deltaType, subLabel, icon, align, labelAlign, valueAlign, deltaAlign, subLabelAlign }: {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string | number;
  deltaType?: 'up' | 'down' | 'neutral';
  subLabel?: string;
  icon?: string;
  /** 전체 정렬 일괄 지정 (하위 4개 개별 align 이 없으면 이 값 사용). */
  align?: 'left' | 'right' | 'center';
  /** 필드별 정렬 override — 각각 따로 지정 가능. 미지정 시 한국 금융 카드 스타일:
   *  label·subLabel=가운데, value=(숫자→우측 / 텍스트→가운데), delta=우측. */
  labelAlign?: 'left' | 'right' | 'center';
  valueAlign?: 'left' | 'right' | 'center';
  deltaAlign?: 'left' | 'right' | 'center';
  subLabelAlign?: 'left' | 'right' | 'center';
}) {
  const deltaColor = deltaType === 'up' ? 'text-red-600' : deltaType === 'down' ? 'text-blue-600' : 'text-gray-500';
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

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm flex flex-col">
      <div className={`flex items-center gap-1.5 text-xs text-gray-500 mb-1 ${justify(la)}`}>
        {icon && <span>{icon}</span>}
        <span className="font-medium">{cleanPlainText(label)}</span>
      </div>
      <div className={`flex items-baseline gap-1 w-full ${justify(va)}`}>
        <span className="text-2xl font-bold text-gray-900 tabular-nums">{valStr}</span>
        {unit && <span className="text-sm text-gray-500">{cleanPlainText(unit)}</span>}
      </div>
      {delta != null && (
        <div className={`text-xs font-bold mt-1 tabular-nums ${deltaColor} ${text(da)}`}>
          {deltaArrow} {formatNumberString(delta)}
        </div>
      )}
      {subLabel && <div className={`text-xs text-gray-400 mt-1 ${text(sa)}`}>{cleanPlainText(subLabel)}</div>}
    </div>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────
// 연대기 / 이벤트 타임라인. 세로로 점+선+날짜+제목+설명.
function TimelineComp({ items }: {
  items: Array<{ date: string; title: string; description?: string; type?: 'default' | 'success' | 'warning' | 'error' }>;
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
        {items.map((item, i) => (
          <div key={i} className="relative">
            <div className={`absolute -left-[18px] top-1 w-3 h-3 rounded-full border-2 border-white ${dotColor[item.type ?? 'default']} shadow-sm`} />
            <div className="text-xs text-gray-500 font-mono mb-0.5">{cleanPlainText(item.date)}</div>
            <div className="font-bold text-sm text-gray-900">{cleanPlainText(item.title)}</div>
            {item.description && <div className="text-sm text-gray-600 mt-0.5 leading-relaxed">{cleanPlainText(item.description)}</div>}
          </div>
        ))}
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
          return (
            <React.Fragment key={k}>
              <div className="p-3 text-sm text-gray-700 border-t border-gray-100 first:border-t-0">{lv != null ? formatNumberString(lv) : '—'}</div>
              <div className="px-3 py-2 text-xs text-gray-400 font-medium flex items-center justify-center bg-gray-50 border-t border-gray-100 first:border-t-0">{cleanPlainText(k)}</div>
              <div className="p-3 text-sm text-gray-700 border-t border-gray-100 first:border-t-0">{rv != null ? formatNumberString(rv) : '—'}</div>
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
  items: Array<{ key: string; value: string | number; highlight?: boolean }>;
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
        {items.map((item, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 py-1.5 border-b border-gray-100">
            <span className="text-xs text-gray-500 shrink-0">{cleanPlainText(item.key)}</span>
            <span className={`text-sm text-right tabular-nums ${item.highlight ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
              {formatNumberString(item.value)}
            </span>
          </div>
        ))}
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
