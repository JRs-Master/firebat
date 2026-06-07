'use client';

import React, { useState, useCallback, useEffect, useRef, useId } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import StockChart from '../../admin/chat-components/StockChart';
import { useViewportMaxHeight } from '../../../lib/use-viewport-size';
import { apiPost } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';
import { TIME } from '../../../lib/util/time';
import { inlineFormatTagsToMarkdown, maskMath } from '../../../lib/util/md';

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
  // Html 단독 블록 = standalone 앱(페이지 전체) → HtmlComp 가 auto-height(단일 스크롤). 다른 블록과 섞이면 embedded(고정).
  const htmlStandalone = components.length === 1 && ((TYPE_ALIAS[(components[0]?.type || '').toLowerCase()] ?? components[0]?.type) === 'Html');
  return (
    <div className={fullHeight ? 'h-full' : 'flex flex-col gap-6'}>
      {components.map((comp, i) => (
        <ComponentSwitch key={i} comp={comp} standalone={htmlStandalone} />
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
  diagram: 'Diagram', math: 'Math', code: 'Code', slideshow: 'Slideshow',
  lottie: 'Lottie', network: 'Network', map: 'Map',
  quiz: 'Quiz', quizgroup: 'QuizGroup', quiz_group: 'QuizGroup',
};

function ComponentSwitch({ comp, standalone }: { comp: ComponentDef; standalone?: boolean }) {
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
    case 'Card':          return <CardComp children={p.children ?? []} align={p.align} image={p.image} footer={p.footer} link={p.link} title={p.title} content={p.content ?? p.description ?? p.text ?? p.body} badge={p.badge} />;
    case 'Grid':          return <GridComp columns={p.columns} children={p.children ?? []} align={p.align} />;
    case 'AdSlot':        return <AdSlotComp slotId={p.slotId} format={p.format} />;
    case 'Html':          return <HtmlComp content={p.content ?? ''} dependencies={p.dependencies as string[] | undefined} standalone={standalone} />;
    case 'Slider':        return <SliderComp label={p.label} min={p.min} max={p.max} step={p.step} defaultValue={p.defaultValue} unit={p.unit} />;
    case 'Tabs':          return <TabsComp tabs={p.tabs ?? []} />;
    case 'Accordion':     return <AccordionComp items={p.items ?? []} />;
    case 'Progress':      return <ProgressComp value={p.value ?? 0} max={p.max} label={p.label} color={p.color} />;
    case 'Badge':         return <BadgeComp text={p.text ?? ''} color={p.color} />;
    case 'Alert':         return <AlertComp message={p.message ?? p.content ?? p.text ?? p.body ?? ''} type={p.type} title={p.title} action={p.action} />;
    case 'Callout':       return <AlertComp message={p.message ?? p.content ?? p.text ?? p.body ?? ''} type={p.type ?? 'info'} title={p.title} action={p.action} />;
    case 'List':          return <ListComp items={p.items ?? []} ordered={p.ordered} />;
    case 'Carousel':      return <CarouselComp children={p.children ?? []} autoPlay={p.autoPlay} interval={p.interval} />;
    case 'Countdown':     return <CountdownComp targetDate={p.targetDate ?? ''} label={p.label} />;
    case 'Chart':         return <ChartComp type={p.chartType ?? 'bar'} data={p.data ?? []} labels={p.labels ?? []} series={p.series} title={p.title} subtitle={p.subtitle} unit={p.unit} color={p.color} negColor={p.negColor} palette={p.palette} showValues={p.showValues} showPct={p.showPct} />;
    case 'StockChart':    return <StockChart symbol={p.symbol ?? ''} title={p.title} data={p.data ?? []} indicators={p.indicators} buyPoints={p.buyPoints} sellPoints={p.sellPoints} />;
    case 'Metric':        return <MetricComp label={p.label ?? ''} value={p.value ?? ''} unit={p.unit} delta={p.delta} deltaType={p.deltaType} subLabel={p.subLabel} icon={p.icon} link={p.link} align={p.align} labelAlign={p.labelAlign} valueAlign={p.valueAlign} deltaAlign={p.deltaAlign} subLabelAlign={p.subLabelAlign} />;
    case 'Timeline':      return <TimelineComp items={p.items ?? p.events ?? []} />;
    case 'Compare':       return <CompareComp title={p.title} left={p.left ?? { label: 'A', items: [] }} right={p.right ?? { label: 'B', items: [] }} />;
    case 'KeyValue':      return <KeyValueComp title={p.title} items={p.items ?? []} columns={p.columns} />;
    case 'StatusBadge':   return <StatusBadgeComp items={p.items ?? p.badges ?? []} />;
    case 'PlanCard':      return <PlanCardComp title={p.title ?? ''} steps={p.steps ?? []} estimatedTime={p.estimatedTime} risks={p.risks} />;
    case 'Map':           return <MapComp markers={p.markers ?? []} circles={p.circles} lines={p.lines} cone={p.cone} legend={p.legend} center={p.center} zoom={p.zoom} height={p.height} provider={p.provider} />;
    case 'Diagram':       return <DiagramComp code={p.code ?? ''} theme={p.theme} />;
    case 'Math':          return <MathComp expression={p.expression ?? ''} block={p.block !== false} />;
    case 'Code':          return <CodeComp code={p.code ?? ''} language={p.language ?? 'plaintext'} showLineNumbers={p.showLineNumbers !== false} title={p.title} />;
    case 'Slideshow':     return <SlideshowComp images={p.images ?? []} autoplay={p.autoplay} autoplayDelay={p.autoplayDelay} height={p.height} />;
    case 'Lottie':        return <LottieComp src={p.src ?? ''} loop={p.loop !== false} autoplay={p.autoplay !== false} height={p.height} />;
    case 'Network':       return <NetworkComp nodes={p.nodes ?? []} edges={p.edges ?? []} layout={p.layout} height={p.height} />;
    case 'Quiz':          return <QuizComp number={p.number} points={p.points} question={p.question ?? ''} boxes={p.boxes} figures={p.figures} statements={p.statements} choices={p.choices ?? p.options ?? []} answer={p.answer} answerIndex={p.answerIndex} explanation={p.explanation} view={p.view} />;
    case 'QuizGroup':     return <QuizGroupComp passage={p.passage} boxes={p.boxes} figures={p.figures} questions={p.questions ?? []} view={p.view} />;
    default:
      // 알 수 없는 component type 은 silent skip — '지원되지 않는' 노란 박스 표시하지 않음
      // (개발자는 console 에서 확인 가능)
      logger.warn('component-switch', `알 수 없는 컴포넌트 type: ${type}`, { comp });
      return null;
  }
}

// ── Quiz (객관식 문제) ────────────────────────────────────────────────────────
// 데이터(문제/정답/해설 분리) + view 4종으로 같은 데이터를 다르게 렌더:
//   exam(시험지 — 문제만) / answers(해설지 — 정답·해설) / full(풀이본 — 전부) / interactive(풀이 — 클릭→채점→해설).
// 문제 박스·ㄱㄴㄷ 보기는 무채색(흰+검은줄) 시험지 스타일. 정답·오답 표시만 색. 해설은 자유.
const QUIZ_CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const QUIZ_KOR = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
type QuizView = 'exam' | 'answers' | 'full' | 'interactive';

// 컴포넌트가 QUIZ_CIRCLED 로 보기 번호(①②③)를 자동 부여하므로, AI 가 choice 텍스트에 또 넣은
// 앞쪽 마커(원문자 ①~⑩ / "1." / "1)")를 제거해 "① ① form" 식 중복 표시를 막는다.
const stripChoiceMarker = (s: string): string =>
  s.replace(/^\s*(?:[①-⑩]|\d+[.)])\s*/u, '');

// 정답 정규화 — AI 는 answer·answerIndex 둘 다 0-based(choices 인덱스, 첫 보기=0)로 보낸다(실측 2건:
// answerIndex 3=④, answer 1=②). 내부 ans 는 1-based(보기 번호 = i+1)라 +1 환산. 먼저 온 값 사용.
const quizAns = (answer?: number, answerIndex?: number): number | undefined => {
  const idx = typeof answer === 'number' ? answer : typeof answerIndex === 'number' ? answerIndex : undefined;
  return idx === undefined ? undefined : idx + 1;
};

/** 단일 문항 본문 — controlled (selected/revealed/onSelect). quiz 단독 + quiz_group 의 각 문항 공용. */
function QuizBody({
  number, question, boxes, figures, statements, choices, answer, answerIndex, explanation,
  view, selected, revealed, onSelect,
}: {
  number?: number | string; question: string; boxes?: string[]; figures?: ComponentDef[];
  statements?: string[]; choices: string[]; answer?: number; answerIndex?: number; explanation?: string;
  view: QuizView; selected?: number; revealed: boolean; onSelect?: (i: number) => void;
}) {
  const showAnswer = view === 'answers' || view === 'full' || (view === 'interactive' && revealed);
  const interactive = view === 'interactive';
  const ans = quizAns(answer, answerIndex); // 1-based
  const numLabel = number == null ? '' : typeof number === 'number' ? `${number}.` : String(number);
  return (
    <div className="text-[14px] sm:text-[15px] text-slate-800">
      {view === 'answers' ? (
        number != null && <div className="text-[12px] font-bold text-slate-500 mb-1">{typeof number === 'number' ? `${number}번` : String(number)}</div>
      ) : (
        <div className="font-semibold mb-2">
          {numLabel && <span className="mr-1">{numLabel}</span>}
          <InlineMd text={question} />
        </div>
      )}
      {view !== 'answers' && (boxes ?? []).map((b, i) => (
        <div key={`b-${i}`} className="border border-slate-400 bg-white rounded-md p-3 my-2 text-[13px] sm:text-[14px] leading-relaxed">
          <TextComp content={b} />
        </div>
      ))}
      {view !== 'answers' && figures && figures.length > 0 && (
        <div className="my-2"><ComponentRenderer components={figures} /></div>
      )}
      {view !== 'answers' && statements && statements.length > 0 && (
        <div className="border border-slate-400 bg-white rounded-md p-3 my-2 flex flex-col gap-1 text-[13px] sm:text-[14px]">
          {statements.map((s, i) => (
            <div key={`s-${i}`} className="flex gap-1.5">
              <span className="font-bold shrink-0">{QUIZ_KOR[i] ?? `${i + 1}`}.</span>
              <span className="flex-1"><InlineMd text={s} /></span>
            </div>
          ))}
        </div>
      )}
      {view !== 'answers' && (
        <div className="flex flex-col gap-1 my-2">
          {choices.map((c, i) => {
            const num = i + 1;
            const isAns = ans === num;
            const isSel = selected === num;
            let cls = 'border-slate-200';
            if (showAnswer && isAns) cls = 'border-green-500 bg-green-50 text-green-800 font-semibold';
            else if (showAnswer && isSel && !isAns) cls = 'border-red-400 bg-red-50 text-red-700';
            else if (interactive && isSel && !revealed) cls = 'border-blue-500 bg-blue-50';
            else if (interactive && !revealed) cls = 'border-slate-200 hover:bg-slate-50';
            return (
              <button
                key={`c-${i}`}
                type="button"
                disabled={!interactive || revealed}
                onClick={() => onSelect?.(num)}
                className={`text-left flex gap-2 items-start px-2.5 py-1.5 rounded-md border transition-colors ${cls} ${interactive && !revealed ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <span className="shrink-0">{QUIZ_CIRCLED[i] ?? `${num}.`}</span>
                <span className="flex-1"><InlineMd text={stripChoiceMarker(c)} /></span>
                {showAnswer && isAns && <span className="text-green-600 shrink-0">✓</span>}
                {showAnswer && isSel && !isAns && <span className="text-red-500 shrink-0">✗</span>}
              </button>
            );
          })}
        </div>
      )}
      {showAnswer && (
        <div className="mt-2">
          {ans != null && <div className="text-[13px] font-bold text-green-700 mb-1">정답: {QUIZ_CIRCLED[ans - 1] ?? ans}</div>}
          {explanation && (
            <div className="border-l-2 border-indigo-300 pl-3 text-[13px] sm:text-[14px] text-slate-700 leading-relaxed">
              <TextComp content={explanation} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuizComp({ number, points, question, boxes, figures, statements, choices, answer, answerIndex, explanation, view = 'interactive' }: {
  number?: number | string; points?: number | string; question: string; boxes?: string[];
  figures?: ComponentDef[]; statements?: string[]; choices: string[]; answer?: number; answerIndex?: number;
  explanation?: string; view?: QuizView;
}) {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="border border-slate-300 rounded-lg p-3 sm:p-4 bg-white my-2">
      {points != null && (
        <div className="text-[11px] text-slate-400 mb-1 text-right">[{typeof points === 'number' ? `${points}점` : String(points)}]</div>
      )}
      <QuizBody
        number={number} question={question} boxes={boxes} figures={figures} statements={statements}
        choices={choices} answer={answer} answerIndex={answerIndex} explanation={explanation} view={view}
        selected={selected} revealed={revealed} onSelect={setSelected}
      />
      {view === 'interactive' && !revealed && (
        <button type="button" onClick={() => setRevealed(true)} className="mt-2 px-3 py-1.5 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-md">채점</button>
      )}
    </div>
  );
}

function QuizGroupComp({ passage, boxes, figures, questions, view = 'interactive' }: {
  passage?: string; boxes?: string[]; figures?: ComponentDef[];
  questions: Array<{ number?: number | string; question: string; statements?: string[]; choices: string[]; options?: string[]; answer?: number; answerIndex?: number; explanation?: string; figures?: ComponentDef[] }>;
  view?: QuizView;
}) {
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [revealed, setRevealed] = useState(false);
  const qs = questions ?? [];
  return (
    <div className="border border-slate-300 rounded-lg p-3 sm:p-4 bg-white my-2">
      {view !== 'answers' && passage && (
        <div className="border border-slate-400 bg-white rounded-md p-3 mb-3 text-[13px] sm:text-[14px] leading-relaxed">
          <TextComp content={passage} />
        </div>
      )}
      {view !== 'answers' && (boxes ?? []).map((b, i) => (
        <div key={`gb-${i}`} className="border border-slate-400 bg-white rounded-md p-3 mb-2 text-[13px] sm:text-[14px] leading-relaxed"><TextComp content={b} /></div>
      ))}
      {view !== 'answers' && figures && figures.length > 0 && (
        <div className="mb-3"><ComponentRenderer components={figures} /></div>
      )}
      <div className="flex flex-col gap-4">
        {qs.map((q, i) => (
          <QuizBody
            key={`q-${i}`} number={q.number} question={q.question} statements={q.statements} figures={q.figures}
            choices={q.choices ?? q.options ?? []} answer={q.answer} answerIndex={q.answerIndex} explanation={q.explanation} view={view}
            selected={selected[i]} revealed={revealed} onSelect={(n) => setSelected(s => ({ ...s, [i]: n }))}
          />
        ))}
      </div>
      {view === 'interactive' && !revealed && (
        <button type="button" onClick={() => setRevealed(true)} className="mt-3 px-3 py-1.5 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-md">전체 채점</button>
      )}
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────
function HeaderComp({ text, level = 1, align }: { text: string; level?: number; align?: 'left' | 'right' | 'center' }) {
  const clampedLevel = Math.min(Math.max(level, 1), 6);
  // 폰트 사이즈/line-height/letter-spacing 은 globals.css 의 .firebat-cms-content h1..h6 토큰 rule 이 적용.
  // weights 만 컴포넌트 차원에서 명시 (heading 별 강도). 색·정렬은 토큰/className.
  const weights: Record<number, string> = {
    1: 'font-extrabold',
    2: 'font-bold',
    3: 'font-bold',
    4: 'font-semibold',
    5: 'font-semibold',
    6: 'font-semibold',
  };
  // 폰트 크기 명시 — chat 안엔 .firebat-cms-content wrapper 가 없어 globals.css h1..h6 rule 미적용
  // (브라우저 기본 크기 = 위계 들쭉날쭉). 본문 15px 기준 단계적 위계. save_page 안에선
  // .firebat-cms-content h1..h6 (CMS typography 토큰) 이 CSS specificity 로 우선 → 사용자 커스텀 유지.
  const sizes: Record<number, string> = {
    1: 'text-[18px] sm:text-[20px]',
    2: 'text-[17px] sm:text-[18px]',
    3: 'text-[16px] sm:text-[17px]',
    4: 'text-[15px] sm:text-[16px]',
    5: 'text-[15px] sm:text-[16px]',
    6: 'text-[15px] sm:text-[16px]',
  };
  const alignCls = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : '';
  const cls = `${weights[clampedLevel] ?? weights[1]} ${sizes[clampedLevel] ?? sizes[1]} ${alignCls}`;
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
  // mdReady = 개행 정규화 + AI raw HTML escape + **bold** 주입 단일 로직. escape 후라 AI 가 쓴
  // raw <strong> 등은 literal 텍스트로 보이고(번짐 차단), 한국어 인접 **bold** 는 <strong> 렌더.
  const withStrong = mdReady(content);
  return (
    <div className="text-gray-700 text-[15px] sm:text-[16px] font-normal sm:font-medium leading-relaxed prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]}>{withStrong}</ReactMarkdown>
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
    <figure className="rounded-xl overflow-hidden shadow-sm border border-gray-100 w-fit max-w-full mx-auto">
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

      const data = await apiPost<{ success: boolean; data?: any; error?: string }>(
        '/api/module/run',
        { module: bindModule, data: payload },
        { category: 'module-run' },
      );
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
              name={input.name}
              autoComplete="off"
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
  // Design tokens 적용 — primary 색·border·radius 모두 var. hover 는 opacity 로 derive.
  const base = 'inline-flex items-center justify-center px-6 py-3 font-bold text-base transition-all shadow-sm hover:opacity-90 no-underline';
  const styles: Record<string, React.CSSProperties> = {
    primary: {
      background: 'var(--cms-primary)',
      color: '#fff',
      borderRadius: 'var(--cms-radius)',
      border: '1px solid var(--cms-primary)',
    },
    secondary: {
      background: 'var(--cms-bg-card)',
      color: 'var(--cms-text)',
      borderRadius: 'var(--cms-radius)',
      border: '1px solid var(--cms-border)',
    },
    outline: {
      background: 'transparent',
      color: 'var(--cms-primary)',
      borderRadius: 'var(--cms-radius)',
      border: '2px solid var(--cms-primary)',
    },
  };
  const style = styles[variant] ?? styles.primary;

  if (href) {
    return <a href={href} className={base} style={style}>{text}</a>;
  }
  return <button className={base} style={style}>{text}</button>;
}

// ── Divider ─────────────────────────────────────────────────────────────────
function DividerComp() {
  return <hr className="border-gray-200 my-2" />;
}

// ── Table ───────────────────────────────────────────────────────────────────
type AlignOpt = 'left' | 'right' | 'center';
/** 표 셀/헤더처럼 보통 plain 인 필드에 **bold**·<strong> 같은 인라인 포맷이 실제로 섞였는지.
 *  섞였을 때만 InlineMd 로 렌더 — 숫자·코드 cell 은 formatNumberString 그대로 둬 마크다운 오작동
 *  (언더스코어 이탤릭 등) 회피. list/timeline 은 항상 prose 라 무조건 InlineMd 지만 표는 혼재. */
function hasInlineMd(s: string): boolean {
  return /\*\*[^\n*]+\*\*|<\/?(?:strong|b|em|i)\b/i.test(s);
}

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

  // viewport quirk 우회 — 모바일 320px / PC 480px 캡 + 비율 보호 (작은 폰 50% / 데스크톱 70%).
  const maxHeightPx = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });

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
                  {hasInlineMd(headerText) ? <InlineMd text={headerText} /> : headerText}
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
                    {typeof cell === 'string' && hasInlineMd(cell) ? <InlineMd text={cell} /> : displayCell}
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
function CardComp({ children = [], align, image, footer, link, title, content, badge }: {
  children?: ComponentDef[];
  align?: AlignOpt;
  /** 카드 상단 이미지 (선택). src + alt. magazine·card 변형 케이스. */
  image?: { src?: string; alt?: string };
  /** 카드 하단 텍스트·메타 (선택). 작성일·읽는시간 등. */
  footer?: string;
  /** 카드 전체 클릭 link (선택). */
  link?: { href?: string };
  /** 카드 제목 (선택). children 없이 title+content 만으로도 카드 구성 가능. */
  title?: string;
  /** 카드 본문 텍스트 (선택). **bold** 등 인라인 마크다운 지원. */
  content?: string;
  /** 카드 상단 태그 칩 (선택). 분류·상태 라벨. */
  badge?: string;
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
        {badge && (
          <span className="inline-block mb-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-medium">{cleanPlainText(badge)}</span>
        )}
        {title && (
          <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">{cleanPlainText(title)}</h3>
        )}
        {content && (
          <p className="text-[15px] sm:text-base text-gray-700 leading-relaxed whitespace-pre-line mb-1">
            <InlineMd text={content} />
          </p>
        )}
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

/** AI 가 설정한 style 의 selector 를 wrapper class scope 로 한정.
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

function HtmlComp({ content, dependencies, standalone }: { content: string; dependencies?: string[]; standalone?: boolean }) {
  // standalone(페이지 단독 Html = 앱) → postMessage 로 내용 높이를 받아 iframe 자동 높이 = 페이지 단일 스크롤.
  // embedded(다른 블록과 공존) → 차트처럼 고정 높이 + 내부 스크롤 (페이지 스크롤 리듬 일정).
  // standalone(앱) → 콘텐츠 높이를 로드 후 몇 번만 측정해 iframe 높이 px 고정 (헤더/푸터 유지 + 페이지 단일 스크롤).
  // ResizeObserver(연속 재측정)는 100vh 앱이 iframe 높이 따라 무한 증가하던 루프 원인이라 제거 —
  // 로드 + 지연 타임아웃 몇 회만(peak=max) 측정 후 멈춤. 초기 100dvh 로 시작해 100vh 앱도 제대로 측정.
  // standalone(앱) = iframe 이 콘텐츠영역(헤더~푸터 사이)을 꽉 채우고 앱은 그 안에서 스크롤(단일).
  // 높이 측정(postMessage)은 100vh 앱서 순환/타이밍 때문에 잘림·드리프트 나서 안 씀 —
  // 페이지를 뷰포트 flex-column 으로 잠그고(page.tsx isApp) iframe = h-full 로 영역을 채운다.
  // 분기 — dependencies 있으면 iframe srcDoc 격리 (Leaflet/Mermaid 등 CDN library 시각화).
  //        <script> 태그가 있으면 자동 iframe srcDoc — inline DOM 의 DOMPurify 가
  //        XSS 방어 표준으로 <script> 자동 제거하므로 BMI 계산기 등 인터랙티브 페이지
  //        스크립트 실행 0 issue 자동 fix (사용자 보고 2026-05-19).
  //        그 외 (광고·SEO 인덱싱 정상 정적 HTML) = 옛 inline DOM.
  const hasDeps = !!(dependencies && dependencies.length > 0);
  const hasScript = /<script\b/i.test(content);
  const useIframe = hasDeps || hasScript;

  if (!useIframe) {
    // inline DOM — sanitize 후 직접 저장.
    // wrapper class 로 scope 한정 — AI 가 설정한 <style> 안 body/html selector 가 페이지 root 영향 주지 않게.
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
  // standalone 일 때만 — iframe 내용 높이를 부모로 postMessage (sandbox 라 부모가 직접 못 읽음 → 부모가 받아 iframe 높이 세팅).
  const autoScript = ''; // 높이 측정 안 함 — iframe h-full 로 콘텐츠영역 채움 (page.tsx 뷰포트 flex-lock)
  // AI 가 자체 body{margin:0; max-width:none} 같은 style 로 default 깨는 패턴 자주.
  // outer wrapper div 로 max-width 강제 — AI 가 어떻게 body style 짜도 layout 영향 X.
  // CSP meta — sandbox=allow-scripts 위에 defense-in-depth: script src 화이트리스트 + frame/form/base 차단.
  const srcdoc = `<!DOCTYPE html>
<html><head>
${IFRAME_CSP_META}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<script>
/* sandbox 에 allow-same-origin 이 없으면(보안상 의도적) localStorage/sessionStorage 접근이 SecurityError 라
   AI 코드가 즉시 크래시(버튼 등 이후 JS 전부 죽음). allow-same-origin 추가는 부모 origin 접근 위험이라
   대신 in-memory shim 으로 대체 — 앱은 정상 동작, 영속만 세션 한정. */
(function(){function mk(){var s={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null;},setItem:function(k,v){s[k]=String(v);},removeItem:function(k){delete s[k];},clear:function(){s={};},key:function(i){return Object.keys(s)[i]||null;},get length(){return Object.keys(s).length;}};}
['localStorage','sessionStorage'].forEach(function(n){try{window[n]&&window[n].getItem('__fb');}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true});}catch(_){}}});})();
</script>
${cdnTags}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.15) transparent; }
  ::-webkit-scrollbar { width: 2px; height: 2px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 15px; line-height: 1.6; color: #1e293b;
  }
  #firebat-wrap { max-width: 1024px; margin: 0 auto; padding: 24px 16px; }
  img, video { max-width: 100%; height: auto; }

  /* AI 가 raw HTML 설정할 때 mobile 안전망 — design tokens 도입 전 임시 fix.
     AI 의 inline style·class 가 설정한 4-grid · width 고정 등을 강제 override.
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
</head><body><div id="firebat-wrap">${content}</div>${autoScript}</body></html>`;

  return (
    <iframe
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      style={standalone ? { height: '100dvh' } : undefined}
      className={standalone ? 'w-full border-0 bg-white block' : 'w-full min-h-[500px] h-[500px] border-0 bg-white'}
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
  const inputId = useId();
  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between">
          <label htmlFor={inputId} className="text-sm font-semibold text-gray-700">{label}</label>
          <span className="text-sm font-bold text-blue-600">{value}{unit}</span>
        </div>
      )}
      <input
        type="range"
        id={inputId}
        name={inputId}
        autoComplete="off"
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
    // 의미값 (variant) → 색 매핑 — AI 가 success/warning 등으로 보내도 대응.
    success: 'bg-green-100 text-green-700',
    warning: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700',
    danger: 'bg-red-100 text-red-700',
    info: 'bg-blue-100 text-blue-700',
    neutral: 'bg-gray-100 text-gray-700',
    amber: 'bg-amber-100 text-amber-700',
    slate: 'bg-slate-100 text-slate-700',
  };
  const cls = colors[(color || 'blue').toLowerCase()] ?? colors.blue;

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

/** **bold** → <strong> 변환 — 한국어/괄호 인접 시 commonmark 가 인식 못해 raw "**" 노출되는 것 보강.
 *  rehypeRaw 와 함께 사용. mdReady 안에서 escape 뒤에 호출. */
function mdBoldFix(s: string): string {
  return s.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>').replace(/\*\*/g, '');
}

// 인식되는 HTML 태그만 (math 의 `<` 는 안 건드림). admin chat-manager 의 escapeHtmlTagMentions 와 동일 취지.
const HTML_TAG_RE = /<\/?(?:strong|b|em|i|u|s|strike|del|ins|mark|small|sub|sup|code|pre|kbd|samp|var|a|span|abbr|cite|q|blockquote|p|br|hr|img|div|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|section|article|header|footer|nav|aside|main|form|input|select|option|textarea|script|style|iframe|svg|canvas|template)(?:\s[^>]*)?\/?>/gi;
/** AI 가 렌더 텍스트에 literal HTML 태그(`<strong>` 등)를 글로 쓰면 rehypeRaw 가 실제 태그로 실행 →
 *  짝 안 맞으면 뒤 텍스트까지 굵게/이탤릭 번진다. 인식되는 HTML 태그를 entity 로 escape 해 literal
 *  텍스트로 표시 (mdBoldFix 의 의도된 <strong> 주입은 escape 이후라 정상 렌더). */
function escapeHtmlTags(s: string): string {
  return s.replace(HTML_TAG_RE, (m) => m.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}
/** prose 텍스트 → 마크다운 렌더 준비 단일 로직: 개행 정규화 → AI raw HTML escape → **bold** 주입.
 *  rehypeRaw 와 함께 쓰는 모든 마크다운 렌더(TextComp / InlineMd / AlertComp) 공용. 숫자/구조 값
 *  (KeyValue value 등)에는 쓰지 말 것 — "1_000" 이탤릭 등 오작동. */
function mdReady(s: string): string {
  // 수식($...$) 영역을 먼저 placeholder 로 보호 → escape / **bold** / \n·\t 정규화가 LaTeX 명령을
  // 안 망가뜨리게 하고 마지막에 복원(remark-math 가 파싱). 짝 맞는 인라인 포맷 태그(<strong>x</strong>
  // 등)는 마크다운으로 변환해 굵게 의도 보존 (변환 안 하면 escapeHtmlTags 가 literal 로 죽인다).
  const { masked, restore } = maskMath(s);
  return restore(mdBoldFix(escapeHtmlTags(inlineFormatTagsToMarkdown(normalizeEscapes(masked)))));
}

// 인라인 마크다운 components — <p> 블록 래퍼 없이 부모(<li> / <div>) 안에 인라인 배치.
// alertMdComponents 와 달리 p 를 Fragment 로 눌러 list item·timeline 줄 안에서 줄바꿈/여백 0.
const inlineMdComponents = {
  p: (props: any) => <>{props.children}</>,
  strong: (props: any) => <strong className="font-bold" {...props} />,
  em: (props: any) => <em className="italic" {...props} />,
  code: (props: any) => <code className="px-1 py-0.5 bg-black/10 rounded text-[12px] font-mono" {...props} />,
  a: (props: any) => <a className="underline" target="_blank" rel="noopener noreferrer" {...props} />,
  br: () => <br />,
};

/** 자유 텍스트 필드(List 항목 / Timeline 제목·설명 등 AI 가 **bold** 섞어 보내는 prose)용
 *  인라인 마크다운 렌더러. TextComp 와 동일하게 mdBoldFix + rehypeRaw 로 raw "**" 노출 방지하되
 *  <p> 블록 래퍼 없이 인라인. 숫자/구조 값(KeyValue value 등)에는 쓰지 말 것 — "1_000" 이탤릭 오작동. */
function InlineMd({ text }: { text: string | number | null | undefined }) {
  const s = cleanPlainText(text);
  if (!s) return null;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={inlineMdComponents}>
      {mdReady(s)}
    </ReactMarkdown>
  );
}

function AlertComp({ message, type = 'info', title, action }: {
  message: string;
  type?: string;
  title?: string;
  /** CTA 버튼 — 설정되어 있으면 본문 아래에 link 버튼. label 없으면 미렌더. */
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
  return (
    <div className={`${s.bg} ${s.border} border rounded-xl p-4 flex gap-3`}>
      <span className="text-lg shrink-0">{s.icon}</span>
      <div className="min-w-0 flex-1">
        {normTitle && (
          <div className={`font-bold text-sm mb-1 ${s.text}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={alertMdComponents}>{mdReady(title ?? '')}</ReactMarkdown>
          </div>
        )}
        <div className={`text-sm ${s.text} prose-sm break-words`}>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={alertMdComponents}>{mdReady(message)}</ReactMarkdown>
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
        <li key={i} className="text-[15px] sm:text-[16px] font-normal sm:font-medium leading-relaxed"><InlineMd text={item} /></li>
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
        days: Math.floor(diff / TIME.DAY_MS),
        hours: Math.floor((diff % TIME.DAY_MS) / TIME.HOUR_MS),
        minutes: Math.floor((diff % TIME.HOUR_MS) / TIME.MINUTE_MS),
        seconds: Math.floor((diff % TIME.MINUTE_MS) / TIME.SECOND_MS),
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

/** Chart series — multi-series line chart 지원 위해 정규화된 형태.
 *  AI 는 3가지 입력 받음: number[] (single) / { [name]: number[] } (multi 객체) / Series[] (multi 명시 array).
 *  ChartComp 가 모두 동일 series 배열로 변환 후 처리. */
type ChartSeries = { name: string; values: number[]; color?: string };

/** data 입력 (3가지 형태) → 정규화된 series 배열 */
function normalizeChartData(
  data: number[] | Record<string, number[]> | unknown,
  explicitSeries?: ChartSeries[]
): ChartSeries[] {
  // explicitSeries — {name,values}(우리식) 또는 {label,data}(Chart.js datasets) 둘 다 흡수.
  if (Array.isArray(explicitSeries) && explicitSeries.length > 0) {
    return explicitSeries
      .map((s) => {
        const any = s as { name?: string; label?: string; values?: number[]; data?: number[]; color?: string };
        const values = Array.isArray(any.values) ? any.values : Array.isArray(any.data) ? any.data : [];
        return { name: any.name ?? any.label ?? '', values, color: any.color };
      })
      .filter((s) => s.values.length > 0);
  }
  if (Array.isArray(data)) return [{ name: '', values: data as number[] }];
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => Array.isArray(v))
      .map(([name, values]) => ({ name, values: values as number[] }));
  }
  return [];
}

function ChartComp({ type = 'bar', data, labels, series: seriesProp, title, subtitle, unit, color, negColor, palette, showValues = true, showPct = true }: {
  type: 'bar' | 'pie' | 'line' | 'doughnut';
  /** 단일 series: number[] / 다중 series: { [name]: number[] }. 둘 다 받아 자동 정규화. */
  data: number[] | Record<string, number[]>;
  labels: string[];
  /** 명시적 multi-series array — color 같이 설정할 때 사용. 미지정 시 data 에서 자동 derive. */
  series?: ChartSeries[];
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
  const series = normalizeChartData(data, seriesProp);
  if (series.length === 0 || series.every(s => s.values.length === 0)) return null;
  // 모든 series 의 모든 값 평탄화 — maxVal / minVal 계산용
  const flatData = series.flatMap(s => s.values);
  if (flatData.length === 0) return null;
  const maxVal = Math.max(...flatData, 1);
  const minVal = Math.min(...flatData, 0);
  // 단일 series 의 첫 series.values — bar/pie/doughnut 등 single-series chart 에서 사용
  const firstSeriesData = series[0].values;

  // line chart — multi-series 자연 지원
  if (type === 'line') {
    return <LineChartInteractive series={series} labels={labels} title={title} unit={unit} minVal={minVal} maxVal={maxVal} palette={palette} />;
  }
  // bar/pie/doughnut — 현재 single-series 만 지원. multi 시 첫 series 사용 + 콘솔 경고.
  if (series.length > 1) {
    logger.warn('chart', `type='${type}' 는 single-series 만 지원 — 첫 series('${series[0].name}') 만 표시. multi-series 시 type='line' 권장.`);
  }
  // bar/pie/doughnut 는 single-series chart — series[0].values 만 사용 (multi 시 console.warn 설정).
  // 변수명 firstSeriesData 그대로 활용해 의미 명확.
  // 막대 색 default — 한국 주식시장 관습 (오른 게 빨강 / 내린 게 파랑).
  // 음수가 섞인 diverging 차트(수급·등락)만 양수=빨강, 단방향(순위 등)은 중립 파랑 유지.
  // 글로벌 자산 차트는 AI 가 color='blue' + negColor='red' 명시로 뒤집을 수 있음.
  const hasNeg = firstSeriesData.some((v) => v < 0);
  const barColor = (color && COLOR_MAP[color]) ? COLOR_MAP[color].bar : (hasNeg ? 'bg-red-500' : 'bg-blue-500');
  const negBarColor = (negColor && COLOR_MAP[negColor]) ? COLOR_MAP[negColor].bar : 'bg-blue-500';
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
    const total = firstSeriesData.reduce((s, v) => s + v, 0) || 1;
    // 세그먼트 정보 사전 계산 — hover/touch highlight 영역.
    const segments = firstSeriesData.map((v, i) => {
      const pct = (v / total) * 100;
      return { label: labels[i] ?? `#${i}`, value: v, pct, color: pieColors[i % pieColors.length] };
    });
    return <PieChartInteractive segments={segments} titleBlock={titleBlock} unit={unit} showPct={showPct} isDoughnut={type === 'doughnut'} />;
  }

  // bar chart — single-series 만 (firstSeriesData 사용).
  return <BarChartInteractive data={firstSeriesData} labels={labels} titleBlock={titleBlock} unit={unit} showValues={showValues} barColor={barColor} negBarColor={negBarColor} maxVal={maxVal} fmtVal={fmtVal} type={type} />;
}

/** Multi-series line chart — series 1개일 때 single line + area gradient (기존 동작 보존),
 *  2개 이상일 때 각 series 별 path + 색 (palette) + legend + hover tooltip 에 모든 series 값 표시.
 *  area gradient 는 single 일 때만 (multi 시 겹쳐 가독성 저하). */
function LineChartInteractive({ series, labels, title, unit, minVal, maxVal, palette }: {
  series: ChartSeries[]; labels: string[]; title?: string; unit?: string; minVal: number; maxVal: number; palette?: string;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [cursorPos, setCursorPos] = React.useState<{ x: number; y: number } | null>(null);
  // 툴팁이 항상 커서 우/하단에 붙으면 우측·하단 포인트에서 컨테이너 밖으로 밀려 글자가 1자씩
  // 찌그러진다 → 가장자리 근처면 커서 반대쪽으로 뒤집어 표시 (공간 확보).
  const [flip, setFlip] = React.useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const W = 720, H = 260, padL = 56, padR = 24, padT = 20, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const range = maxVal - minVal || 1;
  const yMin = minVal - range * 0.05;
  const yMax = maxVal + range * 0.05;
  // x-축 길이 — 모든 series 공유. 가장 긴 series 의 length 사용 (짧은 series 는 그 길이까지만 그림).
  const xLen = Math.max(...series.map(s => s.values.length), 1);
  const xs = Array.from({ length: xLen }, (_, i) => padL + (xLen <= 1 ? 0 : (i / (xLen - 1)) * plotW));
  // series 별 ys + path 계산
  const seriesPalette = PALETTE_MAP[palette ?? 'default'] ?? PALETTE_MAP.default;
  const seriesPaths = series.map((s, si) => {
    const color = s.color ?? seriesPalette[si % seriesPalette.length];
    const ys = s.values.map(v => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH);
    const path = ys.map((y, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = ys.length > 0
      ? `${path} L ${xs[ys.length - 1].toFixed(1)},${padT + plotH} L ${xs[0].toFixed(1)},${padT + plotH} Z`
      : '';
    return { name: s.name, values: s.values, ys, path, area, color };
  });
  const isMulti = series.length > 1;
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yMin + (yMax - yMin) * (i / ticks));
  const xStep = Math.max(1, Math.floor(xLen / 6));
  const containerRef = React.useRef<HTMLDivElement>(null);

  // 가장 가까운 x index 찾기 (SVG viewBox 좌표계 기준)
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
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    setCursorPos({ x: px, y: py });
    // 오른쪽/아래 가장자리 근처(툴팁 폭·높이 추정만큼 공간 부족)면 반대쪽으로 뒤집어 표시.
    setFlip({ x: px > rect.width - 170, y: py > rect.height - 90 });
  };

  return (
    <div className="space-y-2">
      {title && <div className="text-sm font-bold text-gray-800">{title}</div>}
      {/* legend — multi-series 일 때만 노출 */}
      {isMulti && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {seriesPaths.map((sp, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="inline-block w-3 h-0.5" style={{ background: sp.color }} />
              <span className="text-gray-600">{sp.name || `시리즈 ${i + 1}`}</span>
            </div>
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        className="relative"
        onMouseMove={handleMove}
        onMouseLeave={() => { setHovered(null); setCursorPos(null); }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
          <defs>
            {/* single series 전용 area gradient — multi 시 겹쳐 가독성 저하라 path/circle 만 사용 */}
            {!isMulti && seriesPaths[0] && (
              <linearGradient id="line-grad-single" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={seriesPaths[0].color} stopOpacity="0.25" />
                <stop offset="100%" stopColor={seriesPaths[0].color} stopOpacity="0" />
              </linearGradient>
            )}
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
          {/* single 일 때 area + path, multi 일 때 각 series 의 path 만 (겹침 방지) */}
          {!isMulti && seriesPaths[0] && (
            <path d={seriesPaths[0].area} fill="url(#line-grad-single)" />
          )}
          {seriesPaths.map((sp, si) => (
            <g key={si}>
              <path d={sp.path} fill="none" stroke={sp.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {sp.ys.map((y, i) => <circle key={i} cx={xs[i]} cy={y} r={hovered === i ? 5 : 3} fill={sp.color} />)}
            </g>
          ))}
          {labels.map((_, i) => i % xStep === 0 || i === xLen - 1 ? (
            <text key={i} x={xs[i]} y={H - 8} fill="#94a3b8" fontSize="10" textAnchor="middle">{labels[i] ?? i}</text>
          ) : null)}
        </svg>
        {hovered != null && cursorPos && (
          <div
            className="absolute pointer-events-none bg-white/95 shadow-lg rounded-lg px-3 py-2 text-center border border-slate-200 z-10"
            style={{
              left: cursorPos.x + (flip.x ? -14 : 14),
              top: cursorPos.y + (flip.y ? -14 : 14),
              transform: `translate(${flip.x ? '-100%' : '0'}, ${flip.y ? '-100%' : '0'})`,
            }}
          >
            <div className="text-[11px] font-bold text-slate-800 whitespace-nowrap mb-0.5">{labels[hovered] ?? hovered}</div>
            {/* multi-series 시 각 series 별 값 list, single 시 단일 큰 텍스트 */}
            {isMulti ? (
              <div className="space-y-0.5 text-left">
                {seriesPaths.map((sp, si) => sp.values[hovered] !== undefined ? (
                  <div key={si} className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
                    <span className="inline-block w-2 h-2 rounded-sm" style={{ background: sp.color }} />
                    <span className="text-gray-600">{sp.name || `시리즈 ${si + 1}`}</span>
                    <span className="font-extrabold text-slate-900 ml-auto">{sp.values[hovered].toLocaleString('ko-KR')}{unit || ''}</span>
                  </div>
                ) : null)}
              </div>
            ) : (
              <div className="text-[14px] font-extrabold text-slate-900">
                {seriesPaths[0]?.values[hovered]?.toLocaleString('ko-KR')}{unit || ''}
              </div>
            )}
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
  //   maxAbs 기준 비례 (트랙 절반 영역 활용). 한국 관습 default — 양수 빨강 / 음수 파랑 (텍스트 동일).
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
          // 양수 = barColor, 음수 = negBarColor. default 는 한국 관습 (양수 빨강 / 음수 파랑).
          // 글로벌 자산 차트는 AI 가 color='blue' + negColor='red' 명시로 뒤집을 수 있음.
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
function PieChartInteractive({ segments, titleBlock, unit, showPct = true, isDoughnut = false }: {
  segments: Array<{ label: string; value: number; pct: number; color: string }>;
  titleBlock: React.ReactNode;
  unit?: string;
  showPct?: boolean;
  isDoughnut?: boolean;
}) {
  // hover/touch highlight 영역 — PC hover + 모바일 tap 양쪽 같은 activeIndex state 사용.
  // SVG path 로 그려 slice 영역 hover 가능 (옛 conic-gradient = 불가능했던 부분).
  const [active, setActive] = React.useState<number | null>(null);

  // SVG arc path 영역 계산.
  const SIZE = 160;
  const CENTER = SIZE / 2;
  const RADIUS = 70; // pop-out(+7) 이 viewBox 안 넘게 여유
  const INNER_RADIUS = isDoughnut ? 40 : 0;
  const POP = 7; // 선택 조각 바깥으로 튀어나오는 거리

  // 누적 각도 영역 — 0~2π 영역에서 12시 방향 (-π/2) 시작.
  let cumAngle = -Math.PI / 2;
  const arcs = segments.map(seg => {
    const angle = (seg.pct / 100) * Math.PI * 2;
    const a0 = cumAngle;
    const a1 = cumAngle + angle;
    cumAngle = a1;
    return { ...seg, a0, a1 };
  });

  /** SVG path d 계산 — arc. r 은 outer radius 사용 (active 조각은 더 큰 r). */
  const arcPath = (a0: number, a1: number, r: number, ri = 0) => {
    const largeArc = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = CENTER + Math.cos(a0) * r;
    const y0 = CENTER + Math.sin(a0) * r;
    const x1 = CENTER + Math.cos(a1) * r;
    const y1 = CENTER + Math.sin(a1) * r;
    if (ri > 0) {
      const xi0 = CENTER + Math.cos(a0) * ri;
      const yi0 = CENTER + Math.sin(a0) * ri;
      const xi1 = CENTER + Math.cos(a1) * ri;
      const yi1 = CENTER + Math.sin(a1) * ri;
      return `M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${ri} ${ri} 0 ${largeArc} 0 ${xi0} ${yi0} Z`;
    }
    return `M ${CENTER} ${CENTER} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} Z`;
  };

  return (
    <div className="space-y-3">
      {titleBlock}
      <div className="flex items-center justify-center gap-6">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="drop-shadow-sm shrink-0"
          // 모바일 — pie 외부 영역 터치 시 active 해제.
          onTouchEnd={() => { /* slice onTouchStart 에서 설정한 active 유지 — 외부 영역에서만 해제 */ }}
        >
          {arcs.map((arc, i) => {
            // 선택 조각 = 중심각 방향으로 살짝 pop-out (분리). 다른 조각·범례 글자 이동 0 (translate 만).
            const isActive = active === i;
            const mid = (arc.a0 + arc.a1) / 2;
            const tx = isActive ? Math.cos(mid) * POP : 0;
            const ty = isActive ? Math.sin(mid) * POP : 0;
            return (
              <path
                key={i}
                d={arcPath(arc.a0, arc.a1, RADIUS, INNER_RADIUS)}
                fill={arc.color}
                stroke="white"
                strokeWidth={1.5}
                transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)})`}
                style={{ cursor: 'pointer', transition: 'transform 0.15s ease' }}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onTouchStart={(e) => { e.preventDefault(); setActive(active === i ? null : i); }}
              />
            );
          })}
        </svg>
        <div className="space-y-1.5">
          {segments.map((seg, i) => {
            const isActive = active === i;
            // font-weight 변경 금지 — bold 면 글자 폭 변경 → row 텍스트 이동. 활성 표시 = background 만
            // (폭 변경 0). 선택 잘 보이게 bg-slate-200 (옛 gray-100 은 너무 연함). ring/border 도 금지(이동).
            return (
              <div
                key={i}
                className={`flex items-center gap-2 text-sm px-2 py-1 rounded cursor-pointer transition-colors ${isActive ? 'bg-slate-200' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onTouchStart={() => setActive(active === i ? null : i)}
              >
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
                <span className="text-gray-700">{seg.label}</span>
                <span className="text-gray-500 ml-2">{seg.value.toLocaleString('ko-KR')}{unit || ''}</span>
                {showPct && <span className="text-gray-400 ml-auto">{seg.pct.toFixed(1)}%</span>}
              </div>
            );
          })}
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
  /** 카드 전체 클릭 시 이동할 link (선택). 설정되어 있으면 카드가 anchor 로 wrap. */
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

  // link 설정되어 있으면 카드 전체 anchor 로 wrap, 없으면 div.
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
              <div className="font-bold text-sm text-gray-900"><InlineMd text={item.title} /></div>
              {item.description && <div className="text-sm text-gray-600 mt-0.5 leading-relaxed"><InlineMd text={item.description} /></div>}
            </>
          );
          // href 설정되어 있으면 항목 전체 anchor wrap (호버 시 미세 강조)
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
          // null/undefined (한쪽만 설정된 케이스) 도 diff 로 간주.
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
  // 다른 컴포넌트(card/metric)와 통일된 프레임 — 테두리 + 제목 바 + 값 강조. 평면 나열 탈피.
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden my-1">
      {title && (
        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-800">
          {cleanPlainText(title)}
        </div>
      )}
      <div className={`grid ${gridCls[columns] ?? gridCls[2]} gap-x-6 px-4 py-1`}>
        {items.map((item, i) => {
          const rowCls = `flex items-baseline justify-between gap-3 py-2.5 border-b border-gray-100 ${item.href ? 'hover:opacity-70 transition-opacity cursor-pointer no-underline' : ''}`;
          const inner = (
            <>
              <span className="text-[13px] text-gray-500 shrink-0">{cleanPlainText(item.key)}</span>
              <span className={`text-sm text-right tabular-nums ${item.highlight ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>
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
              {s.description && <div className="text-[11px] text-slate-600 mt-0.5"><InlineMd text={s.description} /></div>}
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
 *   3. 카카오: window.__KAKAO_MAP_JS_KEY 설정되어 있으면 SDK 동적 로드 → kakao.maps.Map() → kakao.maps.Marker()
 *
 * SSR 안전: useEffect 안에서만 window 접근. 첫 렌더 시 placeholder div.
 */
type MapMarker = {
  lat: number;
  lon: number;
  /** \n 으로 구분한 multi-line 지원 — 옛 단일 줄 텍스트 + 새 기상청 태풍 예보 형태 양쪽 지원 */
  label: string;
  popup?: string | null;
  color?: string | null;
  type?: string | null;
  /** 마커 아이콘 — default(원) / typhoon(🌀) / forecast(점선) / current(강조) / bank·pharmacy·hospital·school·convenience·cafe·restaurant (카테고리별 이모지) */
  icon?: string | null;
  /** 마커 크기 — small / medium(기본) / large. 태풍 현재 위치 = large */
  size?: 'small' | 'medium' | 'large' | null;
  /** 최대풍속 m/s — typhoon/forecast 마커 색 자동 (기상청 강도 단계). color 가 있으면 color 우선. */
  windSpeed?: number | null;
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

type MapLine = {
  /** 선 좌표 — 최소 2 점 */
  points: { lat: number; lon: number }[];
  color?: string | null;
  /** 선 굵기 px — 기본 3 */
  weight?: number | null;
  /** 'solid'(기본) | 'dashed' — 예상 경로는 dashed */
  style?: 'solid' | 'dashed' | null;
  label?: string | null;
};

type MapCone = {
  /** 경로 점 + 각 점 반경 (meter) — 점점 넓어지는 예측 영역 (네이버 태풍 cone). */
  points: { lat: number; lon: number; radius: number }[];
  color?: string | null;
};

type MapLegend = {
  color: string;
  label: string;
};

/** 마커 icon → emoji 매핑. typhoon / forecast 는 SVG 소용돌이 (아래). current = 📍 / 카테고리 이모지. */
const MARKER_ICON_EMOJI: Record<string, string> = {
  current: '📍',
  // 음식
  restaurant: '🍴', cafe: '☕', bakery: '🍰', bar: '🍺',
  // 금융
  bank: '🏦', atm: '🏧',
  // 의료
  hospital: '🏥', pharmacy: '💊', clinic: '🩺', dental: '🦷',
  // 교육
  school: '🏫', library: '📖', academy: '✏️', university: '🎓',
  // 쇼핑
  convenience: '🏪', mart: '🛒', mall: '🏬',
  // 교통
  subway: '🚇', bus: '🚌', train: '🚉', parking: '🅿️', gas: '⛽', airport: '✈️',
  // 숙박·여가
  hotel: '🏨', park: '🌳', gym: '🏋️', cinema: '🎬',
  // 공공
  police: '🚓', fire: '🚒', post: '📮', gov: '🏛️', church: '⛪',
  // 주거·업무
  home: '🏠', office: '🏢',
};

/** size 영역 → marker pixel 영역. 옛 emoji base 32 → 22 축소 (위험 반경 circles 보다 작게). */
function markerPixelSize(size?: string | null, isEmoji = false): number {
  const base = isEmoji ? 22 : 14;
  if (size === 'large') return Math.round(base * 1.3);
  if (size === 'small') return Math.round(base * 0.75);
  return base;
}

/** 태풍 마커 디바이스 배율 — 모바일은 그대로(잘 보임), PC(≥640px)는 지도가 커서 마커가 작아 보여 약간 확대. */
function markerDeviceScale(): number {
  return (typeof window !== 'undefined' && window.innerWidth >= 640) ? 1.25 : 1.0;
}

/** 카테고리 마커 핀 — 구글맵식: 색 있는 teardrop(Firebat indigo) + 흰 속원 + 이모지.
 *  색 = 브랜드 accent 와 어울림, 흰 속원이 이모지 가독성 유지. 끝(tip)이 좌표 지점 (anchor=bottom /
 *  offset=tip). data URI 반환. 크기 w × round(w*1.32). */
function buildPinSvgUrl(emoji: string, w: number, color = '#6366f1'): string {
  const r = w / 2 - 1.5;
  const cx = w / 2;
  const cy = r + 1.5;
  const h = Math.round(w * 1.32);
  const tipY = h - 0.5;
  // 색 teardrop: bottom tip → 왼쪽 → 머리 원 arc → 오른쪽 → tip. 흰 외곽선으로 지도 위 대비.
  const path = `M ${cx} ${tipY} C ${cx - r * 0.55} ${cy + r * 1.05}, ${cx - r} ${cy + r * 0.35}, ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} C ${cx + r} ${cy + r * 0.35}, ${cx + r * 0.55} ${cy + r * 1.05}, ${cx} ${tipY} Z`;
  const inner = r * 0.62;
  const fontSize = Math.round(inner * 1.4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<path d="${path}" fill="${color}" stroke="white" stroke-width="1.5"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="white"/>`
    + `<text x="${cx}" y="${cy}" font-size="${fontSize}" text-anchor="middle" dominant-baseline="central">${emoji}</text>`
    + `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/** 최대풍속 (m/s) → 기상청 공식 태풍 강도 단계 색 (범례 일치).
 *  강도1 약(17~24) 초록 → 강도2 중(25~32) 파랑 → 강도3 강(33~43) 노랑 → 강도4 매우강(44~53) 주황
 *  → 강도5 초강력(54+) 빨강. 17 미만 = 열대저압부(TD) 회색. windSpeed 없으면 null (caller 가 color fallback). */
function typhoonColorByWind(ws?: number | null): string | null {
  if (typeof ws !== 'number' || !Number.isFinite(ws)) return null;
  if (ws >= 54) return '#ef4444'; // 강도5 초강력 (빨강)
  if (ws >= 44) return '#f97316'; // 강도4 매우강 (주황)
  if (ws >= 33) return '#eab308'; // 강도3 강 (노랑)
  if (ws >= 25) return '#3b82f6'; // 강도2 중 (파랑)
  if (ws >= 17) return '#22c55e'; // 강도1 약 (초록)
  return '#9ca3af';               // 열대저압부 TD (<17, 회색)
}

/** 최대풍속 (m/s) → 기상청 태풍 강도 번호 (1~5). 17 미만 = TD (열대저압부) → 'T'. windSpeed 없으면 null. */
function typhoonGradeNum(ws?: number | null): string | null {
  if (typeof ws !== 'number' || !Number.isFinite(ws)) return null;
  if (ws >= 54) return '5';
  if (ws >= 44) return '4';
  if (ws >= 33) return '3';
  if (ws >= 25) return '2';
  if (ws >= 17) return '1';
  return 'T'; // 열대저압부
}

// mdi-weather-hurricane glyph (24×24 viewBox) — Material Design 태풍 소용돌이. 강도색 채움.
const HURRICANE_PATH = 'M15,6.79C16.86,7.86 18,9.85 18,12C18,22 6,22 6,22C7.25,21.06 8.38,19.95 9.34,18.71C9.38,18.66 9.41,18.61 9.44,18.55C9.69,18.06 9.5,17.46 9,17.21C7.14,16.14 6,14.15 6,12C6,2 18,2 18,2C16.75,2.94 15.62,4.05 14.66,5.29C14.62,5.34 14.59,5.39 14.56,5.45C14.31,5.94 14.5,6.54 15,6.79Z';

/** 태풍 마커 — mdi 허리케인 glyph (강도색 채움 + 흰 외곽) + 중앙 강도 번호. data URI 반환. */
function typhoonSvgUrl(size: number, color = '#dc2626', grade: string | null = null): string {
  const c = size / 2;
  const k = size / 24; // 24 viewBox → 마커 크기 스케일
  // 중앙 강도 번호 — 흰 원판 + 색 숫자 (glyph 눈 자리에 얹음). 정중앙 (central + dy 보정).
  const center = grade
    ? `<circle cx="${c}" cy="${c}" r="${size * 0.22}" fill="white"/><text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" dy="0.04em" fill="${color}" font-size="${size * 0.28}" font-weight="800" font-family="sans-serif">${grade}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<g transform="scale(${k})"><path d="${HURRICANE_PATH}" fill="${color}" stroke="white" stroke-width="0.6" stroke-linejoin="round"/></g>`
    + center
    + `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}


/** multi-line label → HTML \<br\> 변환. sanitize 후. */
function labelToHtml(label: string): string {
  return sanitizePopupHtml(label).replace(/\n/g, '<br>');
}

/** 지도 popup 카드 HTML — 첫 줄 = 헤더, 나머지 = 본문 (라벨:값 행). 색 = Firebat 디자인 통일 (slate).
 *  마커 색 (태풍 빨강 등) 과 무관 — popup 은 디자인 일관성 위해 slate 헤더 + 흰 본문. rawLabel = multi-line (\n). */
function buildPopupCardHtml(rawLabel: string): string {
  const clean = sanitizePopupHtml(rawLabel);
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const [head, ...body] = lines;
  // 본문 각 줄 — "라벨: 값" (콜론) 패턴만 라벨(연회색) 좌 + 값(진하게) 우 분리. 콜론 없으면 한 줄 그대로.
  // 옛 공백 분리 = "오키나와 인근 해상" → "오키나와"+"인근 해상" 오작동 → 콜론 기준으로 정정.
  const bodyRows = body
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx > 0 && idx < line.length - 1) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        return `<div style="display:flex;justify-content:space-between;gap:12px;padding:1px 0;"><span style="color:#94a3b8;">${k}</span><span style="color:#1e293b;font-weight:600;">${v}</span></div>`;
      }
      return `<div style="color:#334155;padding:1px 0;">${line}</div>`;
    })
    .join('');
  // 우리식 카드 — Firebat StockChart / Card 컴포넌트 스타일 (흰 배경 + 제목 bold + border 구분, 색 헤더 X).
  // 둥근 모서리 + 그림자 + border 는 popup wrapper CSS (firebat-map-popup).
  return (
    `<div style="min-width:140px;font-family:'Pretendard Variable',Pretendard,sans-serif;">`
    + `<div style="font-weight:700;font-size:13px;color:#0f172a;padding:9px 13px 8px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">${head}</div>`
    + (bodyRows ? `<div style="padding:9px 13px;font-size:12px;line-height:1.55;background:#fff;">${bodyRows}</div>` : '')
    + `</div>`
  );
}

/** 원 polygon 좌표 (meter 반경 → N 각형 [lon, lat] 배열). MapLibre circle layer 영역 (meter 단위 X). */
function circlePolygonCoords(lat: number, lon: number, radiusM: number, points = 64): [number, number][] {
  const coords: [number, number][] = [];
  const dLatBase = radiusM / 111320;
  const dLonBase = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    coords.push([lon + dLonBase * Math.cos(theta), lat + dLatBase * Math.sin(theta)]);
  }
  return coords;
}

/** cone = 경로를 ~25km 간격으로 촘촘히 보간해 작은 원을 빽빽이 깐 union MultiPolygon.
 *  원들이 거의 겹쳐(간격 ≪ 반경) union 이 매끈한 tube → 구슬 꿰기 0 (구슬은 원이 듬성듬성할 때만).
 *  외접선 사다리꼴 방식은 반지름이 점 간격보다 빨리 커지면 degenerate → 원만 남아 구슬됨 → 폐기.
 *  조각이 전부 볼록 원이라 stray 박스/fold 도 없음. 첫·끝 원 = 현재 뒤 / 마지막 앞 둥근 마감. */
function coneSinglePolygon(pts: { lat: number; lon: number; radius: number }[]): [number, number][] {
  if (pts.length < 2) return [];
  const mLat = 111320;
  // 1) 경로를 ~30km 간격으로 보간 (반지름도 선형). 촘촘 → 곡선 매끈.
  const dense: { lat: number; lon: number; r: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = (b.lon - a.lon) * mLat * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const dy = (b.lat - a.lat) * mLat;
    const d = Math.hypot(dx, dy) || 1;
    const steps = Math.max(1, Math.min(40, Math.round(d / 30000)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      dense.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, r: a.radius + (b.radius - a.radius) * t });
    }
  }
  dense.push({ lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon, r: pts[pts.length - 1].radius });

  const off = (p: { lat: number; lon: number }, r: number, dirX: number, dirY: number): [number, number] => {
    const pmLon = mLat * Math.cos((p.lat * Math.PI) / 180);
    return [p.lon + (r * dirX) / pmLon, p.lat + (r * dirY) / mLat];
  };
  // 2) 각 점 수직 offset 좌/우 경계 (단일 ring → 겹침 0 → 균일 투명도).
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const dirAt = (i: number): { ux: number; uy: number } => {
    const prev = dense[Math.max(0, i - 1)], next = dense[Math.min(dense.length - 1, i + 1)];
    let ux = (next.lon - prev.lon) * mLat * Math.cos((dense[i].lat * Math.PI) / 180);
    let uy = (next.lat - prev.lat) * mLat;
    const len = Math.hypot(ux, uy) || 1;
    return { ux: ux / len, uy: uy / len };
  };
  for (let i = 0; i < dense.length; i++) {
    const { ux, uy } = dirAt(i);
    const nx = -uy, ny = ux; // 왼쪽 법선
    left.push(off(dense[i], dense[i].r, nx, ny));
    right.push(off(dense[i], dense[i].r, -nx, -ny));
  }
  // 3) 양 끝 반원 마감 (전방/후방) — 시계방향 π 호. 첫 원 = 현재 위치 뒤 반원.
  const STEPS = 12;
  const capArc = (p: { lat: number; lon: number }, r: number, startAng: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let s = 1; s < STEPS; s++) {
      const ang = startAng - (Math.PI * s) / STEPS;
      out.push(off(p, r, Math.cos(ang), Math.sin(ang)));
    }
    return out;
  };
  const lastDir = dirAt(dense.length - 1);
  const frontStart = Math.atan2(lastDir.uy, lastDir.ux) + Math.PI / 2; // left 법선각 → CW π → right 법선각
  const front = capArc(dense[dense.length - 1], dense[dense.length - 1].r, frontStart);
  const firstDir = dirAt(0);
  const backStart = Math.atan2(firstDir.uy, firstDir.ux) - Math.PI / 2; // right 법선각 → CW π(후방 경유) → left 법선각
  const back = capArc(dense[0], dense[0].r, backStart);

  // left 전진 → 전방 반원 → right 역순 → 후방 반원 → 닫힘. 단일 ring.
  return [...left, ...front, ...right.reverse(), ...back, left[0]];
}

/** marker icon → HTML element (MapLibre maplibregl.Marker 의 element). Leaflet divIcon 영역과 동일 로직. */
function buildMarkerEl(m: MapMarker): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cursor = 'pointer';
  if (m.icon === 'typhoon') {
    const size = Math.round(markerPixelSize(m.size ?? 'large', true) * markerDeviceScale()); // 태풍 마커는 크게
    // 색 = 풍속 따라 강도 단계 (windSpeed) 우선, 없으면 AI color / 기본 빨강. 중앙 강도 번호 (1~5).
    const tColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
    el.innerHTML = `<img src="${typhoonSvgUrl(size, tColor, typhoonGradeNum(m.windSpeed))}" width="${size}" height="${size}" style="display:block"/>`;
  } else if (m.icon === 'forecast') {
    // 예상 위치도 현재 위치와 같은 태풍 소용돌이 (현재보다 약간 작게). 밋밋한 원 대신.
    const size = Math.round(markerPixelSize(m.size ?? 'medium', true) * markerDeviceScale());
    const fColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
    el.innerHTML = `<img src="${typhoonSvgUrl(size, fColor, typhoonGradeNum(m.windSpeed))}" width="${size}" height="${size}" style="display:block"/>`;
  } else if (m.icon && MARKER_ICON_EMOJI[m.icon]) {
    // 색 핀(흰 속원 + 이모지) — 지도 위에서 또렷. 끝이 좌표 지점(anchor=bottom). 속원만큼 크게.
    const headW = Math.round(markerPixelSize(m.size ?? 'large', true) * markerDeviceScale());
    const h = Math.round(headW * 1.32);
    el.innerHTML = `<img src="${buildPinSvgUrl(MARKER_ICON_EMOJI[m.icon], headW)}" width="${headW}" height="${h}" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))"/>`;
  } else {
    const color = colorHex(m.color, '#ef4444');
    const size = markerPixelSize(m.size, false);
    el.innerHTML = `<div style="background:${color};border:2px solid white;border-radius:50%;width:${size}px;height:${size}px;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>`;
  }
  return el;
}

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

/** Map popup HTML sanitize — dangerous URL (javascript:/data:/vbscript:) 만 차단, https/http/relative 링크 정상 유지. */
function sanitizePopupHtml(html: string): string {
  if (!html) return '';
  return html.replace(/\b(?:href|src)\s*=\s*["']?\s*(?:javascript|data|vbscript):[^"'>\s]*/gi, 'href="#"');
}

function MapComp({
  markers, circles, lines, cone, legend, center, zoom, height, provider,
}: {
  markers: MapMarker[];
  circles?: MapCircle[] | null;
  lines?: MapLine[] | null;
  cone?: MapCone | MapCone[] | null;
  legend?: MapLegend[] | null;
  center?: { lat: number; lon: number } | null;
  zoom?: number | null;
  height?: string | null;
  provider?: 'auto' | 'leaflet' | 'kakao' | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // cone 은 단일 또는 배열 수용 — 네이버식 태풍 = 크기 cone(강풍반경) + 확률 cone(70%) 2개 겹침.
  const coneArr: MapCone[] = Array.isArray(cone) ? cone : cone ? [cone] : [];
  const safeCones = coneArr.filter(c => c && Array.isArray(c.points) && c.points.length >= 2
    && c.points.every(p => typeof p?.lat === 'number' && typeof p?.lon === 'number' && typeof p?.radius === 'number'));
  const safeMarkers = Array.isArray(markers) ? markers.filter(m => typeof m?.lat === 'number' && typeof m?.lon === 'number') : [];
  const safeCircles = Array.isArray(circles) ? circles.filter(c => typeof c?.lat === 'number' && typeof c?.lon === 'number' && typeof c?.radius === 'number' && c.radius > 0) : [];
  const safeLines = Array.isArray(lines) ? lines.filter(ln => Array.isArray(ln?.points) && ln.points.length >= 2 && ln.points.every(p => typeof p?.lat === 'number' && typeof p?.lon === 'number')) : [];
  const safeLegend = Array.isArray(legend) ? legend.filter(l => l?.color && l?.label) : [];
  // 모바일 320px / PC 480px 캡 + 비율 보호 (작은 폰 50% / 데스크톱 70%).
  const mapMaxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });
  const finalHeight = height || (mapMaxH ? `${mapMaxH}px` : '320px');
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
    // 옛 instance cleanup — StrictMode 두 번 호출 / chat re-render 시 "Map container is already
    // initialized" 차단. Leaflet 가 container 의 `_leaflet_id` 안에 marker 를 남기는데, innerHTML 만
    // clear 하면 그 marker 가 남아 두 번째 init fail. 명시 delete 후 재초기화.
    container.innerHTML = '';
    delete (container as any)._leaflet_id;

    // 지도 canvas resize — chat 메시지로 마운트 시 컨테이너 높이가 늦게 확정되면 canvas 가 위쪽
    // 일부(2/3)만 그려지는 문제 차단. 컨테이너 크기 변화 시 map.resize()/relayout() 재호출.
    let resizeObserver: ResizeObserver | undefined;
    let mapInstance: { remove?: () => void } | undefined;

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
          resizeObserver = new ResizeObserver(() => map.relayout());
          resizeObserver.observe(container);
          // cone (예측 영역) — 경로 + 반경 → 부드러운 polygon. 네이버식 = 크기(강풍) + 확률(70%) 2개 겹침.
          // circles 보다 먼저 (아래 깔림). 색은 각 cone.color (크기 cyan / 확률 indigo).
          for (const cn of safeCones) {
            const coneColor = colorHex(cn.color, '#6366f1');
            // 단일 ring 폴리곤 — 겹침 0 → 투명도 균일. 촘촘 보간 매끈 + 양 끝 둥근. 외곽선 0.
            const ring = coneSinglePolygon(cn.points);
            if (ring.length < 4) continue;
            const path = ring.map(([lon, lat]) => new w.kakao.maps.LatLng(lat, lon));
            new w.kakao.maps.Polygon({
              path,
              strokeWeight: 0,
              strokeOpacity: 0,
              fillColor: coneColor,
              fillOpacity: 0.16,
            }).setMap(map);
          }
          // 반경 원 (circles) = 비태풍 영역(강남 반경 등). 색은 c.color (기본 indigo). 강도색은 마커만.
          for (const c of safeCircles) {
            const cColor = colorHex(c.color, '#6366f1');
            new w.kakao.maps.Circle({
              center: new w.kakao.maps.LatLng(c.lat, c.lon),
              radius: c.radius,
              strokeWeight: 1,
              strokeColor: cColor,
              strokeOpacity: 0.65,
              strokeStyle: c.style === 'solid' ? 'solid' : 'shortdash',
              fillColor: cColor,
              fillOpacity: 0.1,
            }).setMap(map);
          }
          // Polyline (lines) — 태풍 경로 / 항공 경로 / 도보 경로. style=dashed 인 선 = 예상 경로.
          for (const ln of safeLines) {
            const path = ln.points.map(p => new w.kakao.maps.LatLng(p.lat, p.lon));
            new w.kakao.maps.Polyline({
              path,
              // dashed(예상 경로) = cone 선 두께(1)로 통일. solid(실제 이동)는 weight 유지.
              strokeWeight: ln.style === 'dashed' ? 1 : Math.min(ln.weight || 1, 1),
              strokeColor: colorHex(ln.color, '#ef4444'),
              strokeOpacity: 0.8,
              strokeStyle: ln.style === 'dashed' ? 'dash' : 'solid',
            }).setMap(map);
          }
          // 마커 — icon 이 있으면 emoji divIcon (태풍 / 카테고리), 없으면 color svg circle.
          // 클릭 시 항상 우리 popup 표시 (label 또는 m.popup), kakao 기본 place_url javascript:void 링크 회피.
          const makeColorMarkerImage = (color: string, size = 22) => {
            const r = Math.floor(size / 2) - 3;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="${color}" stroke="white" stroke-width="2"/></svg>`;
            const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
            return new w.kakao.maps.MarkerImage(url, new w.kakao.maps.Size(size, size), { offset: new w.kakao.maps.Point(size/2, size/2) });
          };
          const makeEmojiMarkerImage = (emoji: string, headW: number) => {
            // 표준 핀(아래 뾰족 + 둥근 머리)에 이모지. 끝(tip)이 좌표 지점 → offset = (headW/2, h).
            const h = Math.round(headW * 1.32);
            const url = buildPinSvgUrl(emoji, headW);
            return new w.kakao.maps.MarkerImage(url, new w.kakao.maps.Size(headW, h), { offset: new w.kakao.maps.Point(headW / 2, h) });
          };
          const makeDataUriImage = (url: string, size: number) =>
            new w.kakao.maps.MarkerImage(url, new w.kakao.maps.Size(size, size), { offset: new w.kakao.maps.Point(size / 2, size / 2) });
          // 단일 openInfo 추적 — 새 마커 클릭 시 옛 InfoWindow 자동 close. 옛 흐름은 매 마커
          // 별도 InfoWindow + click 시 본인 open 만 → 옛 popup 이 닫히지 않아 누적되던 문제.
          let openInfo: any = null;
          for (const m of safeMarkers) {
            const opts: { position: any; title: string; image?: any } = {
              position: new w.kakao.maps.LatLng(m.lat, m.lon),
              title: m.label,
            };
            // icon 분기 — typhoon = 동심원 SVG (네이버 형태) / forecast = 작은 채워진 원 /
            // current·카테고리 = emoji / 그 외 + color = color circle.
            if (m.icon === 'typhoon') {
              const size = Math.round(markerPixelSize(m.size ?? 'large', true) * markerDeviceScale());
              const tColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
              opts.image = makeDataUriImage(typhoonSvgUrl(size, tColor, typhoonGradeNum(m.windSpeed)), size);
            } else if (m.icon === 'forecast') {
              const size = Math.round(markerPixelSize(m.size ?? 'medium', true) * markerDeviceScale());
              const fColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
              opts.image = makeDataUriImage(typhoonSvgUrl(size, fColor, typhoonGradeNum(m.windSpeed)), size);
            } else if (m.icon && MARKER_ICON_EMOJI[m.icon]) {
              const size = Math.round(markerPixelSize(m.size ?? 'large', true) * markerDeviceScale());
              opts.image = makeEmojiMarkerImage(MARKER_ICON_EMOJI[m.icon], size);
            } else if (m.color) {
              opts.image = makeColorMarkerImage(colorHex(m.color, '#ef4444'), markerPixelSize(m.size, false));
            }
            // icon·color 미지정 — opts.image 비워둠 = 카카오 기본 마커 (빨간 핀). 옛 동작 복원.
            const marker = new w.kakao.maps.Marker(opts);
            marker.setMap(map);
            // popup — m.popup (HTML 그대로) 우선, 없으면 m.label → 우리식 카드 (헤더 + 라벨:값 본문).
            // kakao 기본 InfoWindow 는 wrapping 멀티라인(주소·전화 2~3줄) 콘텐츠의 흰 박스 높이를
            // 잘못 측정해 내용이 박스 밖으로 넘쳤다 → CustomOverlay 로 우리 div 자체를 박스로 렌더해
            // CSS 가 콘텐츠 길이에 맞춰 auto-fit (MapLibre Popup 과 시각 일관).
            const innerHtml = m.popup
              ? `<div style="padding:9px 13px;font-size:12px;line-height:1.5;">${sanitizePopupHtml(m.popup)}</div>`
              : buildPopupCardHtml(m.label);
            if (innerHtml) {
              const box = document.createElement('div');
              box.style.cssText = 'position:relative;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,0.18);max-width:min(280px,calc(100vw - 80px));word-break:break-word;overflow-wrap:anywhere;';
              box.innerHTML = `<button type="button" aria-label="닫기" class="fb-map-popup-x" style="position:absolute;top:2px;right:5px;border:none;background:transparent;font-size:13px;line-height:1;color:#94a3b8;cursor:pointer;padding:4px;z-index:1;">✕</button>${innerHtml}`;
              const overlay = new w.kakao.maps.CustomOverlay({
                position: new w.kakao.maps.LatLng(m.lat, m.lon),
                content: box,
                yAnchor: 1.25,  // 박스 하단이 마커 위쪽에 오도록 (마커 가림 방지)
                zIndex: 5,
                clickable: true,
              });
              const xBtn = box.querySelector('.fb-map-popup-x') as HTMLElement | null;
              if (xBtn) xBtn.addEventListener('click', (e) => { e.stopPropagation(); overlay.setMap(null); });
              w.kakao.maps.event.addListener(marker, 'click', () => {
                if (openInfo && openInfo !== overlay) openInfo.setMap(null);
                overlay.setMap(map);
                openInfo = overlay;
              });
            }
          }
          // 마커 2+ 시 자동 bounds fit — 모든 마커 + 원 + 선 영역 보이도록 줌 자동
          const conePts = safeCones.reduce((a, c) => a + c.points.length, 0);
          if (safeMarkers.length + safeCircles.length + safeLines.length + conePts >= 2) {
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
            for (const ln of safeLines) {
              for (const p of ln.points) bounds.extend(new w.kakao.maps.LatLng(p.lat, p.lon));
            }
            // cone 폭(반경)까지 포함 — 가장자리 안 잘리게.
            for (const cn of safeCones) for (const p of cn.points) {
              const dLat = p.radius / 111000;
              const dLon = p.radius / (111000 * Math.cos(p.lat * Math.PI / 180));
              bounds.extend(new w.kakao.maps.LatLng(p.lat + dLat, p.lon));
              bounds.extend(new w.kakao.maps.LatLng(p.lat - dLat, p.lon));
              bounds.extend(new w.kakao.maps.LatLng(p.lat, p.lon + dLon));
              bounds.extend(new w.kakao.maps.LatLng(p.lat, p.lon - dLon));
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
      // MapLibre GL JS — OpenFreeMap vector tile (한글 라벨 + lang 분기). 옛 Leaflet (CartoDB 래스터,
      // 영어/한자 고정) 대체. 래스터 타일 = 언어 고정 / vector tile = 클라이언트 lang 따라 라벨 렌더.
      // 한국 좌표는 위쪽 Kakao 분기, 그 외 (동아시아 등) 만 본 MapLibre.
      const w = window as any;
      const lang = (typeof document !== 'undefined' && document.documentElement.lang === 'en') ? 'en' : 'ko';
      const initMapLibre = () => {
        const ml = w.maplibregl;
        if (!ml) return;
        const map = new ml.Map({
          container,
          style: 'https://tiles.openfreemap.org/styles/bright',
          center: [finalCenter.lon, finalCenter.lat],
          zoom: Math.max(1, finalZoom - 1),
        });
        mapInstance = map;
        // attribution 항상 ⓘ 접힘 — 생성자 옵션·compact 옵션이 일부 빌드에서 안 먹어 펼쳐진 채 뜨므로,
        // MapLibre 가 쓰는 DOM 클래스(maplibregl-compact)를 직접 부여 + 펼침(-show) 제거. 표기 의무는
        // 유지(ⓘ 클릭 시 보임)하되 평소엔 접힘.
        const collapseAttrib = () => {
          const el = container.querySelector('.maplibregl-ctrl-attrib');
          if (el) { el.classList.add('maplibregl-compact'); el.classList.remove('maplibregl-compact-show'); }
        };
        resizeObserver = new ResizeObserver(() => map.resize());
        resizeObserver.observe(container);
        // +/- 줌 버튼(NavigationControl) 미표시 — 휠/핀치 줌으로 충분, 화면 깔끔하게.
        map.on('load', () => {
          collapseAttrib();
          // lang 분기 — symbol layer text-field = name:{lang} 우선 → name:latin → name (현지어) fallback.
          // 한국어 lang = 동아시아 전역 한글 라벨 (네이버처럼). 영어 lang = name:latin (영문).
          for (const layer of map.getStyle().layers) {
            // 행정·해상 경계선 숨김 — 태풍/날씨 지도에 불필요 + 뱃길로 오인. id 매칭(국경/주경계/분쟁) +
            // 점선(line-dasharray) 라인 전부 숨김 (경계선은 거의 점선, id 가 달라도 dasharray 로 포착).
            if (layer.type === 'line') {
              let dashed = false;
              try { dashed = Array.isArray(map.getPaintProperty(layer.id, 'line-dasharray')); } catch { /* 무시 */ }
              if (dashed || /bound|admin|disput/i.test(layer.id)) {
                try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch { /* 무시 */ }
                continue;
              }
            }
            const lo = layer.layout as Record<string, unknown> | undefined;
            if (layer.type === 'symbol' && lo && 'text-field' in lo) {
              try {
                map.setLayoutProperty(layer.id, 'text-field', [
                  'coalesce',
                  ['get', `name:${lang}`],
                  ['get', 'name:latin'],
                  ['get', 'name'],
                ]);
                // 폰트 weight — 나라명·수도 = Bold(굵게), 일반 지명 = Regular(가늘게). 벡터 glyph 는
                // 숫자 weight(500/600) 미지원 → Noto Sans Regular/Bold 2단계로 분리 (OpenFreeMap 기본 제공).
                const bold = /country|capital/i.test(layer.id);
                map.setLayoutProperty(layer.id, 'text-font', bold ? ['Noto Sans Bold'] : ['Noto Sans Regular']);
              } catch { /* 일부 layer setLayoutProperty 실패 무시 */ }
            }
          }
          // cone (예측 영역) — 경로 + 각 점 반경 → 점점 넓어지는 부드러운 polygon.
          // 네이버식 = 크기(강풍) + 확률(70%) 2개 겹침. 색은 각 cone.color (크기 cyan / 확률 indigo).
          // circles 보다 먼저 그려 아래 깔림.
          safeCones.forEach((cn, ci) => {
            const ring = coneSinglePolygon(cn.points);
            if (ring.length >= 4) {
              const coneColor = colorHex(cn.color, '#6366f1');
              // 단일 ring 폴리곤 — 겹침 0 → 투명도 균일(누적 X). 촘촘 보간이라 매끈 + 양 끝 둥근 마감.
              map.addSource(`fb-cone-${ci}`, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } } });
              map.addLayer({ id: `fb-cone-fill-${ci}`, type: 'fill', source: `fb-cone-${ci}`, paint: { 'fill-color': coneColor, 'fill-opacity': 0.16 } });
            }
          });
          // circles = 비태풍 영역(강남 반경 등). 색은 c.color (기본 indigo). 강도색은 마커만. 점선 [4,3].
          if (safeCircles.length > 0) {
            const features = safeCircles.map(c => ({
              type: 'Feature' as const,
              properties: { color: colorHex(c.color, '#6366f1') },
              geometry: { type: 'Polygon' as const, coordinates: [circlePolygonCoords(c.lat, c.lon, c.radius)] },
            }));
            map.addSource('fb-circles', { type: 'geojson', data: { type: 'FeatureCollection', features } });
            map.addLayer({ id: 'fb-circles-fill', type: 'fill', source: 'fb-circles', paint: { 'fill-color': ['get', 'color'] as any, 'fill-opacity': 0.1 } });
            map.addLayer({ id: 'fb-circles-line', type: 'line', source: 'fb-circles', paint: { 'line-color': ['get', 'color'] as any, 'line-width': 1, 'line-opacity': 0.65, 'line-dasharray': [4, 3] as any } });
          }
          // lines (polyline) — GeoJSON LineString. solid / dashed 2 layer 분리 (paint property = layer 단위).
          if (safeLines.length > 0) {
            const features = safeLines.map(ln => ({
              type: 'Feature' as const,
              // 선 굵기 ≤1 캡 — 가는 경로선 (AI 가 굵게 줘도 강제). cone 경계선처럼 얇게.
              properties: { color: colorHex(ln.color, '#ef4444'), width: Math.min(ln.weight || 1, 1), dashed: ln.style === 'dashed' },
              geometry: { type: 'LineString' as const, coordinates: ln.points.map(p => [p.lon, p.lat]) },
            }));
            map.addSource('fb-lines', { type: 'geojson', data: { type: 'FeatureCollection', features } });
            map.addLayer({ id: 'fb-lines-solid', type: 'line', source: 'fb-lines', filter: ['!', ['get', 'dashed']] as any, paint: { 'line-color': ['get', 'color'] as any, 'line-width': ['get', 'width'] as any, 'line-opacity': 0.85 } });
            map.addLayer({ id: 'fb-lines-dashed', type: 'line', source: 'fb-lines', filter: ['get', 'dashed'] as any, paint: { 'line-color': ['get', 'color'] as any, 'line-width': 1, 'line-opacity': 0.85, 'line-dasharray': [3, 2] as any } });
          }
        });
        // markers — maplibregl.Marker (HTML element). style load 무관 즉시 추가 OK.
        for (const m of safeMarkers) {
          // 카테고리 핀은 anchor=bottom (끝이 좌표 지점). 그 외(태풍 소용돌이·원)는 center.
          const isPin = !!(m.icon && MARKER_ICON_EMOJI[m.icon]);
          const marker = new ml.Marker({ element: buildMarkerEl(m), anchor: isPin ? 'bottom' : 'center' }).setLngLat([m.lon, m.lat]).addTo(map);
          // popup — m.popup (HTML 그대로) 우선, 없으면 m.label → 우리식 카드 (헤더 + 라벨:값 본문).
          const cardHtml = m.popup
            ? `<div style="padding:9px 13px;font-size:12px;line-height:1.5;">${sanitizePopupHtml(m.popup)}</div>`
            : buildPopupCardHtml(m.label);
          if (cardHtml) {
            marker.setPopup(
              new ml.Popup({ offset: 16, closeButton: true, maxWidth: '280px', className: 'firebat-map-popup' }).setHTML(cardHtml)
            );
          }
        }
        // bounds fit — 마커 + 원 + 선 2+ 시 모두 보이도록 자동 줌.
        const conePts = safeCones.reduce((a, c) => a + c.points.length, 0);
        if (safeMarkers.length + safeCircles.length + safeLines.length + conePts >= 2) {
          const bounds = new ml.LngLatBounds();
          for (const m of safeMarkers) bounds.extend([m.lon, m.lat]);
          for (const c of safeCircles) {
            const dLat = c.radius / 111000;
            const dLon = c.radius / (111000 * Math.cos((c.lat * Math.PI) / 180));
            bounds.extend([c.lon + dLon, c.lat + dLat]);
            bounds.extend([c.lon - dLon, c.lat - dLat]);
          }
          for (const ln of safeLines) for (const p of ln.points) bounds.extend([p.lon, p.lat]);
          // cone 은 중심선뿐 아니라 폭(반경)까지 포함해야 가장자리 안 잘림.
          for (const cn of safeCones) for (const p of cn.points) {
            const dLat = p.radius / 111000;
            const dLon = p.radius / (111000 * Math.cos((p.lat * Math.PI) / 180));
            bounds.extend([p.lon + dLon, p.lat + dLat]);
            bounds.extend([p.lon - dLon, p.lat - dLat]);
          }
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 56, maxZoom: 13, duration: 0 });
        }
      };
      // CDN 동적 로드 — maplibre-gl JS + CSS.
      if (w.maplibregl) initMapLibre();
      else {
        const existingCss = document.querySelector(`link[href*="maplibre-gl"]`);
        if (!existingCss) {
          const css = document.createElement('link');
          css.rel = 'stylesheet';
          css.href = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css';
          document.head.appendChild(css);
        }
        const existing = document.querySelector(`script[src*="maplibre-gl.js"]`);
        if (existing) existing.addEventListener('load', initMapLibre);
        else {
          const s = document.createElement('script');
          s.src = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js';
          s.onload = initMapLibre;
          document.head.appendChild(s);
        }
      }
    }
    return () => {
      resizeObserver?.disconnect();
      try { mapInstance?.remove?.(); } catch { /* 이미 해제됨 무시 */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(safeMarkers), JSON.stringify(safeCircles), JSON.stringify(safeLines), finalCenter.lat, finalCenter.lon, finalZoom, provider]);

  return (
    <div
      className="relative isolate rounded-xl border border-gray-100 shadow-sm overflow-hidden"
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
/** CDN script + CSS 동적 로드. 이미 설정되어 있으면 skip. onload 보장. */
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
  // overflow-x-auto + max-w-full — 모바일에서 긴 수식 (양도차익 = 양도가액 − (행사가격 + 행사이익)
  // 같은 다항식 + brace label) 이 화면 너비 초과 시 페이지 레이아웃 깨뜨림 방지. 수식 내부 가로 스크롤로 격리.
  if (block) return <div className="my-3 text-center overflow-x-auto max-w-full" ref={ref as any} />;
  // inline 모드도 같은 보호 (긴 수식 inline 사용 시) — align-bottom 으로 텍스트 baseline 유지.
  return <span ref={ref} className="inline-block max-w-full overflow-x-auto align-bottom" />;
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
  // 모바일 320px / PC 480px 캡 + 비율 보호.
  const slideMaxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });
  const finalHeight = height || (slideMaxH ? `${slideMaxH}px` : '320px');
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
  // 모바일 320px / PC 480px 캡 + 비율 보호.
  const lottieMaxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });
  const finalHeight = height || (lottieMaxH ? `${lottieMaxH}px` : '320px');
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
  // 모바일 320px / PC 480px 캡 + 비율 보호.
  const netMaxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });
  const finalHeight = height || (netMaxH ? `${netMaxH}px` : '320px');
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
