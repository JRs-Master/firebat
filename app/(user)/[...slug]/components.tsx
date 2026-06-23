'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef, useId } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import StockChart from '../../admin/chat-components/StockChart';
import { BlockErrorBoundary } from '../../admin/components/BlockErrorBoundary';
import { useViewportMaxHeight } from '../../../lib/use-viewport-size';
import { usePublicTranslations } from '../../../lib/i18n';
import { apiPost } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';
import { TIME } from '../../../lib/util/time';
import { inlineFormatTagsToMarkdown, maskMath, highlightMarksToHtml, splitFirebatRender, closeStrayScript } from '../../../lib/util/md';
import { loadCdn } from '@/lib/util/load-cdn';
import { CodeComp } from '@/app/components/CodeBlock';

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
        // 블록 하나가 throw 해도 페이지 전체가 죽지 않게 격리 — 그 블록만 inline 에러, 나머지 정상 렌더.
        <BlockErrorBoundary key={i} label={comp?.type}>
          <ComponentSwitch comp={comp} standalone={htmlStandalone} />
        </BlockErrorBoundary>
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
  sentence: 'Sentence', sentence_analysis: 'Sentence', syntax: 'Sentence',
  vocab: 'Vocab', vocabulary: 'Vocab', wordlist: 'Vocab', flashcards: 'Vocab', flashcard: 'Vocab',
  passage: 'Passage', reading: 'Passage', reading_comprehension: 'Passage',
  concept: 'Concept', explainer: 'Concept', lesson: 'Concept',
  listening: 'Listening', lc: 'Listening',
};

function ComponentSwitch({ comp, standalone }: { comp: ComponentDef; standalone?: boolean }) {
  const { type: rawType, props = {} } = comp;
  const p = props as any;
  const type = TYPE_ALIAS[(rawType || '').toLowerCase()] ?? rawType;

  switch (type) {
    case 'Header':        return <HeaderComp text={p.text ?? ''} level={p.level} align={p.align} />;
    case 'Text':          return <TextComp content={p.content ?? ''} />;
    case 'Image':         return <ImageComp src={p.src ?? ''} alt={p.alt} width={p.width} height={p.height} variants={p.variants} blurhash={p.blurhash} thumbnailUrl={p.thumbnailUrl} />;
    case 'Form':          return <FormComp bindModule={p.bindModule} inputs={p.inputs ?? p.fields ?? []} submitText={p.submitText ?? p.submitLabel} />;
    case 'ResultDisplay': return null;
    case 'Button':        return <ButtonComp text={p.text ?? p.label ?? p.title ?? ''} href={p.href} variant={p.variant} />;
    case 'Divider':       return <DividerComp />;
    case 'Table':         return <TableComp headers={p.headers ?? []} rows={p.rows ?? []} stickyCol={p.stickyCol} striped={p.striped} align={p.align} cellAlign={p.cellAlign} filterable={p.filterable ?? p.searchable} columnToggle={p.columnToggle ?? p.columnSelect} sortable={p.sortable ?? p.sort} />;
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
    case 'Chart': {
      // 동의어 흡수 — 발행 페이지는 Rust sanitize(synonyms)를 안 거치므로 여기서 chartType←type /
      // data←values / series←datasets 를 직접 받아 components.json 의 선언 동의어를 발행에서도 보장.
      const ct = p.chartType ?? p.type;
      return <ChartComp type={(ct === 'donut' ? 'doughnut' : ct) ?? 'bar'} data={p.data ?? p.values ?? []} labels={p.labels ?? []} series={p.series ?? p.datasets} title={p.title} subtitle={p.subtitle} unit={p.unit} color={p.color} negColor={p.negColor} palette={p.palette} showValues={p.showValues} showPct={p.showPct} />;
    }
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
    case 'Quiz':
      // AI 가 quiz(단일)에 questions 배열(복수)을 넣으면 quiz_group 으로 위임 — quiz=단일/quiz_group=복수
      // 혼동 흡수(QuizComp 는 questions 를 무시해 빈 박스가 됐던 root). single question 은 그대로 QuizComp.
      if (Array.isArray(p.questions) && p.questions.length > 0)
        return <QuizGroupComp passage={p.passage} boxes={p.boxes} figures={p.figures} questions={p.questions} type={p.type ?? p.format} marker={p.marker} view={p.view} />;
      return <QuizComp number={p.number} points={p.points} question={p.question ?? ''} boxes={p.boxes} figures={p.figures} statements={p.statements} choices={p.choices ?? p.options ?? []} answer={p.answer} answerIndex={p.answerIndex ?? p.correctIndex} explanation={p.explanation} type={p.type ?? p.format ?? p.quizType} marker={p.marker} view={p.view} />;
    case 'QuizGroup':     return <QuizGroupComp passage={p.passage} boxes={p.boxes} figures={p.figures} questions={p.questions ?? p.quizzes ?? p.items ?? []} type={p.type ?? p.format} marker={p.marker} view={p.view} />;
    case 'Sentence':      return <SentenceComp sentence={p.sentence ?? p.original ?? p.text ?? p.english ?? p.eng} tokens={p.tokens ?? p.chunks} pattern={p.pattern} translation={p.translation} notes={p.notes ?? p.grammar ?? p.points ?? p.note ?? p.analysis} vocab={p.vocab ?? p.words} groups={p.groups ?? p.structure ?? p.phrases} />;
    case 'Vocab':         return <VocabComp title={p.title} words={p.words ?? p.vocabulary ?? p.wordList ?? p.items ?? p.cards ?? []} mode={p.mode} />;
    case 'Passage':       return <PassageComp title={p.title} paragraphs={p.paragraphs ?? p.text ?? p.body ?? p.content} vocab={p.vocab ?? p.words} keyIdea={p.keyIdea ?? p.thesis ?? p.mainIdea} translation={p.translation ?? p.trans} />;
    case 'Concept':       return <ConceptComp title={p.title} intro={p.intro ?? p.overview ?? p.summary} steps={p.steps ?? p.sections ?? p.parts ?? []} example={p.example} misconception={p.misconception} check={p.check} />;
    case 'Listening':     return <ListeningComp title={p.title} audioUrl={p.audioUrl ?? p.audio ?? p.url} image={p.image ?? p.photo ?? p.imageUrl} script={p.script ?? p.transcript ?? p.lines} questions={p.questions ?? p.quizzes ?? p.items ?? []} browserTts={p.browserTts ?? p.browser} mode={p.mode ?? p.kind} view={p.view} />;
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
// 보기 마커 세트 — 시험·언어별로 ABC / ㄱㄴㄷ / 가나다 / 숫자 등 다양(경우의 수 많음). AI 가 marker 로
// 스타일명·명시 배열을 지정하거나, listening 은 script 라벨에서 자동 감지. 기본 = 숫자(①②③).
const MARKER_SETS: Record<string, string[]> = {
  number: QUIZ_CIRCLED,
  alpha: ['Ⓐ', 'Ⓑ', 'Ⓒ', 'Ⓓ', 'Ⓔ', 'Ⓕ', 'Ⓖ', 'Ⓗ'],
  kor: ['㉠', '㉡', '㉢', '㉣', '㉤', '㉥', '㉦', '㉧'],
  ganada: ['㉮', '㉯', '㉰', '㉱', '㉲', '㉳', '㉴', '㉵'],
};
// 별칭(AI 자연 표기 흡수) → 정규 스타일명.
const MARKER_ALIAS: Record<string, string> = {
  letter: 'alpha', abc: 'alpha', alphabet: 'alpha',
  consonant: 'kor', hangul: 'kor',
  syllable: 'ganada', korean: 'ganada',
  num: 'number', digit: 'number', numeric: 'number',
};
// marker prop(스타일명 | 명시 배열) → 마커 배열. 배열이면 그대로, 문자열이면 세트/별칭 lookup.
const markerSet = (marker?: string | string[]): string[] => {
  if (Array.isArray(marker) && marker.length) return marker;
  const key = typeof marker === 'string' ? (MARKER_ALIAS[marker.toLowerCase()] ?? marker.toLowerCase()) : '';
  return MARKER_SETS[key] ?? MARKER_SETS.number;
};
// script 줄 라벨("(A) ...", "(가) ...", "(ㄱ) ...", "(1) ...")에서 보기 스타일 자동 감지.
// 스크립트가 A/B/C 면 보기도 Ⓐ Ⓑ Ⓒ 로 일치(숫자 ①②③ 와 어긋남 방지). 미감지 시 숫자(수능 듣기 등).
const detectMarkerStyle = (lines: Array<{ text?: string; line?: string }>): string | undefined => {
  for (const ln of lines) {
    const m = /^\s*\(?\s*([A-Za-z]|[ㄱ-ㅎ]|[가-힣]|\d+)\s*[).]/u.exec(String(ln?.text ?? ln?.line ?? ''));
    if (!m) continue;
    const ch = m[1];
    if (/^[A-Za-z]$/.test(ch)) return 'alpha';
    if (/^[ㄱ-ㅎ]$/.test(ch)) return 'kor';
    if (/^[가-힣]$/.test(ch)) return 'ganada';
    if (/^\d+$/.test(ch)) return 'number';
  }
  return undefined;
};
type QuizView = 'exam' | 'answers' | 'full' | 'interactive';

// 컴포넌트가 QUIZ_CIRCLED 로 보기 번호(①②③)를 자동 부여하므로, AI 가 choice 텍스트에 또 넣은
// 앞쪽 마커(원문자 ①~⑩ / "1." / "1)")를 제거해 "① ① form" 식 중복 표시를 막는다.
const stripChoiceMarker = (s: any): string => {
  // choice 가 string 이 아닐 수 있음(AI 가 {text}/{label}/{en} 객체나 숫자로 보냄) → 안전 추출 후 처리.
  const str = typeof s === 'string' ? s : (s?.text ?? s?.label ?? s?.en ?? (s == null ? '' : String(s)));
  return String(str).replace(/^\s*(?:[①-⑩Ⓐ-Ⓩ㉠-㉧㉮-㉵]|\(?(?:[A-Za-z]|[ㄱ-ㅎ]|[가-힣]|\d+)[).])\s*/u, '');
};

// 정답 정규화 — AI 는 answer·answerIndex 둘 다 0-based(choices 인덱스, 첫 보기=0)로 보낸다(실측 2건:
// answerIndex 3=④, answer 1=②). 내부 ans 는 1-based(보기 번호 = i+1)라 +1 환산. 먼저 온 값 사용.
const quizAns = (answer?: number, answerIndex?: number): number | undefined => {
  const idx = typeof answer === 'number' ? answer : typeof answerIndex === 'number' ? answerIndex : undefined;
  return idx === undefined ? undefined : idx + 1;
};

// OX(일치/불일치) / TFNG(True·False·Not Given) 모드 — 라벨 + 정답 인덱스(1-based).
// answer 가 'O'/'X'/true/false/'T'/'F'/'NG'/숫자 등 다양하게 와도 흡수(하드코딩 회피, 폭넓게 수용).
function oxConfig(type?: string, answer?: number | string, answerIndex?: number): { labels: string[]; ans?: number } | null {
  const t = (type || '').toLowerCase().replace(/[\s_-]/g, '');
  let labels: string[] | null = null;
  if (t === 'ox' || t === 'tf' || t === 'truefalse' || t === 'oux') labels = ['O', 'X'];
  else if (t === 'tfng' || t === 'tfn' || t === 'truefalsenotgiven') labels = ['True', 'False', 'Not Given'];
  if (!labels) return null;
  const raw = answer ?? answerIndex;
  let ans: number | undefined;
  if (typeof raw === 'number') ans = raw + 1; // 0-based → 1-based
  else if (typeof raw === 'boolean') ans = raw ? 1 : 2;
  else if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (labels.length === 2) {
      if (['o', 'true', 't', 'yes', 'y', '참', '맞음', '일치', '○', 'ㅇ'].includes(s)) ans = 1;
      else if (['x', 'false', 'f', 'no', 'n', '거짓', '틀림', '불일치'].includes(s)) ans = 2;
    } else {
      if (['true', 't', '참', '일치'].includes(s)) ans = 1;
      else if (['false', 'f', '거짓', '불일치'].includes(s)) ans = 2;
      else if (['ng', 'notgiven', '언급없음', 'na', 'n'].includes(s.replace(/[\s/]/g, ''))) ans = 3;
    }
  }
  return { labels, ans };
}

/** 단일 문항 본문 — controlled (selected/revealed/onSelect). quiz 단독 + quiz_group 의 각 문항 공용. */
// 시험지/해설지 미색지 종이 질감 — SVG fractalNoise 를 아주 옅게(미색 위 미세 그레인).
// 배경 색은 className(bg-[#faf8f0])이, 그레인은 이 backgroundImage 가 담당(겹침).
// 종이 질감 — fractalNoise 를 grayscale(saturate 0)로 변환해 회색 그레인(컬러 노이즈 방지) +
// opacity 0.16 으로 "느껴지게"(옛 0.05 는 거의 안 보였음). 촘촘한 그레인(octaves 4).
const PAPER_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23p)' opacity='0.16'/%3E%3C/svg%3E\")";
const PAPER_STYLE = { backgroundImage: PAPER_NOISE } as const;

function QuizBody({
  number, question, boxes, figures, statements, choices, answer, answerIndex, explanation, type,
  view, selected, revealed, onSelect, marker,
}: {
  number?: number | string; question: string; boxes?: string[]; figures?: ComponentDef[];
  statements?: string[]; choices: string[]; answer?: number | string; answerIndex?: number; explanation?: string; type?: string;
  view: QuizView; selected?: number; revealed: boolean; onSelect?: (i: number) => void; marker?: string | string[];
}) {
  const showAnswer = view === 'answers' || view === 'full' || (view === 'interactive' && revealed);
  const interactive = view === 'interactive';
  const ox = oxConfig(type, answer, answerIndex); // OX/TFNG 모드면 라벨+정답, 아니면 null
  const ans = ox ? ox.ans : quizAns(typeof answer === 'number' ? answer : undefined, answerIndex); // 1-based
  const numLabel = number == null ? '' : typeof number === 'number' ? `${number}.` : String(number);
  const marks = markerSet(marker); // 보기 마커(①②③ / ⒶⒷⒸ / ㉠㉡㉢ / ㉮㉯㉰) — marker prop 따라.
  return (
    <div style={PAPER_STYLE} className="rounded-xl border border-[#e9e2d0] bg-[#faf8f0] px-4 py-3.5 sm:px-5 sm:py-4 text-[14px] sm:text-[15px] text-slate-800 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {view === 'answers' ? (
        number != null && <div className="text-[12px] font-bold text-slate-500 mb-1">{typeof number === 'number' ? `${number}번` : String(number)}</div>
      ) : (
        <div className="font-semibold mb-3 text-[15px] sm:text-[16px] leading-snug">
          {numLabel && <span className="mr-1.5">{numLabel}</span>}
          <InlineMd text={question} />
        </div>
      )}
      {view !== 'answers' && (boxes ?? []).map((b, i) => (
        <div key={`b-${i}`} className="border border-[#d9cdae] rounded-md p-3 my-2 text-[13px] sm:text-[14px] leading-relaxed">
          <TextComp content={b} />
        </div>
      ))}
      {view !== 'answers' && figures && figures.length > 0 && (
        <div className="my-2"><ComponentRenderer components={figures} /></div>
      )}
      {view !== 'answers' && statements && statements.length > 0 && (
        <div className="border border-[#d9cdae] rounded-md p-3 my-2 flex flex-col gap-1 text-[13px] sm:text-[14px]">
          {statements.map((s, i) => (
            <div key={`s-${i}`} className="flex gap-1.5">
              <span className="font-bold shrink-0">{QUIZ_KOR[i] ?? `${i + 1}`}.</span>
              <span className="flex-1"><InlineMd text={s} /></span>
            </div>
          ))}
        </div>
      )}
      {view !== 'answers' && ox && (
        <div className={`grid gap-2 my-3 ${ox.labels.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {ox.labels.map((label, i) => {
            const num = i + 1;
            const isAns = ans === num;
            const isSel = selected === num;
            let cls = 'border-slate-200 text-slate-700';
            if (showAnswer && isAns) cls = 'border-green-500 bg-green-50 text-green-800 font-bold';
            else if (showAnswer && isSel && !isAns) cls = 'border-red-400 bg-red-50 text-red-700';
            else if (interactive && isSel && !revealed) cls = 'border-blue-500 bg-blue-50 text-blue-700 font-semibold';
            else if (interactive && !revealed) cls = 'hover:bg-slate-50';
            return (
              <button key={`ox-${i}`} type="button" disabled={!interactive || revealed} onClick={() => onSelect?.(num)}
                className={`px-3 py-3 rounded-lg border font-semibold text-[15px] transition-colors flex items-center justify-center gap-1.5 ${cls} ${interactive && !revealed ? 'cursor-pointer hover:border-slate-300' : 'cursor-default'}`}>
                <span>{label}</span>
                {showAnswer && isAns && <span className="text-green-600">✓</span>}
                {showAnswer && isSel && !isAns && <span className="text-red-500">✗</span>}
              </button>
            );
          })}
        </div>
      )}
      {view !== 'answers' && !ox && (
        <div className="flex flex-col gap-2 my-3">
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
                className={`text-left flex gap-2.5 items-start px-3.5 py-2.5 rounded-lg border transition-colors ${cls} ${interactive && !revealed ? 'cursor-pointer hover:border-slate-300' : 'cursor-default'}`}
              >
                <span className="shrink-0">{marks[i] ?? `${num}.`}</span>
                <span className="flex-1"><InlineMd text={stripChoiceMarker(c)} /></span>
                {showAnswer && isAns && <span className="text-green-600 shrink-0">✓</span>}
                {showAnswer && isSel && !isAns && <span className="text-red-500 shrink-0">✗</span>}
              </button>
            );
          })}
        </div>
      )}
      {showAnswer && (
        <div className="mt-3.5">
          {ans != null && <div className="text-[13px] font-bold text-green-700 mb-2">정답: {ox ? (ox.labels[ans - 1] ?? ans) : (marks[ans - 1] ?? ans)}</div>}
          {explanation && (
            <div className="rounded-lg border border-[#d9cdae] p-3 sm:p-3.5">
              <div className="text-[11px] font-bold text-indigo-500 tracking-wide mb-1.5">해설</div>
              <div className="text-[13px] sm:text-[14px] text-slate-700 leading-relaxed">
                <TextComp content={explanation} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sentence (영어 문장 구조 분석 — 문제집 해설 스타일) ────────────────────────
// 토큰별 문법 역할(S/V/O/C/M)을 색 밑줄 + 태그로 표시 + 범례 + 해석 + 문법 노트.
// 보라색은 반사적 기본 회피([[feedback_no_purple_default]]) — 보어(C)는 amber.
const SENT_ROLE: Record<string, { ko: string; border: string; tag: string }> = {
  S: { ko: '주어', border: 'border-blue-400', tag: 'bg-blue-50 text-blue-600' },
  V: { ko: '동사', border: 'border-rose-400', tag: 'bg-rose-50 text-rose-600' },
  O: { ko: '목적어', border: 'border-emerald-400', tag: 'bg-emerald-50 text-emerald-600' },
  C: { ko: '보어', border: 'border-amber-400', tag: 'bg-amber-50 text-amber-600' },
  M: { ko: '수식어', border: 'border-slate-300', tag: 'bg-slate-100 text-slate-500' },
  ADV: { ko: '부사어', border: 'border-cyan-400', tag: 'bg-cyan-50 text-cyan-600' },
};
// AI 가 mod/modifier/adverbial/subject 등 다양한 표기로 보내도 canonical(S/V/O/C/M/ADV)로 흡수.
const ROLE_ALIAS: Record<string, string> = {
  SUBJECT: 'S', VERB: 'V', PREDICATE: 'V', OBJECT: 'O', OBJ: 'O', COMPLEMENT: 'C', COMP: 'C',
  MOD: 'M', MODIFIER: 'M', ADJ: 'M', ADJECTIVE: 'M', ADVERBIAL: 'ADV', ADVERB: 'ADV', A: 'ADV',
};
const canonRole = (raw?: string): string => {
  const u = (raw || '').toUpperCase();
  return ROLE_ALIAS[u] ?? u;
};

// SVO 문장 구조 — 천일문식 끊어읽기. 성분을 탭하면 역할(S/V/O/C/M)·직독직해(gloss)가 공개,
// 가렸을 땐 점선 밑줄 + "?"(직접 맞혀보기). "모두 보기/가리기" 토글로 한 번에(역할+뜻). 역할 없는 단어는 평문.
function SvoTokens({ tokens }: { tokens: Array<{ text: string; role?: string; gloss?: string; form?: string }> }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const revealable = tokens
    .map((t, i) => ({ i, ok: !!SENT_ROLE[canonRole(t.role)] || !!t.gloss }))
    .filter((x) => x.ok);
  const allShown = revealable.length > 0 && revealable.every((x) => shown.has(x.i));
  const toggleAll = () => setShown(allShown ? new Set() : new Set(revealable.map((x) => x.i)));
  const toggleOne = (i: number) =>
    setShown((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const usedRoles = [...new Set(
    tokens.filter((_, i) => shown.has(i)).map((t) => canonRole(t.role)).filter((r) => SENT_ROLE[r]),
  )];
  return (
    <div>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-3 text-[16px] sm:text-[17px] leading-none">
        {tokens.map((t, i) => {
          const role = canonRole(t.role);
          const r = SENT_ROLE[role];
          const canReveal = !!r || !!t.gloss;
          const open = shown.has(i) || !canReveal;
          return (
            <button
              key={i}
              type="button"
              disabled={!canReveal}
              onClick={() => toggleOne(i)}
              className={`inline-flex flex-col items-center gap-1 ${canReveal ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span className={r ? `border-b-2 pb-0.5 text-slate-800 ${open ? r.border : 'border-dashed border-slate-300'}` : 'text-slate-800'}>{t.text}</span>
              {/* 공개↔가림은 *색만* 토글 — 박스(px·rounded·min-w·leading) 동일 = 탭 시 세로/가로 흔들림 0.
                  엘리먼트 교체(ternary 로 다른 span) 대신 단일 span 색 토글이라 박스 변화가 없다. */}
              {r && (
                <span className={`text-[10px] font-bold px-1 rounded leading-none inline-block min-w-[1.4rem] text-center whitespace-nowrap ${open ? r.tag : 'bg-slate-100 text-slate-400'}`}>{open ? (t.form ? `${role} (${t.form})` : role) : '?'}</span>
              )}
              {t.gloss && (
                <span className={`text-[11px] leading-tight px-1 rounded ${open ? 'text-slate-600' : 'bg-[#e9e0c8] text-transparent select-none'}`}>{t.gloss}</span>
              )}
            </button>
          );
        })}
      </div>
      {revealable.length > 0 && (
        <div className="flex items-center justify-between gap-2 mt-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] min-h-[18px]">
            {usedRoles.length > 0
              ? usedRoles.map((r) => (
                  <span key={r} className={`px-1.5 py-0.5 leading-none rounded font-medium ${SENT_ROLE[r].tag}`}>{r} · {SENT_ROLE[r].ko}</span>
                ))
              : <span className="text-slate-400">성분을 탭해 역할·뜻을 확인하세요</span>}
          </div>
          <button type="button" onClick={toggleAll} className="shrink-0 text-[11px] font-semibold text-slate-500 hover:text-indigo-600 transition-colors">
            {allShown ? '가리기' : '모두 보기'}
          </button>
        </div>
      )}
    </div>
  );
}

// 단어 암기 — 인터랙티브 플래시카드. 의미는 미색 redaction 바로 가려두고(외우기), 탭하면 공개.
// "모두 보기/가리기" 토글. 기본 = 전부 가림(암기 모드).
function VocabList({ items }: { items: Array<{ word: string; meaning: string; pos?: string }> }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const allShown = items.length > 0 && shown.size === items.length;
  const toggleAll = () => setShown(allShown ? new Set() : new Set(items.map((_, i) => i)));
  const toggleOne = (i: number) =>
    setShown((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <div className="mt-3.5 rounded-lg border border-[#d9cdae] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-bold text-indigo-500">단어 암기</div>
        <button type="button" onClick={toggleAll} className="text-[11px] font-semibold text-slate-500 hover:text-indigo-600 transition-colors">
          {allShown ? '의미 가리기' : '모두 보기'}
        </button>
      </div>
      <ul className="flex flex-col divide-y divide-[#e6ddc6]">
        {items.map((w, i) => {
          const open = shown.has(i);
          return (
            <li key={i} className="flex items-baseline gap-3 py-1.5 first:pt-0 last:pb-0">
              <span className="font-semibold text-slate-800 text-[14px] sm:text-[15px] shrink-0">{w.word}</span>
              <button
                type="button"
                onClick={() => toggleOne(i)}
                title={open ? '탭하여 가리기' : '탭하여 의미 보기'}
                className={`flex-1 text-left text-[13px] sm:text-[14px] rounded px-1.5 transition-colors ${open ? 'text-slate-600 cursor-pointer' : 'bg-[#e9e0c8] text-transparent hover:bg-[#e2d6b8] cursor-pointer select-none'}`}
              >
                {open
                  ? <span>{w.pos && <span className="text-indigo-400 font-medium">{w.pos} </span>}<InlineMd text={w.meaning} /></span>
                  : <span className="opacity-0">{w.pos ? `${w.pos} ` : ''}{w.meaning || '•••'}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Vocab (어휘 암기) — 인출연습(active recall) + 세션 내 Leitner 적응형 간격 ──────────
// 근거: 시험효과(Roediger·Karpicke) 가림→인출→공개 / Leitner 틀린건 곧 재등장·외운건 뒤로 /
// 양방향(영↔한, 산출=generation effect) / 정교화(예문 맥락·니모닉·어원=Craik·Lockhart 처리수준) /
// 메타인지 자가평가 / 음운 부호화(브라우저 TTS) / 이중부호화(이미지, Paivio).
// 세션 간 SRS·진도 추적은 앱 몫 — 컴포넌트는 stateless(한 세션 안에서만 적응).
type VocabWord = {
  word: string; meaning: string; pos?: string | null; pronunciation?: string | null;
  example?: string | null; exampleMeaning?: string | null; mnemonic?: string | null;
  etymology?: string | null; synonyms?: string[] | null; antonyms?: string[] | null; image?: string | null;
};
const VOCAB_MASTER = 2; // 연속 정답 N회 = 외움(큐에서 제거)

function speakWord(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.9;
    synth.speak(u);
  } catch { /* TTS 미지원 = 무시 */ }
}

// 예문 안 표제어(+활용형) 강조 — 맥락 속 학습
function highlightWord(text: string, word: string): React.ReactNode {
  if (!word) return text;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.split(new RegExp(`(${esc}\\w*)`, 'gi')).map((p, i) =>
    p.toLowerCase().startsWith(word.toLowerCase())
      ? <strong key={i} className="text-blue-700 font-bold">{p}</strong>
      : <span key={i}>{p}</span>);
}

// 🔊 발음 (브라우저 TTS) — 음운 부호화
function SpeakBtn({ word }: { word: string }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); speakWord(word); (e.currentTarget as HTMLButtonElement).blur(); }}
      title="발음 듣기" aria-label="발음 듣기"
      className="inline-flex items-center justify-center w-6 h-6 rounded-full text-slate-400 transition-colors shrink-0 active:text-blue-700 hover-blue">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" /></svg>
    </button>
  );
}

// 공개 시 정교화 레이어 — 예문(맥락)·니모닉(암기 고리)·어원·유의어/반의어·이미지(이중부호화)
function WordReveal({ w }: { w: VocabWord }) {
  const syn = Array.isArray(w.synonyms) ? w.synonyms.filter(Boolean) : [];
  const ant = Array.isArray(w.antonyms) ? w.antonyms.filter(Boolean) : [];
  if (!w.example && !w.mnemonic && !w.etymology && !syn.length && !ant.length && !w.image) return null;
  return (
    <div className="mt-3 space-y-2 text-left text-[13px] sm:text-[14px]">
      {w.image && <img src={w.image} alt={w.word} loading="lazy" className="max-h-40 rounded-lg border border-[#e9e2d0] mx-auto" />}
      {w.example && (
        <div className="rounded-lg bg-[#f3eedd] px-3 py-2">
          <div className="text-slate-800 leading-relaxed">{highlightWord(w.example, w.word)}</div>
          {w.exampleMeaning && <div className="text-slate-500 text-[12px] sm:text-[13px] mt-1"><InlineMd text={w.exampleMeaning} /></div>}
        </div>
      )}
      {w.mnemonic && (
        <div className="flex items-start gap-1.5 text-slate-700">
          <span className="shrink-0">💡</span>
          <span><span className="font-semibold text-amber-700">암기 </span><InlineMd text={w.mnemonic} /></span>
        </div>
      )}
      {w.etymology && (
        <div className="flex items-start gap-1.5 text-slate-600">
          <span className="font-semibold text-indigo-500 shrink-0 text-[12px] mt-0.5">어원</span>
          <span><InlineMd text={w.etymology} /></span>
        </div>
      )}
      {(syn.length > 0 || ant.length > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] sm:text-[13px]">
          {syn.length > 0 && <div><span className="font-semibold text-emerald-600">유의어 </span><span className="text-slate-600">{syn.join(', ')}</span></div>}
          {ant.length > 0 && <div><span className="font-semibold text-rose-500">반의어 </span><span className="text-slate-600">{ant.join(', ')}</span></div>}
        </div>
      )}
    </div>
  );
}

// 플래시카드 엔진 — 인출 + 세션 내 Leitner(틀린건 곧·외운건 뒤로) + 양방향 + 자가평가
function VocabFlashcard({ list }: { list: VocabWord[] }) {
  const [dir, setDir] = useState<'en2ko' | 'ko2en'>('en2ko');
  const [boxes, setBoxes] = useState<number[]>(() => list.map(() => 0));
  const [queue, setQueue] = useState<number[]>(() => list.map((_, i) => i));
  const [revealed, setRevealed] = useState(false);
  // 차트·지도·슬라이드쇼와 동일한 세로 cap (모바일 320 / PC 480) — 비주얼 블록 높이 통일
  const cardH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });

  const total = list.length;
  const mastered = boxes.filter((b) => b >= VOCAB_MASTER).length;
  const curIdx = queue[0];
  const cur = curIdx != null ? list[curIdx] : null;

  const grade = (g: 'again' | 'hard' | 'good') => {
    if (curIdx == null) return;
    const willMaster = g === 'good' && boxes[curIdx] + 1 >= VOCAB_MASTER;
    setBoxes((prev) => {
      const nb = [...prev];
      nb[curIdx] = g === 'good' ? Math.min(VOCAB_MASTER, nb[curIdx] + 1) : g === 'again' ? 0 : nb[curIdx];
      return nb;
    });
    setQueue((prev) => {
      const [head, ...rest] = prev;
      if (head == null) return prev;
      if (willMaster) return rest;
      // again=곧 다시(2번째 뒤) / hard=중간 / good=맨 뒤 → 확장 인출(expanding retrieval)
      const pos = g === 'again' ? 2 : g === 'hard' ? Math.ceil(rest.length / 2) : rest.length;
      const nq = [...rest];
      nq.splice(Math.min(pos, nq.length), 0, head);
      return nq;
    });
    setRevealed(false);
  };

  const switchDir = () => { setDir((d) => (d === 'en2ko' ? 'ko2en' : 'en2ko')); setRevealed(false); };
  const shuffle = () => {
    setQueue((q) => { const a = [...q]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; });
    setRevealed(false);
  };
  const reset = () => { setBoxes(list.map(() => 0)); setQueue(list.map((_, i) => i)); setRevealed(false); };
  // 키보드 단축키 = 전체화면 study 모드 구현 후 거기서 활성(인라인 채팅선 포커스 마찰 커서 보류). 복원용 보존.
  /* const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (!revealed) {
      if (k === ' ' || k === 'Enter' || k === 'ArrowDown') { e.preventDefault(); setRevealed(true); }
      return;
    }
    // 공개 후: Space/Enter/→ = 외움(good, Anki식 공개→외움 연타) / ← 모름 / ↑ 애매. 전부 preventDefault(스크롤 차단).
    if (k === ' ' || k === 'Enter' || k === 'ArrowRight' || k === '3') { e.preventDefault(); grade('good'); }
    else if (k === 'ArrowLeft' || k === '1') { e.preventDefault(); grade('again'); }
    else if (k === 'ArrowUp' || k === '2') { e.preventDefault(); grade('hard'); }
  }; */

  if (!cur) {
    return (
      <div className="text-center py-8">
        <div className="text-3xl mb-2">🎉</div>
        <div className="font-bold text-slate-800 mb-1">{total}개 단어 다 외웠어요</div>
        <div className="text-[13px] text-slate-500 mb-4">며칠 뒤 다시 인출하면 장기기억으로 굳어집니다</div>
        <button type="button" onClick={reset} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-[13px] font-semibold hover:bg-blue-700 transition-colors">다시 외우기</button>
      </div>
    );
  }

  const front = dir === 'en2ko' ? cur.word : cur.meaning;
  const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 h-1.5 rounded-full bg-[#e6ddc6] overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[11px] font-semibold text-slate-500 shrink-0">{mastered}/{total} 외움 · {queue.length} 남음</span>
      </div>

      {/* 고정 높이 + 내부 스크롤 — 카드 크기 점프 방지 + 채점 버튼이 항상 같은 자리(인출 리듬) */}
      <div
        onClick={() => !revealed && setRevealed(true)}
        style={{ height: cardH ? `${cardH}px` : '320px' }}
        className={`rounded-xl border border-[#e9e2d0] bg-white flex flex-col overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${!revealed ? 'cursor-pointer hover:border-blue-200' : ''}`}
      >
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-hide">
          <div className="min-h-full flex flex-col items-center justify-center text-center px-5 py-5">
            {/* 앞면 — pos 없음(떠올릴 때 힌트 X) */}
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <span className="text-[22px] sm:text-[26px] font-bold text-slate-800">{front}</span>
              {dir === 'en2ko' && <SpeakBtn word={cur.word} />}
            </div>
            {dir === 'en2ko' && cur.pronunciation && <div className="text-[13px] text-slate-400 mt-1">{cur.pronunciation}</div>}

            {!revealed ? (
              <div className="mt-5 text-[13px] text-slate-400">{dir === 'en2ko' ? '뜻은? · 탭하여 확인' : '영단어는? · 탭하여 확인'}</div>
            ) : (
              <div className="mt-4 w-full">
                {/* pos 는 항상 정답(공개)면에 — en→ko: 'n. 뜻' / ko→en: 'v. word' */}
                <div className="flex items-center justify-center gap-1.5 flex-wrap pt-3 border-t border-[#eee6d2]">
                  {dir === 'ko2en' && <SpeakBtn word={cur.word} />}
                  {cur.pos && <span className="text-[13px] text-indigo-400 font-medium">{cur.pos}</span>}
                  <span className="text-[18px] sm:text-[20px] font-bold text-blue-700">{dir === 'en2ko' ? cur.meaning : cur.word}</span>
                  {dir === 'ko2en' && cur.pronunciation && <span className="text-[12px] text-slate-400">{cur.pronunciation}</span>}
                </div>
                <WordReveal w={cur} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 버튼 영역 높이 고정 — 공개 시 채점 버튼이 컨트롤보다 커서 아래가 점프하던 것 방지(min-h reserve) */}
      <div className="mt-3 h-[46px]">
        {revealed ? (
          <div className="grid grid-cols-3 gap-2 h-full">
            <button type="button" onClick={() => grade('again')} className="h-full flex items-center justify-center rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-[13px] font-semibold hover:bg-rose-100 transition-colors">모름</button>
            <button type="button" onClick={() => grade('hard')} className="h-full flex items-center justify-center rounded-lg bg-amber-50 text-amber-700 border border-amber-200 text-[13px] font-semibold hover:bg-amber-100 transition-colors">애매</button>
            <button type="button" onClick={() => grade('good')} className="h-full flex items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-[13px] font-semibold hover:bg-emerald-100 transition-colors">외움</button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-4 h-full text-[12px] text-slate-500">
            <button type="button" onClick={switchDir} className="hover-blue transition-colors font-medium">{dir === 'en2ko' ? '영→한' : '한→영'} 전환</button>
            <button type="button" onClick={shuffle} className="hover-blue transition-colors font-medium">섞기</button>
            <button type="button" onClick={reset} className="hover-blue transition-colors font-medium">처음부터</button>
          </div>
        )}
      </div>
      {/* 키보드 힌트 = 전체화면 study 모드 구현 후 복원 (Space/↓ 공개 · ← 모름 · ↑ 애매 · → 외움) */}
    </div>
  );
}

// 목록 보기 — 빠른 복습/훑기 (각 행 탭 공개 + 정교화)
function VocabListView({ list }: { list: VocabWord[] }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const allShown = list.length > 0 && shown.size === list.length;
  const toggleAll = () => setShown(allShown ? new Set() : new Set(list.map((_, i) => i)));
  const toggleOne = (i: number) => setShown((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <div>
      <div className="flex justify-end mb-2">
        <button type="button" onClick={toggleAll} className="text-[12px] font-semibold text-slate-500 hover:text-blue-600 transition-colors">{allShown ? '의미 가리기' : '모두 보기'}</button>
      </div>
      <ul className="flex flex-col divide-y divide-[#e6ddc6]">
        {list.map((w, i) => {
          const open = shown.has(i);
          return (
            <li key={i} className="py-2 first:pt-0">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-slate-800 text-[14px] sm:text-[15px] shrink-0">{w.word}</span>
                <SpeakBtn word={w.word} />
                <button type="button" onClick={() => toggleOne(i)} className={`flex-1 text-left text-[13px] sm:text-[14px] rounded px-1.5 transition-colors cursor-pointer ${open ? 'text-slate-600' : 'bg-[#e9e0c8] text-transparent hover:bg-[#e2d6b8] select-none'}`}>
                  {open
                    ? <span>{w.pos && <span className="text-indigo-400 font-medium">{w.pos} </span>}<InlineMd text={w.meaning} /></span>
                    : <span className="opacity-0">{w.pos ? `${w.pos} ` : ''}{w.meaning || '•••'}</span>}
                </button>
              </div>
              {open && <div className="pl-1 mt-1"><WordReveal w={w} /></div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// 어휘 암기 카드 — 카드(인출 엔진) / 목록(복습) 두 뷰
function VocabComp({ title, words, mode }: { title?: string | null; words: VocabWord[]; mode?: string | null }) {
  const list = (Array.isArray(words) ? words : []).filter((w) => w && w.word);
  const [view, setView] = useState<'flashcard' | 'list'>(mode === 'list' ? 'list' : 'flashcard');
  if (list.length === 0) return null;
  return (
    <div style={PAPER_STYLE} className="rounded-xl border border-[#e9e2d0] bg-[#faf8f0] px-4 py-3.5 sm:px-5 sm:py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] my-2">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="text-[13px] sm:text-[14px] font-bold text-slate-700 flex items-center gap-1.5"><span>📖</span>{title || '단어 암기'}</div>
        <div className="flex rounded-lg border border-[#e0d7bf] overflow-hidden text-[12px] font-semibold shrink-0">
          <button type="button" onClick={() => setView('flashcard')} className={`px-3 py-1 transition-colors ${view === 'flashcard' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-[#efe8d4]'}`}>카드</button>
          <button type="button" onClick={() => setView('list')} className={`px-3 py-1 transition-colors ${view === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-[#efe8d4]'}`}>목록</button>
        </div>
      </div>
      {view === 'flashcard' ? <VocabFlashcard list={list} /> : <VocabListView list={list} />}
    </div>
  );
}

// ── Passage (독해 지문 능동 읽기) — 맥락 어휘 탭 + 문단 요지 자가확인 + 주제/해석 reveal ──────
// 근거: 맥락 어휘 학습(고립 X) / 요지 파악(RC #1 스킬, 예측→확인 자기설명) / 인출. 테스트는 quiz_group.
// 지문 안 vocab 단어를 찾아 탭-공개로 만든다(맥락에서 뜻 확인).
function PassageText({ text, vocab }: { text: string; vocab: VocabWord[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!vocab.length) return <>{text}</>;
  const byLower = new Map(vocab.map((v) => [v.word.toLowerCase(), v]));
  const escaped = vocab.map((v) => v.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const segs = text.split(new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi'));
  return (
    <>
      {segs.map((seg, i) => {
        if (i % 2 === 1) {
          const v = byLower.get(seg.toLowerCase());
          if (!v) return <span key={i}>{seg}</span>;
          const isOpen = open.has(i);
          return (
            <button key={i} type="button"
              onClick={(e) => { e.stopPropagation(); setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; }); (e.currentTarget as HTMLButtonElement).blur(); }}
              className="underline decoration-dotted decoration-indigo-300 underline-offset-2 font-medium text-slate-800 hover-blue">
              {seg}{isOpen && <span className="text-indigo-500 text-[0.85em] font-medium"> ({v.meaning})</span>}
            </button>
          );
        }
        return <span key={i}>{seg}</span>;
      })}
    </>
  );
}
function PassageParagraph({ p, vocab }: { p: { text: string; mainIdea?: string | null }; vocab: VocabWord[] }) {
  const [showIdea, setShowIdea] = useState(false);
  return (
    <div className="mb-3.5 last:mb-0">
      <p className="text-[14px] sm:text-[15px] leading-relaxed text-slate-800"><PassageText text={p.text} vocab={vocab} /></p>
      {p.mainIdea && (
        <button type="button" onClick={() => setShowIdea((s) => !s)} className="mt-1.5 text-left text-[12px] font-medium transition-colors hover-blue">
          {showIdea
            ? <span className="text-indigo-600">요지 · <InlineMd text={p.mainIdea} /></span>
            : <span className="text-slate-400">요지 떠올린 뒤 탭하여 확인 ▸</span>}
        </button>
      )}
    </div>
  );
}
function PassageReveal({ label, content, markdown }: { label: string; content: string; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 pt-3 border-t border-[#eee6d2]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-[12px] font-semibold text-slate-500 transition-colors hover-blue">{label} {open ? '▴' : '▾'}</button>
      {open && <div className="mt-1.5 text-[13px] sm:text-[14px] text-slate-700 leading-relaxed">{markdown ? <InlineMd text={content} /> : content}</div>}
    </div>
  );
}
function PassageComp({ title, paragraphs, vocab, keyIdea, translation }: {
  title?: string | null;
  paragraphs?: any;
  vocab?: VocabWord[] | null; keyIdea?: string | null; translation?: string | null;
}) {
  // 입력 robust — paragraphs 가 객체배열 / 문자열배열 / 단일 문자열(빈 줄로 분리) 다 수용
  const arr = Array.isArray(paragraphs)
    ? paragraphs
    : typeof paragraphs === 'string'
      ? (paragraphs as string).split(/\n\n+/).map((t) => ({ text: t }))
      : [];
  const paras = arr.map((p: any) => (typeof p === 'string' ? { text: p } : p)).filter((p: any) => p && p.text);
  const vlist = (Array.isArray(vocab) ? vocab : []).filter((v) => v && v.word);
  if (paras.length === 0) return null;
  return (
    <div style={PAPER_STYLE} className="rounded-xl border border-[#e9e2d0] bg-[#faf8f0] px-4 py-3.5 sm:px-5 sm:py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] my-2">
      {title && <div className="text-[13px] sm:text-[14px] font-bold text-slate-700 mb-2.5 flex items-center gap-1.5"><span>📖</span>{title}</div>}
      <div>{paras.map((p, i) => <PassageParagraph key={i} p={p} vocab={vlist} />)}</div>
      {keyIdea && <PassageReveal label="주제" content={keyIdea} />}
      {translation && <PassageReveal label="해석" content={translation} markdown />}
      {vlist.length > 0 && <div className="mt-2 text-[10px] text-slate-400">밑줄 단어를 탭하면 뜻이 나와요</div>}
    </div>
  );
}

// ── Concept (개념·이론 설명) — 학습과학 기반 능동 설명 ──────────────────────────────
// 세그먼팅 + 예측→공개(generation effect) + 워크드 예제 + 오개념 반박(refutation) + 인출 확인.
// 가르치기용(시험=quiz, 독해=passage 와 구분). 전부 클라 reveal, 런타임 LLM 0.
function ConceptStep({ step, idx }: { step: { heading?: string | null; predict?: string | null; body: string }; idx: number }) {
  const [open, setOpen] = useState(!step.predict);
  return (
    <div className="mb-3.5 last:mb-0">
      {step.heading && <div className="font-bold text-slate-800 text-[13px] sm:text-[14px] mb-1">{idx}. {step.heading}</div>}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-left text-[13px] sm:text-[14px] transition-colors hover-blue">
          <span className="text-indigo-500 font-medium">🤔 {step.predict}</span>
          <span className="text-slate-400"> — 떠올린 뒤 탭하여 확인 ▸</span>
        </button>
      ) : (
        <div className="text-[13px] sm:text-[14px] text-slate-700 leading-relaxed"><InlineMd text={step.body} /></div>
      )}
    </div>
  );
}
function ConceptExample({ problem, solution }: { problem: string; solution: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 rounded-lg bg-[#f3eedd] px-3 py-2.5">
      <div className="text-[13px] text-slate-800"><span className="font-bold text-slate-500 text-[11px]">예제 </span><InlineMd text={problem} /></div>
      {open
        ? <div className="mt-1.5 pt-1.5 border-t border-[#e6ddc6] text-[13px] text-slate-700"><span className="font-bold text-emerald-600 text-[11px]">풀이 </span><InlineMd text={solution} /></div>
        : <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[12px] font-medium text-slate-400 transition-colors hover-blue">풀이 떠올린 뒤 탭하여 확인 ▸</button>}
    </div>
  );
}
function ConceptMisconception({ wrong, right }: { wrong: string; right: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5">
      <div className="text-[13px] text-slate-700"><span className="font-bold text-rose-500">흔한 오해 </span><InlineMd text={wrong} /></div>
      {open
        ? <div className="mt-1.5 text-[13px] text-slate-700"><span className="font-bold text-emerald-600">사실은 </span><InlineMd text={right} /></div>
        : <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[12px] font-medium text-slate-400 transition-colors hover-blue">사실은? ▸</button>}
    </div>
  );
}
function ConceptCheck({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 pt-3 border-t border-[#eee6d2]">
      <div className="text-[13px] font-semibold text-slate-700"><span className="text-indigo-500">✅ 확인 </span><InlineMd text={question} /></div>
      {open
        ? <div className="mt-1.5 text-[13px] font-medium text-blue-700"><InlineMd text={answer} /></div>
        : <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[12px] font-medium text-slate-400 transition-colors hover-blue">답 떠올린 뒤 탭하여 확인 ▸</button>}
    </div>
  );
}
function ConceptComp({ title, intro, steps, example, misconception, check }: {
  title?: string | null; intro?: string | null;
  steps?: any;
  example?: { problem?: string; solution?: string } | null;
  misconception?: { wrong?: string; right?: string } | null;
  check?: { question?: string; answer?: string } | null;
}) {
  const stepList = (Array.isArray(steps) ? steps : []).filter((s: any) => s && s.body);
  if (stepList.length === 0 && !intro) return null;
  return (
    <div style={PAPER_STYLE} className="rounded-xl border border-[#e9e2d0] bg-[#faf8f0] px-4 py-3.5 sm:px-5 sm:py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] my-2">
      {title && <div className="text-[13px] sm:text-[14px] font-bold text-slate-700 mb-2.5 flex items-center gap-1.5"><span>💡</span>{title}</div>}
      {intro && <div className="text-[13px] sm:text-[14px] text-slate-700 leading-relaxed mb-3"><InlineMd text={intro} /></div>}
      {stepList.map((s: any, i: number) => <ConceptStep key={i} step={s} idx={i + 1} />)}
      {example && example.problem && example.solution && <ConceptExample problem={example.problem} solution={example.solution} />}
      {misconception && misconception.wrong && misconception.right && <ConceptMisconception wrong={misconception.wrong} right={misconception.right} />}
      {check && check.question && check.answer && <ConceptCheck question={check.question} answer={check.answer} />}
    </div>
  );
}

// ── Listening (LC 리스닝) — 오디오 재생 + 스크립트 가림(받아쓰기) + 문제(QuizBody 재사용) ──────
// 오디오 = cloud TTS mp3(audioUrl, tts sysmod 가 conv-scoped 저장). 문제는 quiz 와 동일 렌더(MC/OX/TFNG).
// quiz_group 의 audio 판 — passage 대신 audio + 스크립트 가림.
// 숫자-단어 ↔ 숫자 정규화(first↔1st↔1, three↔3, tenth↔10th↔10). 단일 단어 케이스(0~20·십단위·서수).
const DICT_NUM_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  eleventh: '11', twelfth: '12', thirteenth: '13', fourteenth: '14', fifteenth: '15', sixteenth: '16', seventeenth: '17', eighteenth: '18', nineteenth: '19', twentieth: '20',
  thirtieth: '30', fortieth: '40', fiftieth: '50',
};
function dictNorm(w: string): string {
  const s = w.toLowerCase().replace(/[^a-z0-9]/g, ''); // 콤마·마침표·하이픈 등 구두점 무시
  if (!s) return '';
  const ord = s.match(/^(\d+)(st|nd|rd|th)$/); // 10th → 10
  if (ord) return ord[1];
  return DICT_NUM_WORDS[s] ?? s; // three → 3, first → 1
}

// 받아쓰기 자동 채점 — 들은 내용(typed) vs 스크립트 단어별 LCS 정렬. 맞은 스크립트 단어 표시 + 정확도%.
// 런타임 LLM 0(클라 문자열 비교). 구두점 무시 + 숫자-단어 동치(first↔1st) + 하이픈=단어 분리.
function dictationDiff(script: string, typed: string) {
  const sWords = script.split(/[\s‐-―-]+/).filter(Boolean);
  const sNorm = sWords.map(dictNorm);
  const tWords = typed.split(/[\s‐-―-]+/).map(dictNorm).filter(Boolean);
  const n = sNorm.length;
  const m = tWords.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = sNorm[i - 1] && sNorm[i - 1] === tWords[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const matched = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (sNorm[i - 1] && sNorm[i - 1] === tWords[j - 1]) { matched.add(i - 1); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  const scorable = sNorm.filter(Boolean).length || 1;
  return { sWords, matched, accuracy: Math.round((matched.size / scorable) * 100) };
}

// 정독청취 플레이어 — 재생속도 / 전체반복 / A-B 구간반복 / 볼륨 + 외부에서 시각(cur)·길이(dur) 구독
// (스크립트 줄 하이라이트·클릭 seek 용). 학습 핵심 = 느리게·구간 반복 청취(intensive listening).
function ListeningPlayer({ src, audioRef, onTime, onDur, study = true, words = [], abA, abB, setAbA, setAbB }: {
  src: string;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  onTime: (t: number) => void;
  onDur: (d: number) => void;
  /** 학습 모드 = 속도·전체반복·구간반복 노출. 시험 모드(false) = 재생+위치+볼륨만(1회청취). */
  study?: boolean;
  /** LRC 단어 [start,end] — A-B 구간을 단어 경계로 snap(단어 중간 잘림 방지). 없으면 raw 시간. */
  words?: Array<{ start: number; end: number }>;
  /** A-B 구간(초) — 부모(스크립트)가 소유. 스크립트 단어 클릭/마커와 플레이어 A/B 버튼이 같은 상태 공유. */
  abA: number | null; abB: number | null;
  setAbA: (t: number | null) => void; setAbB: (t: number | null) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false); // 속도 탭 → 슬라이더(0.1~3x) 노출 토글.
  const [vol, setVol] = useState(1);
  const [showVol, setShowVol] = useState(false); // 볼륨 탭 → 슬라이더 오버레이(속도와 동일 패턴).
  const [loop, setLoop] = useState(false);
  const loopingRef = useRef(false); // A-B 루프 0.5초 딜레이 중 재트리거 방지.
  // A-B 단어 경계 snap — t 가 든 단어로(있으면), 빈음이면 A=다음 단어 start / B=이전 단어 end.
  const snapStart = (t: number) => {
    if (!words.length) return t;
    const inw = words.find((w) => t >= w.start && t < w.end);
    if (inw) return inw.start;
    const next = words.find((w) => w.start >= t);
    return next ? next.start : t;
  };
  const snapEnd = (t: number) => {
    if (!words.length) return t;
    const inw = words.find((w) => t >= w.start && t < w.end);
    if (inw) return inw.end;
    let prev: { start: number; end: number } | undefined;
    for (const w of words) { if (w.end <= t) prev = w; else break; }
    return prev ? prev.end : t;
  };
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onT = () => {
      setCur(a.currentTime); onTime(a.currentTime);
      // A-B 구간반복 — B 도달 시 0.5초 숨돌린 뒤 A 부터(바로 또 시작하면 못 따라감, 정독 청취).
      if (abA != null && abB != null && abB > abA && a.currentTime >= abB && !loopingRef.current) {
        loopingRef.current = true;
        a.pause();
        setTimeout(() => {
          const aa = audioRef.current;
          if (aa) { aa.currentTime = abA; void aa.play(); }
          loopingRef.current = false;
        }, 500);
      }
    };
    const onMeta = () => { setDur(a.duration || 0); onDur(a.duration || 0); };
    const onEnd = () => { if (!a.loop) setPlaying(false); };
    // play/pause 이벤트 = 버튼 상태 동기 (단어 클릭·seek 등 외부 재생도 버튼이 ▶↔❚❚ 반영).
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('timeupdate', onT); a.addEventListener('loadedmetadata', onMeta); a.addEventListener('ended', onEnd);
    a.addEventListener('play', onPlay); a.addEventListener('pause', onPause);
    return () => { a.removeEventListener('timeupdate', onT); a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('ended', onEnd); a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); };
  }, [audioRef, abA, abB, onTime, onDur]);
  // 재생 중 rAF 로 시간/슬라이더 부드럽게 — timeupdate 는 ~4회/초라 시간바가 뚝뚝 끊김.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a && !a.paused) { setCur(a.currentTime); onTime(a.currentTime); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, audioRef, onTime]);
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed, audioRef]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = vol; }, [vol, audioRef]);
  useEffect(() => { if (audioRef.current) audioRef.current.loop = loop; }, [loop, audioRef]);
  const toggle = () => { const a = audioRef.current; if (!a) return; if (a.paused) { if (abA != null && (a.currentTime < abA || (abB != null && a.currentTime >= abB))) a.currentTime = abA; void a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); } };
  const seek = (t: number) => { const a = audioRef.current; if (a) { a.currentTime = t; setCur(t); } };
  const fmt = (s: number) => { if (!isFinite(s)) return '0:00'; const m = Math.floor(s / 60); const x = Math.floor(s % 60); return `${m}:${x.toString().padStart(2, '0')}`; };
  // 활성 = muted 슬레이트(약간 진해짐) — 파랑/녹색/주황 등 saturated 색 대신 컨트롤 톤 통일.
  const pill = (on: boolean) => `px-1.5 py-0.5 rounded leading-none transition-colors ${on ? 'bg-slate-300 text-slate-800' : 'bg-white/70 text-slate-500 hover:bg-white'}`;
  return (
    <div className="rounded-lg border border-[#d9cdae] bg-[#f3eedd] p-2.5">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggle} aria-label={playing ? '일시정지' : '재생'} className="w-9 h-9 shrink-0 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
          {playing
            ? <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px]" aria-hidden><path d="M7 5h3v14H7zM14 5h3v14h-3z" /></svg>
            : <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] ml-0.5" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
        </button>
        <input type="range" min={0} max={dur || 0} step={0.05} value={cur} onChange={(e) => seek(Number(e.target.value))} aria-label="재생 위치" className="flex-1 accent-blue-600" />
        <span className="text-[11px] text-slate-500 tabular-nums shrink-0">{fmt(cur)}/{fmt(dur)}</span>
      </div>
      {/* 컨트롤 한 줄(브라우저 TTS 와 동일 구조) — 속도·전체반복·구간 + 볼륨(ml-auto 로 항상 우측 끝).
          모바일은 자연 wrap. 시험 모드(study=false)면 속도·전체반복·구간 숨김(1회청취), 볼륨만(우측 고정). */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 mt-2 text-[11px]">
        {study && (
          <div className="relative flex items-center gap-1.5">
            <span className="text-slate-400">속도</span>
            <button type="button" onClick={() => setShowSpeed((v) => !v)} className={pill(showSpeed)}>{speed.toFixed(1)}x</button>
            {showSpeed && (
              // 팝오버(absolute, 흐름 밖) — 다른 컨트롤 위에 떠서 줄 밀림 0. 슬라이더 놓으면 자동 닫힘.
              <div className="absolute left-0 top-full mt-1 z-30 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg w-52">
                <input type="range" min={0.1} max={3} step={0.1} value={speed}
                  onChange={(e) => setSpeed(Math.round(Number(e.target.value) * 10) / 10)}
                  onPointerUp={() => setShowSpeed(false)}
                  aria-label="재생 속도" className="flex-1 accent-blue-600" />
                <span className="w-9 text-right tabular-nums text-slate-500">{speed.toFixed(1)}x</span>
              </div>
            )}
          </div>
        )}
        {study && <>
          <button type="button" onClick={() => setLoop((v) => !v)} className={pill(loop)} title="전체 반복">↻</button>
          <span className="text-slate-400 ml-1">구간</span>
          <button type="button" onClick={() => setAbA(snapStart(cur))} className={pill(abA != null)} title="구간 시작(A) — 현재 위치">A</button>
          <button type="button" onClick={() => setAbB(snapEnd(cur))} className={pill(abB != null)} title="구간 끝(B) — 현재 위치">B</button>
          {(abA != null || abB != null) && <button type="button" onClick={() => { setAbA(null); setAbB(null); }} className="px-1.5 py-0.5 rounded leading-none bg-white/70 text-slate-400 hover:bg-white" title="구간 해제">✕</button>}
        </>}
        {/* 볼륨 = 항상 오른쪽 끝 고정(ml-auto) — 구간 ✕ 버튼이 떠도 위치 불변. 시험 모드(볼륨만)도 동일하게 우측. */}
        <div className="relative flex items-center ml-auto">
          <button type="button" onClick={() => setShowVol((v) => !v)} className={pill(showVol)} aria-label="볼륨">🔊 {Math.round(vol * 100)}</button>
          {showVol && (
            <div className="absolute right-0 top-full mt-1 z-30 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg w-44">
              <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} onPointerUp={() => setShowVol(false)} aria-label="볼륨" className="flex-1 accent-blue-600" />
              <span className="w-8 text-right tabular-nums text-slate-500">{Math.round(vol * 100)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 가이드 멘트(exam directions) — "Questions 31 through 33 refer to..." 류. 오디오엔 낭독되고 스크립트엔
// 보이지만, 받아쓰기 채점·노래방 현재위치 하이라이트에선 제외(실제 시험처럼 안내문은 받아쓰지 않음).
const lineIsGuide = (l: any) => !!(l?.guide ?? l?.instruction ?? l?.narration ?? l?.directions);
const lcNorm = (t: string) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

function ListeningComp({ title, audioUrl, image, script, questions, browserTts, mode, view = 'interactive' }: {
  title?: string | null; audioUrl?: string | null; image?: string | null; script?: any; questions?: any; browserTts?: boolean; mode?: string; view?: QuizView;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  // LRC 정렬 — tts 가 저장한 sidecar(audioUrl + ".lrc.json"). 줄별 [start,end] + 단어별 시각.
  // 있으면 현재 문장 박스 + fill 와이프 + 단어 클릭 seek(정확). 없으면 글자수 추정 fallback.
  type LrcLine = { speaker?: string | null; text: string; start: number; end: number; words?: Array<{ word: string; start: number; end: number }> };
  const [lrc, setLrc] = useState<LrcLine[] | null>(null);
  // sidecar fetch 정착 여부 — 로딩 중(미정착)엔 글자수 추정 하이라이트를 끔(오싱크 방지).
  // 시크릿/콜드 로드 첫 재생 시 fetch 가 늦으면 lrc=null + dur=0 → 추정이 마지막 줄로 튀어 "완전 안맞음"
  // 되던 것 차단. 정착(성공/실패) 후에만 karaoke(lrc 있음) 또는 추정(lrc 없음=Gemini) 으로 분기.
  const [lrcReady, setLrcReady] = useState(false);
  useEffect(() => {
    setLrc(null);
    setLrcReady(false);
    if (!audioUrl) { setLrcReady(true); return; }
    let alive = true;
    fetch(`${audioUrl}.lrc.json`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => { const arr = JSON.parse(t); if (alive && Array.isArray(arr) && arr.length) setLrc(arr); })
      .catch(() => { /* 정렬 없음 — 추정 fallback */ })
      .finally(() => { if (alive) setLrcReady(true); });
    return () => { alive = false; };
  }, [audioUrl]);
  const isStatic = view !== 'interactive';
  // 시험 모드(mode='exam') = 1회청취(속도·반복·받아쓰기 숨김). 기본 = 학습(study, 전 기능). AI 가 page 발행 등에서 'exam' 지정.
  const isStudy = mode !== 'exam';
  // 브라우저 TTS 모드 — API 키 없을 때 fallback. 클라 Web Speech 가 스크립트 낭독(단일 음성, 파일 없음).
  const browserMode = !!browserTts && !audioUrl;
  const [bSpeaking, setBSpeaking] = useState(false);
  const [bSpeed, setBSpeed] = useState(1);
  const [bShowSpeed, setBShowSpeed] = useState(false); // 브라우저 TTS 속도 슬라이더 토글.
  const [bSeg, setBSeg] = useState(-1); // 브라우저 모드: 현재 낭독 중 문장(하이라이트)
  const [bStartWord, setBStartWord] = useState(0); // 현재 문장 하이라이트 시작 단어(단어 클릭 시작점부터 표시)
  const [bVol, setBVol] = useState(1);
  const [bShowVol, setBShowVol] = useState(false); // 볼륨 슬라이더 오버레이 토글(속도와 동일).
  const bSpeedRef = useRef(1); bSpeedRef.current = bSpeed;
  const bVolRef = useRef(1); bVolRef.current = bVol;
  const bPlayRef = useRef(false); // 재생 의도(cancel 시 false → 자동 다음 문장 중단)
  const bGenRef = useRef(0); // utterance 세대 토큰(재시작 시 옛 onend 무효화)
  const [bLoopAll, setBLoopAll] = useState(false); // 전체반복(끝→루프 시작점). 단어 timestamp 없어 A-B 대신 A-(시작점만).
  const bLoopAllRef = useRef(false); bLoopAllRef.current = bLoopAll;
  const [bLoopStart, setBLoopStart] = useState<{ seg: number; word: number } | null>(null); // A : 클릭한 시작 단어(없으면 0부터)
  const bLoopStartRef = useRef<{ seg: number; word: number } | null>(null); bLoopStartRef.current = bLoopStart;
  const [bLoopEnd, setBLoopEnd] = useState<{ seg: number; word: number } | null>(null); // B : 클릭한 끝 단어(없으면 A부터 끝까지)
  const bLoopEndRef = useRef<{ seg: number; word: number } | null>(null); bLoopEndRef.current = bLoopEnd;
  const bRangeRef = useRef<{ a: { seg: number; word: number } | null; b: { seg: number; word: number } | null } | null>(null); // 현재 루프 구간(속도변경 재시작·취소 분기용)
  const [bAbSel, setBAbSel] = useState(false); // 브라우저 구간반복 토글 — ON 이면 단어 탭 = A/B 지정(↻ 전체반복과 분리)
  const [showScript, setShowScript] = useState(isStatic); // 학습=청취 먼저(가림), 공유/프린트=공개
  const [dictation, setDictation] = useState(false);
  const [typed, setTyped] = useState('');
  const [dictChecked, setDictChecked] = useState(false);
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [revealed, setRevealed] = useState(isStatic);
  const lines = (Array.isArray(script) ? script : typeof script === 'string' ? script.split('\n').map((t: string) => ({ text: t })) : [])
    .map((l: any) => (typeof l === 'string' ? { text: l } : l)).filter((l: any) => l && (l.text || l.line));
  const qs = Array.isArray(questions) ? questions : [];
  // Part 1(사진 묘사) 안전망 — script 가 비고 image + 선택지만 있으면 그 선택지(= 낭독될 4문장)를 스크립트로.
  // image 게이트라 Part 3/4(이미지 없음 + 선택지=정답옵션)엔 적용 안 함(낭독 텍스트는 항상 script 가 정공).
  const firstChoices = qs[0] ? (qs[0].choices ?? qs[0].options) : null;
  const effectiveLines = lines.length > 0
    ? lines
    : (image && Array.isArray(firstChoices) && firstChoices.length > 0)
      ? firstChoices.map((c: any) => ({ text: typeof c === 'string' ? c : (c?.text ?? c?.label ?? '') })).filter((l: any) => l.text)
      : [];
  // 문장 단위 세그먼트 — 클릭 재생 granular(담화 한 문단도 문장별로 쪼갬). speaker 는 turn 첫 문장에만.
  const segments = useMemo(() => {
    const segs: Array<{ text: string; speaker?: string; start?: number; guide?: boolean }> = [];
    for (const l of effectiveLines as any[]) {
      const raw = String(l.text ?? l.line ?? '').trim();
      if (!raw) continue;
      const g = lineIsGuide(l);
      const parts = raw.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((s) => s.trim()).filter(Boolean);
      const list = parts.length ? parts : [raw];
      list.forEach((s, si) => segs.push({ text: s, speaker: si === 0 ? (l.speaker ?? l.role) : undefined, start: si === 0 ? l.start : undefined, guide: g }));
    }
    return segs;
  }, [effectiveLines]);
  // 가이드 줄 텍스트 집합 — LRC 사이드카 줄 매칭용(사이드카엔 guide 플래그 없으니 텍스트로 식별).
  const guideLineTexts = useMemo(() => new Set((effectiveLines as any[]).filter(lineIsGuide).map((l) => lcNorm(String(l.text ?? l.line ?? '')))), [effectiveLines]);
  // 보기 마커 스타일 — script 라벨(A/B/C·가나다·ㄱㄴㄷ·1/2/3)에서 자동 감지 → 보기 번호가 스크립트와 일치.
  const detectedMarker = useMemo(() => detectMarkerStyle(effectiveLines as any[]), [effectiveLines]);
  // 세그먼트별 시작 시각 — start(초) 우선, 없으면 글자수 비례 추정(duration 알면). 클릭 seek·현재 문장 하이라이트용.
  const lineStarts = useMemo(() => {
    if (segments.some((s) => typeof s.start === 'number')) return segments.map((s) => (typeof s.start === 'number' ? s.start! : 0));
    const lens = segments.map((s) => s.text.length || 1);
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return lens.map((len) => { const t = (acc / total) * dur; acc += len; return t; });
  }, [segments, dur]);
  const curLine = useMemo(() => {
    // sidecar 로딩 중(파일 TTS) 이면 추정 하이라이트 금지 — lrc 정착 전 오싱크(마지막 줄 튐) 차단.
    if (audioUrl && !lrcReady) return -1;
    let idx = -1;
    for (let i = 0; i < lineStarts.length; i++) if (cur >= lineStarts[i] - 0.2) idx = i;
    return idx;
  }, [cur, lineStarts, audioUrl, lrcReady]);
  const seekLine = (i: number) => { const a = audioRef.current; if (a && lineStarts[i] != null) { a.currentTime = lineStarts[i]; if (a.paused) void a.play(); } };
  // LRC 임의 시각 seek(단어 클릭) — 그 시각으로 이동 + 재생 시작.
  const seekTo = (t: number) => { const a = audioRef.current; if (a && isFinite(t)) { a.currentTime = t; if (a.paused) void a.play(); } };
  // 파일 TTS A-B 구간(초) — 스크립트(부모)가 소유. 플레이어 A/B 버튼(현재 위치)으로 set,
  // 스크립트는 마커만 표시. 루프는 플레이어가 abA/abB(props)로 수행. (스크립트 드래그 조정 = 추후)
  const [abA, setAbA] = useState<number | null>(null);
  const [abB, setAbB] = useState<number | null>(null);
  // 모바일 탭-이동 — A/B 마커 탭 = 선택(armed), 그 뒤 단어 탭 = 그 위치로 이동(드래그 대안).
  // 파일 모드 전용(브라우저는 bAbSel 토글이 같은 역할). PC 드래그는 그대로 병행.
  const [armed, setArmed] = useState<'A' | 'B' | null>(null);
  // ── A/B 마커 드래그 이동 — 스크립트에서 마커(A/B) 단어를 끌어 다른 단어로 옮김(브라우저=단어 인덱스,
  // 파일=단어 시각). data-w 속성으로 포인터 밑 단어 식별(elementFromPoint), pointer capture 로 터치도 추적. ──
  const dragRef = useRef<null | 'A' | 'B'>(null);
  const movedRef = useRef(false); // 드래그 발생 시 onClick(선택) 억제용
  const dragStartRef = useRef<{ x: number; y: number } | null>(null); // 드래그 시작 좌표(임계 판정)
  const [dragging, setDragging] = useState(false);
  const markerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    // 드래그 임계 — 6px 미만 움직임은 이동 아님(클릭/탭 미세 떨림이 드래그로 오인돼 선택 안 되던 것 방지).
    const st = dragStartRef.current;
    if (st && Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
    e.preventDefault();
    const el = (typeof document !== 'undefined' ? (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) : null)?.closest('[data-w]') as HTMLElement | null;
    const w = el?.getAttribute('data-w');
    if (!w) return;
    movedRef.current = true;
    const p = w.split(':');
    if (p[0] === 'b') { const pt = { seg: Number(p[1]), word: Number(p[2]) }; if (dragRef.current === 'A') setBLoopStart(pt); else setBLoopEnd(pt); }
    else { if (dragRef.current === 'A') setAbA(Number(p[1])); else setAbB(Number(p[2])); }
  };
  const markerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const which = dragRef.current;
    const wasMove = movedRef.current;
    dragRef.current = null; setDragging(false);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* */ }
    if (browserMode && bSpeaking && bLoopStartRef.current) bRunRange(bLoopStartRef.current, bLoopEndRef.current);
    // 끌지 않고 탭만(파일 마커) = 선택(arm) 토글 — 다음 단어 탭으로 이동. 브라우저는 bAbSel 이 담당.
    if (!wasMove && !browserMode) setArmed((a) => (a === which ? null : which));
  };
  const markerDown = (which: 'A' | 'B') => (e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = which; movedRef.current = false; setDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* */ }
  };
  // LRC 단어 평탄화 — 플레이어 A-B 단어 경계 snap 용([start,end] 목록).
  const lrcWords = useMemo(() => (lrc ? lrc.flatMap((l) => l.words ?? []) : []), [lrc]);
  // LRC 현재 줄 — start≤cur<end (정확). 단어 클릭/줄 fill 의 활성 줄.
  const curLrc = useMemo(() => {
    if (!lrc) return -1;
    let idx = -1;
    for (let i = 0; i < lrc.length; i++) if (cur >= lrc[i].start - 0.15) idx = i;
    return idx;
  }, [cur, lrc]);
  // v2 단어별 정확 fill — 재생 중 rAF 로 cur 를 ~30fps 갱신(단어가 말해지는 순간 채워지게).
  // LRC 있을 때만(노래방), 재생 중에만 setCur(일시정지면 변화 0 → 재렌더 0).
  useEffect(() => {
    if (!lrc) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      const a = audioRef.current;
      if (a && !a.paused) {
        const t = a.currentTime;
        if (Math.abs(t - last) > 0.03) { last = t; setCur(t); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lrc]);
  // 받아쓰기 채점 결과 — 확인 눌렀을 때만 계산(스크립트 전체 vs typed).
  const dictResult = useMemo(() => (dictChecked ? dictationDiff(segments.filter((s) => !s.guide).map((s) => s.text).join(' '), typed) : null), [dictChecked, segments, typed]);
  // 브라우저 TTS — 문장 단위 순차 재생(idx 부터). Web Speech 는 mid-utterance rate/volume 변경 불가라
  // 속도·볼륨 바꾸면 현재 문장을 새 설정으로 재시작+이어감(전체 처음 X). onboundary 모바일 불안정이라 문장 단위.
  const bPlayFrom = (idx: number, fromText?: string, wordOffset = 0) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const gen = ++bGenRef.current;
    window.speechSynthesis.cancel();
    if (idx < 0 || idx >= segments.length) { bPlayRef.current = false; setBSpeaking(false); setBSeg(-1); setBStartWord(0); return; }
    bPlayRef.current = true;
    setBSpeaking(true);
    setBSeg(idx);
    setBStartWord(wordOffset); // 단어 클릭 시작점부터 하이라이트(0=문장 처음부터)
    // fromText = 단어 클릭 시 그 단어부터(첫 문장만 부분 발화), 이후 문장은 onend 가 full 로 이어감.
    const u = new SpeechSynthesisUtterance(fromText ?? segments[idx].text);
    u.rate = bSpeedRef.current;
    u.volume = bVolRef.current;
    u.lang = 'en-US';
    u.onend = () => { if (bGenRef.current === gen && bPlayRef.current) bPlayFrom(idx + 1); };
    window.speechSynthesis.speak(u);
  };
  const bStop = () => { bPlayRef.current = false; bGenRef.current++; bRangeRef.current = null; if (typeof window !== 'undefined') window.speechSynthesis?.cancel(); setBSpeaking(false); };
  // 단어 클릭 = 그 단어부터 1회 재생(루프 아님 — 🔁 OFF). fill(차오름)은 단어 타임 없어 불가, 문장 하이라이트만.
  const bPlayFromWord = (segIdx: number, wordIdx: number) => {
    bRangeRef.current = null;
    const parts = segments[segIdx].text.split(' ');
    bPlayFrom(segIdx, parts.slice(Math.max(0, wordIdx)).join(' '), Math.max(0, wordIdx));
  };
  const bPtLE = (p: { seg: number; word: number }, q: { seg: number; word: number }) => p.seg < q.seg || (p.seg === q.seg && p.word <= q.word);
  // 구간 루프 — [a,b](null=스크립트 경계 0/끝) 반복 발화. 전체반복·A-(B 없음)·A-B 모두 이 경로 단일화.
  const bRunRange = (a: { seg: number; word: number } | null, b: { seg: number; word: number } | null) => {
    if (typeof window === 'undefined' || !window.speechSynthesis || !segments.length) return;
    bRangeRef.current = { a, b };
    const A = a ?? { seg: 0, word: 0 };
    const last = segments.length - 1;
    const B = b ?? { seg: last, word: Math.max(0, segments[last].text.split(' ').length - 1) };
    const items: { seg: number; text: string; wordStart: number }[] = [];
    for (let s = A.seg; s <= B.seg; s++) {
      const words = segments[s].text.split(' ');
      const st = s === A.seg ? A.word : 0;
      const en = s === B.seg ? B.word + 1 : words.length;
      const t = words.slice(Math.max(0, st), en).join(' ').trim();
      if (t) items.push({ seg: s, text: t, wordStart: Math.max(0, st) });
    }
    if (!items.length) { bRangeRef.current = null; return; }
    bPlayRef.current = true;
    setBSpeaking(true);
    const step = (i: number) => {
      if (!bPlayRef.current) return;
      if (i >= items.length) {
        const isSection = !!(a || b); // 구간(A/B 지정) = 항상 루프 / 전체(a·b null) = ↻ 토글 따름
        if (isSection || bLoopAllRef.current) { step(0); return; }
        bRangeRef.current = null; bPlayRef.current = false; setBSpeaking(false); setBSeg(-1); return;
      }
      const gen = ++bGenRef.current;
      window.speechSynthesis.cancel();
      setBSeg(items[i].seg);
      setBStartWord(items[i].wordStart);
      const u = new SpeechSynthesisUtterance(items[i].text);
      u.rate = bSpeedRef.current; u.volume = bVolRef.current; u.lang = 'en-US';
      u.onend = () => { if (bGenRef.current === gen && bPlayRef.current) step(i + 1); };
      window.speechSynthesis.speak(u);
    };
    step(0);
  };
  // 재생 중 속도/볼륨 변경 → 현재 문장을 새 설정으로 재시작 + 이어감.
  useEffect(() => {
    if (!bPlayRef.current) return;
    if (bRangeRef.current) bRunRange(bRangeRef.current.a, bRangeRef.current.b); // 구간 루프 재시작
    else if (bSeg >= 0) bPlayFrom(bSeg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bSpeed, bVol]);
  return (
    <div style={PAPER_STYLE} className="rounded-xl border border-[#e9e2d0] bg-[#faf8f0] px-4 py-3.5 sm:px-5 sm:py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] my-2">
      {title && <div className="text-[13px] sm:text-[14px] font-bold text-slate-700 mb-2.5 flex items-center gap-1.5"><span aria-hidden>🎧</span>{title}</div>}
      {image && <img src={image} alt={title ?? '사진'} loading="lazy" className="w-full max-h-72 object-contain rounded-lg border border-[#e9e2d0] bg-white mb-2.5" />}
      {audioUrl ? (
        <ListeningPlayer src={audioUrl} audioRef={audioRef} onTime={setCur} onDur={setDur} study={isStudy} words={lrcWords} abA={abA} abB={abB} setAbA={setAbA} setAbB={setAbB} />
      ) : (browserMode && segments.length > 0) ? (
        <div className="rounded-lg border border-[#d9cdae] bg-[#f3eedd] p-2.5 flex flex-wrap items-center gap-2">
          <button type="button" aria-label={bSpeaking ? '정지' : '재생'}
            onClick={() => { if (bSpeaking) { bStop(); return; } if (bLoopStart && bLoopEnd) bRunRange(bLoopStart, bLoopEnd); else if (bLoopStart) bRunRange(bLoopStart, null); else if (bLoopAll) bRunRange(null, null); else bPlayFrom(0); }}
            className="w-9 h-9 shrink-0 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
            {bSpeaking
              ? <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px]" aria-hidden><path d="M7 5h3v14H7zM14 5h3v14h-3z" /></svg>
              : <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] ml-0.5" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
          </button>
          {isStudy && (
            <div className="relative flex items-center gap-1.5 text-[11px]">
              <span className="text-slate-400">속도</span>
              <button type="button" onClick={() => setBShowSpeed((v) => !v)} className={`px-1.5 py-0.5 rounded leading-none transition-colors ${bShowSpeed ? 'bg-slate-300 text-slate-800' : 'bg-white/70 text-slate-500 hover:bg-white'}`}>{bSpeed.toFixed(1)}x</button>
              {bShowSpeed && (
                <div className="absolute left-0 top-full mt-1 z-30 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg w-52">
                  <input type="range" min={0.1} max={3} step={0.1} value={bSpeed}
                    onChange={(e) => setBSpeed(Math.round(Number(e.target.value) * 10) / 10)}
                    onPointerUp={() => setBShowSpeed(false)}
                    aria-label="재생 속도" className="flex-1 accent-blue-600" />
                  <span className="w-9 text-right tabular-nums text-slate-500">{bSpeed.toFixed(1)}x</span>
                </div>
              )}
            </div>
          )}
          {isStudy && (
            <button type="button" onClick={() => { const next = !bLoopAll; setBLoopAll(next); if (next && bPlayRef.current && !bRangeRef.current) bRunRange(null, null); }} title="전체반복" aria-pressed={bLoopAll}
              className={`px-1.5 py-0.5 rounded leading-none transition-colors text-[11px] ${bLoopAll ? 'bg-slate-300 text-slate-800' : 'bg-white/70 text-slate-500 hover:bg-white'}`}>↻</button>
          )}
          <div className="relative ml-auto flex items-center text-[11px]">
            <button type="button" onClick={() => setBShowVol((v) => !v)} className={`px-1.5 py-0.5 rounded leading-none transition-colors ${bShowVol ? 'bg-slate-300 text-slate-800' : 'bg-white/70 text-slate-500 hover:bg-white'}`} aria-label="볼륨">🔊 {Math.round(bVol * 100)}</button>
            {bShowVol && (
              <div className="absolute right-0 top-full mt-1 z-30 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg w-44">
                <input type="range" min={0} max={1} step={0.05} value={bVol} onChange={(e) => setBVol(Number(e.target.value))} onPointerUp={() => setBShowVol(false)} aria-label="볼륨" className="flex-1 accent-blue-600" />
                <span className="w-8 text-right tabular-nums text-slate-500">{Math.round(bVol * 100)}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[#d9cdae] bg-[#f3eedd] px-3 py-4 text-center text-[12px] text-slate-400">오디오 생성 대기 중</div>
      )}
      {segments.length > 0 && (
        <div className="mt-3">
          {/* 시험 모드(study=false)는 정답 확인(revealed) 전엔 받아쓰기·스크립트 숨김(시험 조건 = 컨닝 X).
              정답 확인 후엔 스크립트 복습 허용. 학습 모드는 항상 노출. */}
          {!isStatic && (isStudy || revealed) && (
            <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]">
              {isStudy && <button type="button" onClick={() => setDictation((v) => !v)} className={`px-2 py-0.5 rounded font-semibold leading-none transition-colors ${dictation ? 'bg-indigo-500 text-white' : 'bg-white/70 text-slate-500 hover:bg-white'}`}>✍️ 받아쓰기</button>}
              <button type="button" onClick={() => setShowScript((v) => !v)} className="px-2 py-0.5 rounded font-semibold leading-none text-slate-500 transition-colors hover-blue">{showScript ? '스크립트 숨기기' : '스크립트 보기'}</button>
              {browserMode && isStudy && showScript && <button type="button" onClick={() => { const n = !bAbSel; setBAbSel(n); if (!n) { const seg = bSeg; setBLoopStart(null); setBLoopEnd(null); bRangeRef.current = null; if (bSpeaking && seg >= 0) bPlayFrom(seg); else bStop(); } }} className={`px-2 py-0.5 rounded font-semibold leading-none transition-colors ${bAbSel ? 'bg-slate-300 text-slate-800' : 'bg-white/70 text-slate-500 hover:bg-white'}`}>🔂 구간{bLoopStart && bLoopEnd ? ' ●' : ''}</button>}
              {browserMode && bAbSel && showScript ? <span className="text-slate-400">단어 탭 = 시작(A)→끝(B) · 다시 탭하면 이동</span> : isStudy && <span className="text-slate-400">먼저 듣고 받아쓴 뒤 확인하세요</span>}
            </div>
          )}
          {dictation && !isStatic && (
            <div className="mb-2">
              <textarea value={typed}
                onChange={(e) => { setTyped(e.target.value); setDictChecked(false); const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                rows={3}
                className="w-full min-h-[5.5rem] rounded-lg border border-[#d9cdae] bg-white/60 px-2.5 py-2 text-[13px] sm:text-[14px] text-slate-700 leading-relaxed resize-none overflow-hidden focus:outline-none focus:border-blue-400" />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px] text-slate-400">{dictResult && (<>정확도 <span className="font-bold text-blue-600">{dictResult.accuracy}%</span> · <span className="text-emerald-600">맞음</span> / <span className="text-rose-500">놓침</span></>)}</span>
                <button type="button" onClick={() => setDictChecked(true)} disabled={!typed.trim()} className="px-3 py-1 text-[12px] font-bold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40">받아쓰기 확인</button>
              </div>
              {dictResult && (
                <div className="mt-2 rounded-lg border border-[#d9cdae] bg-white/50 p-2.5 text-[13px] sm:text-[14px] leading-relaxed">
                  {dictResult.sWords.map((w, i) => (
                    <span key={i} className={dictResult.matched.has(i) ? 'text-emerald-700' : 'text-rose-500 font-semibold'}>{w} </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {showScript && (
            <div className="rounded-lg border border-[#d9cdae] p-2.5">
              <div className="text-[11px] font-bold text-indigo-500 mb-1">스크립트 <span className="font-normal text-slate-400">· 줄을 탭하면 그 구간부터 재생</span></div>
              {/* 마커 드래그 중엔 전체 본문 텍스트 선택 차단 → 데스크톱 하이라이트·모바일 선택팝업("브라우저 툴팁") 0. */}
              <div className={`flex flex-col gap-0.5 ${dragging ? 'select-none' : ''}`}>
                {lrc ? lrc.map((ln, i) => {
                  // 현재 재생 줄 = 연한 박스 + 진한 fill 이 왼→오로 **한 줄 연속 sweep**.
                  // fill 위치 = 단어 타이밍으로 계산(말하는 단어까지 글자 비례로 차오름) → 끊김 없이
                  // 부드럽되 단어 정확. 단어 탭 = 그 단어부터 재생. (사이드카 = Whisper 정렬일 때만 생성 — 정밀.
                  //  Gemini 는 단어 정렬 불안정이라 사이드카 없이 글자수 추정 fallback 으로 감.)
                  // 가이드 안내문(예: "Questions 31 through 33 refer to...") = 음소거 표시(하이라이트·fill 제외).
                  const guide = guideLineTexts.has(lcNorm(ln.text));
                  if (guide) return (
                    <div key={i} className="rounded px-1.5 py-1 text-[12px] sm:text-[13px] italic text-slate-400 leading-relaxed">{ln.text}</div>
                  );
                  const active = curLrc === i;
                  const words = ln.words && ln.words.length ? ln.words : [{ word: ln.text, start: ln.start, end: ln.end }];
                  return (
                    <div key={i} className="rounded px-1.5 py-1 text-[13px] sm:text-[14px] leading-relaxed">
                      <div className="flex gap-1.5">
                        {ln.speaker && <span className="font-bold text-slate-500 shrink-0">{ln.speaker}:</span>}
                        {/* 클릭=단어 단위(선택) / fill=단어+공백을 각각 토큰으로 두고 자체 시각구간 [start,end]
                            안에서 %로 차오름 → 무음(공백 구간=앞단어끝~다음단어시작)도 채워지며 끊김 없이 연속.
                            토큰 하나=단일 단어/공백이라 내부 줄바꿈 0(줄 사이는 인라인이라 자연 wrap) = absolute
                            fill 안전(2줄 한 박스 문제 없음). 현재 문장=연한 base + 진한 fill 이 쭉 차오름. */}
                        <span className="flex-1">
                          {words.map((w, wi) => {
                            const next = words[wi + 1];
                            const wFrac = active ? Math.max(0, Math.min(1, (cur - w.start) / Math.max(w.end - w.start, 0.05))) : 0;
                            const sFrac = active && next ? Math.max(0, Math.min(1, (cur - w.end) / Math.max(next.start - w.end, 0.05))) : 0;
                            const mkf: 'A' | 'B' | null = (abA != null && Math.abs(w.start - abA) < 0.01) ? 'A' : (abB != null && Math.abs(w.end - abB) < 0.01) ? 'B' : null;
                            const isAb = mkf !== null;
                            return [
                              <span key={`w${wi}`} data-w={`f:${w.start}:${w.end}`}
                                onPointerDown={mkf ? markerDown(mkf) : undefined}
                                onPointerMove={markerMove} onPointerUp={markerUp}
                                onClick={() => {
                                  if (movedRef.current) { movedRef.current = false; return; } // 드래그 끝 클릭 억제
                                  if (mkf) return; // 마커 탭 = 선택(markerUp 에서 arm) — seek 안 함
                                  if (armed) { if (armed === 'A') setAbA(w.start); else setAbB(w.end); setArmed(null); return; } // 선택 마커를 이 단어로 이동
                                  seekTo(w.start); // 단어 클릭 = 그 단어부터 재생 (단어 단위)
                                }}
                                className={`relative cursor-pointer rounded-sm ${isAb ? `bg-slate-300 text-slate-800 touch-none select-none ${mkf === armed ? 'ring-2 ring-blue-500' : 'ring-1 ring-slate-400'}` : active ? 'bg-blue-100/50' : 'hover:bg-blue-200/40'}`}>
                                {active && wFrac > 0 && <span className="absolute inset-y-0 left-0 bg-blue-300/55 pointer-events-none" style={{ width: `${wFrac * 100}%` }} />}
                                <span className="relative">{w.word}</span>
                              </span>,
                              next ? (
                                <span key={`s${wi}`} className={`relative ${active ? 'bg-blue-100/50' : ''}`} aria-hidden>
                                  {active && sFrac > 0 && <span className="absolute inset-y-0 left-0 bg-blue-300/55 pointer-events-none" style={{ width: `${sFrac * 100}%` }} />}
                                  <span className="relative"> </span>
                                </span>
                              ) : null,
                            ];
                          })}
                        </span>
                      </div>
                    </div>
                  );
                }) : segments.map((s, i: number) => (
                  s.guide ? (
                    <div key={i} className="px-1.5 py-1 text-[12px] sm:text-[13px] italic text-slate-400 leading-relaxed">{s.text}</div>
                  ) : browserMode ? (
                    // 브라우저 TTS = 단어 클릭 시 그 단어부터 재생(파일 모드 단어 클릭과 동등, fill 만 없음).
                    <div key={i} className="flex gap-1.5 px-1.5 py-1 rounded text-[13px] sm:text-[14px] leading-relaxed transition-colors text-slate-700">
                      {s.speaker && <span className="font-bold text-slate-500 shrink-0">{s.speaker}:</span>}
                      <span className="flex-1">
                        {s.text.split(' ').map((w, wi, arr) => {
                          const mk: 'A' | 'B' | null = (bLoopStart?.seg === i && bLoopStart?.word === wi) ? 'A' : (bLoopEnd?.seg === i && bLoopEnd?.word === wi) ? 'B' : null;
                          const isAB = mk !== null;
                          return (
                          <span key={wi} data-w={`b:${i}:${wi}`}
                            onPointerDown={mk ? markerDown(mk) : undefined}
                            onPointerMove={markerMove} onPointerUp={markerUp}
                            onClick={() => {
                            if (movedRef.current) { movedRef.current = false; return; } // 드래그 끝 클릭 억제
                            if (!bAbSel) { bPlayFromWord(i, wi); return; }
                            const c = { seg: i, word: wi };
                            // 마커만 설정 — 재생 중이면 즉시 적용, 멈춰 있으면 재생 버튼이 그 구간을 재생.
                            if (bLoopStart && !bLoopEnd) { const [lo, hi] = bPtLE(bLoopStart, c) ? [bLoopStart, c] : [c, bLoopStart]; setBLoopStart(lo); setBLoopEnd(hi); if (bSpeaking) bRunRange(lo, hi); }
                            else { setBLoopStart(c); setBLoopEnd(null); if (bSpeaking) bRunRange(c, null); }
                          }}
                            className={`cursor-pointer rounded-sm hover:bg-blue-200/40 ${isAB ? 'bg-slate-300 text-slate-800 ring-1 ring-slate-400 touch-none select-none' : (bSeg === i && wi >= bStartWord ? 'bg-blue-100/70 text-slate-900' : '')}`}>{w}{wi < arr.length - 1 ? ' ' : ''}</span>
                          );
                        })}
                      </span>
                    </div>
                  ) : (
                  <button key={i} type="button" onClick={() => seekLine(i)}
                    className={`text-left flex gap-1.5 px-1.5 py-1 rounded text-[13px] sm:text-[14px] leading-relaxed transition-colors ${curLine === i ? 'bg-blue-100/70 text-slate-900' : 'text-slate-700 hover:bg-white/70'}`}>
                    {s.speaker && <span className="font-bold text-slate-500 shrink-0">{s.speaker}:</span>}
                    <span className="flex-1"><InlineMd text={s.text} /></span>
                  </button>
                  )
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {qs.length > 0 && (
        <div className="flex flex-col gap-4 mt-3">
          {qs.map((q: any, i: number) => (
            <QuizBody key={`lq-${i}`} number={q.number} question={q.question} statements={q.statements} figures={q.figures}
              choices={q.choices ?? q.options ?? []} answer={q.answer} answerIndex={q.answerIndex ?? q.correctIndex} explanation={q.explanation} type={q.type} marker={q.marker ?? detectedMarker} view={view}
              selected={selected[i]} revealed={revealed} onSelect={(n) => setSelected((s) => ({ ...s, [i]: n }))} />
          ))}
          {view === 'interactive' && !revealed && (
            <div className="flex justify-end">
              <button type="button" onClick={() => setRevealed(true)} className="px-3.5 py-1.5 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-md">{qs.length === 1 ? '정답 확인' : '전체 정답 확인'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SentenceComp({ sentence, tokens, pattern, translation, notes, vocab, groups }: {
  sentence?: string;
  tokens?: Array<{ text: string; role?: string; gloss?: string; form?: string }>;
  pattern?: string;
  translation?: string;
  notes?: string[];
  vocab?: Array<{ word?: string; meaning?: string; pos?: string; partOfSpeech?: string; en?: string; ko?: string; term?: string; kor?: string; definition?: string; def?: string }>;
  groups?: Array<{ label?: string; role?: string; text?: string; depth?: number; modifies?: string; head?: string }>;
}) {
  const toks = Array.isArray(tokens) ? tokens.filter((t) => t && t.text) : [];
  // 구·절 구조(끊어읽기) — AI 부담 줄이려 토큰 인덱스 매칭 대신 text+depth 직접. depth=절 중첩,
  // modifies=수식 관계(어느 구/머리말을 꾸미나). 천일문 곡선 화살표 대신 관계 라벨(반응형 견고).
  const groupList = (Array.isArray(groups) ? groups : [])
    .map((g) => ({
      label: (g?.label ?? g?.role ?? '') as string,
      text: (g?.text ?? '') as string,
      depth: Math.max(0, Math.min(Number(g?.depth) || 0, 4)),
      modifies: (g?.modifies ?? g?.head ?? '') as string,
    }))
    .filter((g) => g.text);
  const noteList = Array.isArray(notes) ? notes.filter(Boolean) : [];
  const vocabList = (Array.isArray(vocab) ? vocab : [])
    .map((w) => ({
      word: (w?.word ?? w?.en ?? w?.term ?? '') as string,
      pos: (w?.pos ?? w?.partOfSpeech ?? '') as string,
      meaning: (w?.meaning ?? w?.ko ?? w?.kor ?? w?.definition ?? w?.def ?? '') as string,
    }))
    .filter((w) => w.word || w.meaning);
  return (
    <div style={PAPER_STYLE} className="rounded-xl border border-[#e9e2d0] bg-[#faf8f0] px-4 py-3.5 sm:px-5 sm:py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {pattern && (
        <div className="mb-2.5">
          <span className="inline-block text-[11px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-2 py-0.5">{pattern}</span>
        </div>
      )}
      {toks.length > 0 ? (
        <SvoTokens tokens={toks} />
      ) : sentence ? (
        <div className="text-[16px] sm:text-[17px] text-slate-800">{sentence}</div>
      ) : null}
      {/* 직독직해 — 각 청크의 뜻을 영어 어순 그대로(왼→오) 이어 읽는 줄. 한국식 어순 재배열이 아니라
          끊어읽기 순서대로. 토큰 gloss 에서 파생(AI 부담 0). natural 번역은 아래 '전체 해석' 으로 분리. */}
      {(() => {
        const direct = toks.filter((t) => t.gloss).map((t) => t.gloss as string);
        return direct.length >= 2 ? (
          <div className="mt-3.5 rounded-lg border border-[#d9cdae] p-3">
            <div className="text-[11px] font-bold text-indigo-500 mb-1">직독직해</div>
            <div className="text-[14px] sm:text-[15px] text-slate-700 leading-relaxed">{direct.join(' / ')}</div>
          </div>
        ) : null;
      })()}
      {groupList.length > 0 && (
        <div className="mt-3.5 rounded-lg border border-[#d9cdae] p-3">
          <div className="text-[11px] font-bold text-indigo-500 mb-2">구·절 구조</div>
          <div className="flex flex-col gap-1">
            {groupList.map((g, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[13px] sm:text-[14px]" style={{ paddingLeft: `${g.depth * 14}px` }}>
                {g.label && <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{g.label}</span>}
                <span className="flex-1 min-w-0 text-slate-700"><InlineMd text={g.text} /></span>
                {g.modifies && <span className="shrink-0 text-[10px] font-medium text-cyan-600 self-center" title="수식 대상">→ {g.modifies}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {translation && (
        <div className="mt-3.5 rounded-lg border border-[#d9cdae] p-3">
          <div className="text-[11px] font-bold text-indigo-500 mb-1">전체 해석</div>
          <div className="text-[14px] sm:text-[15px] text-slate-700"><InlineMd text={translation} /></div>
        </div>
      )}
      {vocabList.length > 0 && <VocabList items={vocabList} />}
      {noteList.length > 0 && (
        <div className="mt-3.5 rounded-lg border border-[#d9cdae] p-3">
          <div className="text-[11px] font-bold text-indigo-500 mb-1.5">문법 포인트</div>
          <ul className="flex flex-col gap-1.5 text-[13px] sm:text-[14px] text-slate-600">
            {noteList.map((n, i) => (
              <li key={i} className="flex gap-1.5"><span className="text-indigo-400 shrink-0">•</span><span className="flex-1"><InlineMd text={n} /></span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function QuizComp({ number, points, question, boxes, figures, statements, choices, answer, answerIndex, explanation, type, marker, view = 'interactive' }: {
  number?: number | string; points?: number | string; question: string; boxes?: string[];
  figures?: ComponentDef[]; statements?: string[]; choices: string[]; answer?: number | string; answerIndex?: number;
  explanation?: string; type?: string; marker?: string | string[]; view?: QuizView;
}) {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  // 빈 quiz(question·choices·statements·boxes 전부 없음) = AI 가 구조화 필드 미채움 → 죽은 박스(질문 0 + 정답확인 버튼만)
  // 대신 안 띄움(정직). listening 빈 script 와 동일 처리.
  const hasContent = (question?.trim()?.length ?? 0) > 0
    || (choices?.length ?? 0) > 0 || (statements?.length ?? 0) > 0 || (boxes?.length ?? 0) > 0;
  if (!hasContent) return null;
  return (
    <div className="my-2">
      {points != null && (
        <div className="text-[11px] text-slate-400 mb-1 text-right">[{typeof points === 'number' ? `${points}점` : String(points)}]</div>
      )}
      <QuizBody
        number={number} question={question} boxes={boxes} figures={figures} statements={statements}
        choices={choices} answer={answer} answerIndex={answerIndex} explanation={explanation} type={type} marker={marker} view={view}
        selected={selected} revealed={revealed} onSelect={setSelected}
      />
      {view === 'interactive' && !revealed && (
        <div className="flex justify-end mt-2">
          <button type="button" onClick={() => setRevealed(true)} className="px-3.5 py-1.5 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-md">정답 확인</button>
        </div>
      )}
    </div>
  );
}

function QuizGroupComp({ passage, boxes, figures, questions, type, marker, view = 'interactive' }: {
  passage?: string; boxes?: string[]; figures?: ComponentDef[];
  questions: Array<{ number?: number | string; question: string; statements?: string[]; choices: string[]; options?: string[]; answer?: number | string; answerIndex?: number; correctIndex?: number; explanation?: string; type?: string; marker?: string | string[]; figures?: ComponentDef[] }>;
  type?: string; marker?: string | string[]; view?: QuizView;
}) {
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [revealed, setRevealed] = useState(false);
  const qs = (questions ?? []).filter((q) => q && ((q.question?.trim()?.length ?? 0) > 0 || (q.choices?.length ?? 0) > 0 || (q.options?.length ?? 0) > 0 || (q.statements?.length ?? 0) > 0));
  // 내용 있는 문항 0 + 공유 지문/도표도 없음 = 빈 quiz_group → 죽은 박스 대신 안 띄움(정직).
  if (qs.length === 0 && !passage && !(boxes?.length) && !(figures?.length)) return null;
  return (
    <div style={PAPER_STYLE} className="border border-[#e9e2d0] rounded-lg p-3 sm:p-4 bg-[#faf8f0] my-2">
      {view !== 'answers' && passage && (
        <div className="border border-[#d9cdae] rounded-md p-3 mb-3 text-[13px] sm:text-[14px] leading-relaxed">
          <TextComp content={passage} />
        </div>
      )}
      {view !== 'answers' && (boxes ?? []).map((b, i) => (
        <div key={`gb-${i}`} className="border border-[#d9cdae] rounded-md p-3 mb-2 text-[13px] sm:text-[14px] leading-relaxed"><TextComp content={b} /></div>
      ))}
      {view !== 'answers' && figures && figures.length > 0 && (
        <div className="mb-3"><ComponentRenderer components={figures} /></div>
      )}
      <div className="flex flex-col gap-4">
        {qs.map((q, i) => (
          <QuizBody
            key={`q-${i}`} number={q.number} question={q.question} statements={q.statements} figures={q.figures}
            choices={q.choices ?? q.options ?? []} answer={q.answer} answerIndex={q.answerIndex ?? q.correctIndex} explanation={q.explanation} type={q.type ?? type} marker={q.marker ?? marker} view={view}
            selected={selected[i]} revealed={revealed} onSelect={(n) => setSelected(s => ({ ...s, [i]: n }))}
          />
        ))}
      </div>
      {view === 'interactive' && !revealed && (
        <div className="flex justify-end mt-3">
          <button type="button" onClick={() => setRevealed(true)} className="px-3.5 py-1.5 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-md">{qs.length === 1 ? '정답 확인' : '전체 정답 확인'}</button>
        </div>
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
  // firebat-render fence(= 텍스트 채널 render) 는 ComponentRenderer 직접 렌더(마크다운 변환 우회).
  const segments = splitFirebatRender(content);
  const md = (s: string) => (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]}>{mdReady(s)}</ReactMarkdown>
  );
  return (
    <div className="text-gray-700 text-[15px] sm:text-[16px] font-normal sm:font-medium leading-relaxed prose prose-sm max-w-none">
      {segments.length === 1 && 'md' in segments[0]
        ? md(segments[0].md)
        : (
          // fence(render 블록) ↔ 텍스트 간격 일관화 — gap-6(ComponentRenderer 내부 블록 간격과 동일).
          <div className="flex flex-col gap-6">
            {segments.map((s, i) =>
              'blocks' in s
                ? <ComponentRenderer key={i} components={s.blocks} />
                : <div key={i}>{md(s.md)}</div>,
            )}
          </div>
        )}
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
      <form onSubmit={handleSubmit} className="bg-white border border-gray-100 rounded-xl p-4 sm:p-6 shadow-sm space-y-4">
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
        <div className="bg-green-50 border border-green-200 p-4 sm:p-5 rounded-xl">
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

function TableComp({ headers = [], rows = [], stickyCol, striped, align, cellAlign, filterable, columnToggle, sortable }: {
  headers: string[]; rows: string[][]; stickyCol?: boolean;
  /** zebra 행 — 짝수 row 배경 살짝 어둡게. 행 많을 때 가독성 ↑. 기본 false. */
  striped?: boolean;
  /** 컬럼별 정렬 — AI 명시 가능. 미지정 시 자동(숫자 컬럼→우측, 그 외→좌측). */
  align?: (AlignOpt | null | undefined)[];
  /** 셀별 정렬 override — cellAlign[ri][ci]. 특정 행·셀만 따로 조절할 때 사용. */
  cellAlign?: ((AlignOpt | null | undefined)[] | null | undefined)[];
  /** 행 검색 — 표 위 검색칸. 입력어가 포함된 행만(셀 전체 대상, 대소문자 무시). 긴 표·모바일에 유용. 기본 false. */
  filterable?: boolean;
  /** 컬럼 토글 — 표 위 컬럼 칩. 보고 싶은 열만 표시(모바일서 넓은 표 좁히기). 기본 false. */
  columnToggle?: boolean;
  /** 헤더 클릭 정렬 — opt-in. 정렬이 의미 있는 표(여러 행 + 비교 가능 컬럼)만 AI 가 켬. 기본 false (정렬 불필요한 표에 ⇅ 노이즈 방지). */
  sortable?: boolean;
}) {
  const t = usePublicTranslations();
  // 헤더 행은 항상 sticky (세로 스크롤 시)
  // stickyCol: 미지정 시 4열 이상이면 자동 활성 (첫 열 = 행 라벨 추정)
  const firstColSticky = stickyCol ?? (headers.length >= 4);

  // viewport quirk 우회 — 모바일 320px / PC 480px 캡 + 비율 보호 (작은 폰 50% / 데스크톱 70%).
  const maxHeightPx = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });

  // 뷰 인터랙티브 (클라 전용, 서버 호출 0): 행 필터 + 컬럼 토글.
  const [query, setQuery] = useState('');
  const [hiddenCols, setHiddenCols] = useState<Set<number>>(() => new Set());
  const toggleCol = useCallback((i: number) => setHiddenCols(prev => {
    const n = new Set(prev);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  }), []);
  // 헤더 클릭 정렬 — 같은 열 재클릭: 오름 → 내림 → **원래 순서(reset)** 3단 순환. sortCol=null = 기본 순서.
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const cycleSort = useCallback((ci: number) => {
    if (sortCol !== ci) { setSortCol(ci); setSortDir('asc'); }
    else if (sortDir === 'asc') setSortDir('desc');
    else setSortCol(null); // 내림 다음 = 원래 순서로 복귀 (별도 reset 버튼 없이 3번째 클릭이 기본순서)
  }, [sortCol, sortDir]);
  // 보이는 열(원본 인덱스 유지) — align/cellAlign 은 원본 ci 로 인덱싱하므로 원본 보존이 중요.
  const visibleCols = headers.map((_, i) => i).filter(i => !hiddenCols.has(i));
  const q = query.trim().toLowerCase();
  // 필터된 행 — 원본 ri 보존({row,origRi}) → cellAlign 정합 유지. striped 는 표시 순서로.
  const shownRows = (filterable && q)
    ? rows.map((row, origRi) => ({ row, origRi })).filter(({ row }) =>
        row.some(cell => String(cell ?? '').toLowerCase().includes(q)))
    : rows.map((row, origRi) => ({ row, origRi }));
  // 정렬된 행 — sortCol 지정 시만. 숫자 인식(쉼표·%·단위·화살표 제거 후 수치) → 수치 비교, 미인식 → 가나다(numeric).
  // 기본 순서(sortCol=null)는 shownRows 그대로 = "기본값 되돌리기".
  const parseSortNum = (v: unknown): number | null => {
    const c = String(v ?? '').replace(/[^0-9.\-]/g, '');
    if (c === '' || c === '-' || c === '.') return null;
    const n = parseFloat(c);
    return Number.isFinite(n) ? n : null;
  };
  // 크로스 스크립트 정렬 순서 — Windows 탐색기 관행: 숫자(0) → 영문(1) → 한글(2) → 기타(3).
  // (localeCompare('ko') 만 쓰면 한글이 영문보다 앞 = Windows 와 반대라 버킷으로 명시.)
  const scriptRank = (s: string): number => {
    const ch = s.trim()[0] ?? '';
    if (/[0-9]/.test(ch)) return 0;
    if (/[A-Za-z]/.test(ch)) return 1;
    if (/[가-힣ㄱ-ㆎ]/.test(ch)) return 2;
    return 3;
  };
  const sortedRows = sortCol === null ? shownRows : [...shownRows].sort((a, b) => {
    const av = String(a.row[sortCol] ?? '').trim(), bv = String(b.row[sortCol] ?? '').trim();
    const an = parseSortNum(av), bn = parseSortNum(bv);
    let cmp: number;
    if (an !== null && bn !== null) {
      cmp = an - bn; // 둘 다 수치(현재가·PER 등) = 수치 비교
    } else {
      const ra = scriptRank(av), rb = scriptRank(bv);
      // 버킷 다르면 숫자→영문→한글→기타 순, 같으면 버킷 내 localeCompare(영문 A-Z / 한글 가나다).
      cmp = ra !== rb ? ra - rb : av.localeCompare(bv, 'ko', { numeric: true });
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

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
    <div className="space-y-2">
      {/* 뷰 인터랙티브 toolbar — filterable/columnToggle opt-in 시만. 클라 전용. */}
      {(filterable || columnToggle) && (
        <div className="flex flex-wrap items-center gap-2">
          {filterable && (
            <div className="relative flex-1 min-w-[140px] max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('common.search')}
                aria-label={t('common.search')}
                className="w-full pl-8 pr-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          )}
          {columnToggle && (
            <div className="flex flex-wrap gap-1.5">
              {headers.map((h, i) => {
                const shown = !hiddenCols.has(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleCol(i)}
                    aria-pressed={shown}
                    className={`px-2 py-1 rounded-md text-[11px] font-semibold border transition-colors ${shown ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-400 line-through'}`}
                  >
                    {cleanPlainText(h)}
                  </button>
                );
              })}
            </div>
          )}
          {filterable && q && (
            <span className="text-[11px] text-gray-400 tabular-nums shrink-0">{shownRows.length} / {rows.length}</span>
          )}
        </div>
      )}
      {/* 박스 max-height = JS 측정 픽셀 (toolbar 변동 무관). SSR fallback = 70vh. */}
      <div
        className="overflow-auto rounded-xl border border-gray-100 shadow-sm scrollbar-thin"
        style={{ maxHeight: maxHeightPx ? `${maxHeightPx}px` : '70vh' }}
      >
        <table className="w-max min-w-full border-separate border-spacing-0">
          <thead>
            <tr>
              {visibleCols.map((ci, pos) => {
                const isStickyCell = firstColSticky && pos === 0;
                const headerText = cleanPlainText(headers[ci]);
                const active = sortCol === ci;
                return (
                  <th
                    key={ci}
                    onClick={sortable ? () => cycleSort(ci) : undefined}
                    // border-b 한 줄만. **sortable 일 때만** 클릭 정렬(cursor·hover·⇅) — 아니면 정적 헤더(정렬 노이즈 0).
                    className={`select-none px-4 py-3 text-[13px] font-bold text-gray-600 uppercase tracking-wider border-b border-gray-100 bg-gray-50 sticky top-0 min-w-[120px] ${sortable ? 'group cursor-pointer hover:bg-gray-100' : ''} ${headerAlignClass(ci, headerText)} ${isStickyCell ? 'left-0 z-20 shadow-[2px_0_0_0_#f3f4f6]' : 'z-10'}`}
                  >
                    <span className="inline-flex items-center gap-1 align-middle">
                      {hasInlineMd(headerText) ? <InlineMd text={headerText} /> : headerText}
                      {sortable && (active ? (
                        // 활성 정렬 — 현재 방향 한쪽만 진한 파랑.
                        <span className="text-[11px] leading-none text-blue-600" aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span>
                      ) : (
                        // 정렬 가능 표시 — 위·아래 한쌍 기호(⇅). 데스크톱=hover 시, 모바일=항상. gray-400 로 셀 배경과 구분.
                        <span className="text-[12px] leading-none text-gray-400 opacity-100 sm:opacity-0 sm:group-hover:opacity-100" aria-hidden>⇅</span>
                      ))}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(({ row, origRi }, pos) => (
              <tr
                key={origRi}
                className={`hover:bg-gray-50 transition-colors ${striped && pos % 2 === 1 ? 'bg-gray-50/40' : ''}`}
              >
                {visibleCols.map((ci, cpos) => {
                  const cell = row[ci] ?? '';
                  const isStickyCell = firstColSticky && cpos === 0;
                  const s = typeof cell === 'string' ? cell.trim() : String(cell);
                  // 색상만 유지 — ▲▼ 패턴 (등락 시각화). 정렬은 column 단위 AI 명시.
                  const isPositive = /^[▲+]/.test(s);
                  const isNegative = /^[▼\-−]/.test(s);
                  const numClass = isPositive ? 'text-red-600 font-semibold' : isNegative ? 'text-blue-600 font-semibold' : '';
                  const displayCell = formatNumberString(cell);
                  return (
                    <td
                      key={ci}
                      className={`px-4 py-3 text-[13px] border-b border-gray-100 align-top min-w-[120px] break-words ${alignClass(ci, origRi)} ${isStickyCell ? 'sticky left-0 z-10 bg-white shadow-[2px_0_0_0_#f3f4f6] font-semibold whitespace-nowrap text-gray-800' : numClass || 'text-gray-800'}`}
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
      <div className="p-4 sm:p-6">
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
  // AI 의 `<\/script>` escape 습관 → srcdoc 에서 스크립트 미닫힘 방지 (closeStrayScript, 공용).
  const safeContent = closeStrayScript(content);
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
  /* 반응형 안전망 — AI 가 고정폭(px) canvas/이미지/표/코드블록을 만들어도 가로 오버플로우(우측 잘림·가로 스크롤) 방지.
     미디어는 부모 너비로 자동 축소(canvas 는 비율 유지). 일반 div 레이아웃엔 영향 0. */
  img, canvas, svg, video, table, pre { max-width: 100% !important; }
  canvas, img, svg, video { height: auto; }
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
${standalone ? `<style>
  /* standalone 앱(페이지 단독 Html) = 자기 레이아웃 소유 — 위 아티클 안전망 무력화. 풀뷰포트 게임/앱이
     #firebat-wrap(1024 박스·padding)·body 패딩·canvas max-width cap 에 갇혀 PC 어긋남·mobile 잘림 나던 root.
     iframe 자체가 100dvh 라 앱의 100vh = iframe 높이로 정확. 콘텐츠도 body 직속(아래 wrap div 생략). */
  body { padding: 0 !important; max-width: none !important; }
  canvas { max-width: none !important; }
  @media (max-width: 640px) {
    body { padding: 0 !important; max-width: none !important; }
    table { width: auto !important; max-width: 100% !important; position: static !important; left: auto !important; right: auto !important; margin-left: 0 !important; margin-right: 0 !important; }
  }
</style>` : ''}
</head><body>${standalone ? safeContent : `<div id="firebat-wrap">${safeContent}</div>`}${autoScript}</body></html>`;

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
// 발행 page 는 Rust sanitize(synonyms blocks→children)를 안 거치므로 여기서 children ?? blocks 직접 수용.
function TabsComp({ tabs }: { tabs: { label: string; children?: ComponentDef[]; blocks?: ComponentDef[] }[] }) {
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
        <ComponentRenderer components={tabs[active].children ?? tabs[active].blocks ?? []} />
      </div>
    </div>
  );
}

// ── Accordion ───────────────────────────────────────────────────────────────
// children(블록) 우선, 없으면 content/text 문자열을 마크다운으로 렌더 (FAQ 답변 = 가장 자연스러운 형태).
function AccordionComp({ items }: { items: { title: string; children?: ComponentDef[]; blocks?: ComponentDef[]; content?: string; text?: string }[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-200">
      {items.map((item, i) => (
        <div key={i}>
          <button
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
            className="w-full flex items-center justify-between px-4 sm:px-5 py-4 text-left hover:bg-gray-50 transition-colors"
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
            <div className="px-4 sm:px-5 pb-4">
              {(item.children ?? item.blocks)
                ? <ComponentRenderer components={item.children ?? item.blocks ?? []} />
                : <TextComp content={item.content ?? item.text ?? ''} />}
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
  // **bold**→<strong> + ==강조==→<mark>(형광펜). 둘 다 escape 뒤 주입이라 rehypeRaw 가 native 렌더.
  return highlightMarksToHtml(s.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>').replace(/\*\*/g, ''));
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
            aria-label="이전"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/25 hover:bg-black/40 backdrop-blur-sm flex items-center justify-center transition-colors"
          >
            <svg className="w-6 h-6 text-white drop-shadow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => go(1)}
            aria-label="다음"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/25 hover:bg-black/40 backdrop-blur-sm flex items-center justify-center transition-colors"
          >
            <svg className="w-6 h-6 text-white drop-shadow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
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
/** 값 하나를 숫자로 강제 — number 그대로 / "1,234" 같은 숫자 문자열 흡수 / 그 외 null. */
function coerceChartNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// 레코드 배열을 series 로 풀 때 라벨 축으로 쓰일 키 (값 series 에서 제외).
const CHART_LABEL_KEYS = new Set(['label', 'name', 'x', 'date', 'category', 'key', 'axis', 'group', 'period', 'year']);
// 단일 값 레코드({label, value})에서 값으로 쓸 키 우선순위.
const CHART_VALUE_KEYS = ['value', 'y', 'amount', 'count', 'total', 'val', 'num'];

/** 객체 배열 → series. AI 가 차트 data 를 레코드 배열로 보내는 흔한 모양 흡수.
 *  (1) {label,value}/{x,y} 류 = 단일 series / (2) {x, metric1, metric2...} 다중 metric = 키별 series. */
function seriesFromObjectArray(arr: Record<string, unknown>[]): ChartSeries[] {
  // (0) Chart.js datasets / series 모양: 각 원소 = {label|name, data|values: number[]}.
  //  AI 가 series/datasets 대신 data 에 datasets 배열을 넣는 흔한 모양 ([object Object]→0 의 실제 원인).
  const datasets = arr.map((o) => {
    const vals = Array.isArray(o?.values) ? o.values : Array.isArray(o?.data) ? (o.data as unknown[]) : null;
    if (!vals) return null;
    const nm = typeof o?.name === 'string' ? o.name : typeof o?.label === 'string' ? (o.label as string) : '';
    return { name: nm, values: vals.map((x) => coerceChartNum(x) ?? 0) };
  });
  if (datasets.length > 0 && datasets.every(Boolean)) return datasets as ChartSeries[];
  // (1) 명시적 단일 값 필드가 있으면 그것만 — 키 하드코딩 아니라 우선순위 탐색.
  for (const vk of CHART_VALUE_KEYS) {
    if (arr.some((o) => coerceChartNum(o?.[vk]) !== null)) {
      return [{ name: '', values: arr.map((o) => coerceChartNum(o?.[vk]) ?? 0) }];
    }
  }
  // (2) 라벨 키를 뺀 모든 숫자 키를 각각 series 로 pivot (다중 metric 레코드).
  const keys: string[] = [];
  for (const o of arr) {
    for (const k of Object.keys(o ?? {})) {
      if (!CHART_LABEL_KEYS.has(k.toLowerCase()) && !keys.includes(k) && coerceChartNum(o[k]) !== null) keys.push(k);
    }
  }
  if (keys.length) return keys.map((k) => ({ name: k, values: arr.map((o) => coerceChartNum(o?.[k]) ?? 0) }));
  return [];
}

function normalizeChartData(
  data: number[] | Record<string, number[]> | unknown,
  explicitSeries?: ChartSeries[]
): ChartSeries[] {
  // explicitSeries — {name,values}(우리식) 또는 {label,data}(Chart.js datasets) 둘 다 흡수.
  if (Array.isArray(explicitSeries) && explicitSeries.length > 0) {
    const mapped = explicitSeries
      .map((s) => {
        const any = s as { name?: string; label?: string; values?: number[]; data?: number[]; color?: string };
        const values = Array.isArray(any.values) ? any.values : Array.isArray(any.data) ? any.data : [];
        return { name: any.name ?? any.label ?? '', values, color: any.color };
      })
      .filter((s) => s.values.length > 0);
    if (mapped.length > 0) return mapped;
    // series = 이름 배열(문자열 또는 값 없는 메타) + data = number[][] (병렬 배열) → 이름·배열 zip 으로 다중 series.
    //  (AI 가 series:["종가","MA5",...] + data:[[...],[...]] 로 보내는 모양 — 명확해서 안전하게 흡수.)
    if (Array.isArray(data) && (data as unknown[]).length > 0 && (data as unknown[]).every((d) => Array.isArray(d))) {
      return (data as unknown[][]).map((vals, i) => {
        const nm = explicitSeries[i] as unknown;
        const name = typeof nm === 'string' ? nm
          : (nm as { name?: string; label?: string } | undefined)?.name ?? (nm as { label?: string } | undefined)?.label ?? `시리즈 ${i + 1}`;
        return { name, values: vals.map((v) => coerceChartNum(v) ?? 0) };
      });
    }
    // series carried only metadata (e.g. [{name:"종가"}]) with no values, but a flat `data` array
    // holds them — a common AI shape. Use the flat data under the first series' name.
    if (Array.isArray(data) && (data as unknown[]).length > 0) {
      const first = explicitSeries[0] as { name?: string; label?: string };
      return [{ name: first?.name ?? first?.label ?? '', values: (data as unknown[]).map((v) => coerceChartNum(v) ?? 0) }];
    }
    // else fall through to the generic data handling below
  }
  if (Array.isArray(data)) {
    const arr = data as unknown[];
    if (arr.length === 0) return [];
    // 숫자(또는 "1,234" 숫자 문자열) 배열 — 단일 series.
    if (arr.every((v) => coerceChartNum(v) !== null)) {
      return [{ name: '', values: arr.map((v) => coerceChartNum(v) as number) }];
    }
    // number[][] (배열의 배열) — 이름 없는 다중 series (series 미동봉 시).
    if (arr.every((v) => Array.isArray(v))) {
      return (arr as unknown[][]).map((vals, i) => ({ name: `시리즈 ${i + 1}`, values: vals.map((v) => coerceChartNum(v) ?? 0) }));
    }
    // 객체 배열 — {label,value} / 다중 metric 레코드 자동 흡수 ([object Object] 방지).
    if (arr.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const s = seriesFromObjectArray(arr as Record<string, unknown>[]);
      if (s.length) return s;
    }
    // 혼합 — 숫자만 강제(비숫자는 0)해 라벨 정합 유지.
    return [{ name: '', values: arr.map((v) => coerceChartNum(v) ?? 0) }];
  }
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
  // 단일 series 의 첫 series.values — bar/pie/doughnut 등 single-series chart 에서 사용
  const firstSeriesData = series[0].values;

  // line chart — multi-series 자연 지원
  if (type === 'line') {
    return <LineChartInteractive series={series} labels={labels} title={title} unit={unit} palette={palette} />;
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

/** "보기 좋은" 축 — 데이터 min/max 를 1/2/5×10ⁿ 간격으로 반올림해 깔끔한 눈금 생성 (D3 nice 동일 알고리즘).
 *  전부 양수면 바닥이 음수로 내려가지 않고(주가 등 보호), 음수가 섞이면 바닥도 음수 nice 값까지 자연 확장. */
function niceAxis(dataMin: number, dataMax: number, tickCount = 4): { min: number; max: number; step: number; ticks: number[] } {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  // 평탄(전부 동일 값) 가드 — 임의 폭 부여
  if (dataMax <= dataMin) {
    const pad = Math.abs(dataMax) > 0 ? Math.abs(dataMax) * 0.1 : 1;
    dataMin -= pad; dataMax += pad;
  }
  const niceNum = (range: number, round: boolean): number => {
    const exp = Math.floor(Math.log10(range));
    const frac = range / Math.pow(10, exp);
    const nf = round
      ? (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10)
      : (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10);
    return nf * Math.pow(10, exp);
  };
  const step = niceNum((dataMax - dataMin) / tickCount, true);
  const min = Math.floor(dataMin / step) * step;
  const max = Math.ceil(dataMax / step) * step;
  const n = Math.round((max - min) / step);
  const ticks = Array.from({ length: n + 1 }, (_, i) => min + i * step);
  return { min, max, step, ticks };
}

/** Multi-series line chart — series 1개일 때 single line + area gradient (기존 동작 보존),
 *  2개 이상일 때 각 series 별 path + 색 (palette) + legend + hover tooltip 에 모든 series 값 표시.
 *  area gradient 는 single 일 때만 (multi 시 겹쳐 가독성 저하). */
function LineChartInteractive({ series, labels, title, unit, palette }: {
  series: ChartSeries[]; labels: string[]; title?: string; unit?: string; palette?: string;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [cursorPos, setCursorPos] = React.useState<{ x: number; y: number } | null>(null);
  // 툴팁이 항상 커서 우/하단에 붙으면 우측·하단 포인트에서 컨테이너 밖으로 밀려 글자가 1자씩
  // 찌그러진다 → 가장자리 근처면 커서 반대쪽으로 뒤집어 표시 (공간 확보).
  const [flip, setFlip] = React.useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  // 모바일은 SVG 가 축소 렌더돼 선·점이 더 가늘게 보임 → viewBox 단위를 키워 보정 (PC 1px/점2 · 모바일 2px/점4).
  const [isMobile, setIsMobile] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  const W = 720, H = 260, padL = 56, padR = 24, padT = 20, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // Y 도메인 — 실제 데이터 min/max 기반 nice 축 (전달 props 가 아닌 series 직접 계산).
  // bar 용 minVal 은 0 강제라 가격축이 음수로 내려가고 눈금도 raw 4등분이라 안 떨어지던 것 동시 해결.
  const flatVals = series.flatMap(s => s.values);
  const dataMin = flatVals.length ? Math.min(...flatVals) : 0;
  const dataMax = flatVals.length ? Math.max(...flatVals) : 1;
  const { min: yMin, max: yMax, step: yStep, ticks: yTickVals } = niceAxis(dataMin, dataMax);
  const yDec = yStep > 0 && yStep < 1 ? Math.min(4, Math.ceil(-Math.log10(yStep))) : 0;
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
  const xStep = Math.max(1, Math.floor(xLen / 6));
  const containerRef = React.useRef<HTMLDivElement>(null);
  // 모바일 롱프레스 툴팁 — 1손가락 드래그=스크롤, 0.5초 누름=툴팁 (StockChart/MTS 표준). 스크롤↔툴팁 충돌 해소.
  const longPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipModeRef = React.useRef(false);  // 롱프레스 진입 후 true — native touchmove 가 스크롤 차단 + 툴팁 추적
  const touchStartRef = React.useRef<{ x: number; y: number } | null>(null);

  // clientX/Y → 가장 가까운 x index + 커서/flip 갱신 (마우스·터치 공용, SVG viewBox 좌표계 기준)
  const pointTo = (clientX: number, clientY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * W;
    let minDist = Infinity, idx = -1;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - relX);
      if (d < minDist) { minDist = d; idx = i; }
    }
    if (idx >= 0) setHovered(idx);
    const px = clientX - rect.left, py = clientY - rect.top;
    setCursorPos({ x: px, y: py });
    // 오른쪽/아래 가장자리 근처(툴팁 폭·높이 추정만큼 공간 부족)면 반대쪽으로 뒤집어 표시.
    setFlip({ x: px > rect.width - 170, y: py > rect.height - 90 });
  };
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => pointTo(e.clientX, e.clientY);
  const clearTip = () => { setHovered(null); setCursorPos(null); };

  // native touchmove — 툴팁 모드일 때만 스크롤 차단(passive:false). 그 외엔 페이지 스크롤 허용.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => { if (tooltipModeRef.current) e.preventDefault(); };
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => el.removeEventListener('touchmove', onMove);
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = setTimeout(() => {
      tooltipModeRef.current = true;
      const s = touchStartRef.current;
      if (s) pointTo(s.x, s.y);
    }, 500);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (tooltipModeRef.current) {
      pointTo(t.clientX, t.clientY);  // 롱프레스 진입 후 — 손가락 추적
    } else if (touchStartRef.current) {
      // 0.5초 전 8px 이상 이동 = 스크롤 의도 → 롱프레스 취소 (툴팁 안 띄움)
      const dx = Math.abs(t.clientX - touchStartRef.current.x);
      const dy = Math.abs(t.clientY - touchStartRef.current.y);
      if ((dx > 8 || dy > 8) && longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    }
  };
  const handleTouchEnd = () => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    tooltipModeRef.current = false;
    touchStartRef.current = null;
    clearTip();
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
        onMouseLeave={clearTip}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{ touchAction: 'pan-y' }}
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
          {yTickVals.map((t, i) => {
            const y = padT + plotH - ((t - yMin) / (yMax - yMin)) * plotH;
            return (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="2 3" />
                <text x={padL - 6} y={y} fill="#94a3b8" fontSize="10" textAnchor="end" dominantBaseline="middle">{t.toLocaleString('ko-KR', { maximumFractionDigits: yDec })}</text>
              </g>
            );
          })}
          {/* single 일 때 area + path, multi 일 때 각 series 의 path 만 (겹침 방지) */}
          {!isMulti && seriesPaths[0] && (
            <path d={seriesPaths[0].area} fill="url(#line-grad-single)" />
          )}
          {seriesPaths.map((sp, si) => (
            <g key={si}>
              <path d={sp.path} fill="none" stroke={sp.color} strokeWidth={isMobile ? 2 : 1} strokeLinecap="round" strokeLinejoin="round" />
              {sp.ys.map((y, i) => hovered === i ? <circle key={i} cx={xs[i]} cy={y} r={isMobile ? 4 : 2} fill={sp.color} /> : null)}
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
  // AI 가 delta 값에 화살표(▲▼↑↓ 등)를 이미 넣어 보내면 deltaArrow 와 겹쳐 "▲▲ 22%p" 중복 → 앞 화살표 제거.
  const deltaText = String(delta ?? '').replace(/^\s*[▲▼△▽↑↓⬆⬇⇧⇩]+\s*/, '');
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
          {deltaArrow} {formatNumberString(deltaText)}
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
        {(items ?? []).filter(Boolean).map((item, i) => {
          const inner = (
            <>
              <div className={`absolute -left-[18px] top-1 w-3 h-3 rounded-full border-2 border-white ${dotColor[item.type ?? 'default']} shadow-sm`} />
              <div className="text-xs text-gray-500 font-mono mb-0.5">{cleanPlainText(item.date ?? '')}</div>
              <div className="font-bold text-sm text-gray-900"><InlineMd text={item.title ?? ''} /></div>
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
  items: Array<{ key?: string; label?: string; value: string | number; highlight?: boolean; href?: string }>;
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
        <div className="px-3 sm:px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-800">
          {cleanPlainText(title)}
        </div>
      )}
      <div className={`grid ${gridCls[columns] ?? gridCls[2]} gap-x-6 px-3 sm:px-4 py-1`}>
        {items.map((item, i) => {
          // 모바일: key↑value↓ 세로 스택(값이 카드 폭 다 씀 → 한글 char-wrap 해도 한글자씩 안 됨). sm+: key|value 가로.
          const rowCls = `flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3 py-2 sm:py-2.5 border-b border-gray-100 ${item.href ? 'hover:opacity-70 transition-opacity cursor-pointer no-underline' : ''}`;
          const inner = (
            <>
              <span className="text-[13px] text-gray-500 shrink-0">{cleanPlainText(item.key || item.label || '')}</span>
              <span className={`text-sm text-left sm:text-right tabular-nums ${item.highlight ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>
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
  // AI 가 steps 를 문자열 배열(["계좌 조회", …])로 보내기도 함 → {title} 객체로 coerce(안 하면 제목만 뜸).
  steps: Array<string | { title: string; description?: string; tool?: string }>;
  estimatedTime?: string;
  risks?: string[];
}) {
  const t = usePublicTranslations();
  const stepObjs = (steps ?? []).map(s => (typeof s === 'string' ? { title: s } : (s ?? { title: '' })));
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
        {stepObjs.map((s, i) => (
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
          <div className="text-[11px] font-bold text-amber-700 mb-1">⚠ {t('plan.risks')}</div>
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
    ? `<circle cx="${c}" cy="${c}" r="${size * 0.22}" fill="white"/><text x="${c}" y="${c}" text-anchor="middle" dy="0.35em" fill="${color}" font-size="${size * 0.28}" font-weight="800" font-family="sans-serif">${grade}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<g transform="scale(${k})"><path d="${HURRICANE_PATH}" fill="${color}" stroke="white" stroke-width="0.6" stroke-linejoin="round"/></g>`
    + center
    + `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}


/** 마커 SVG → displayPx×3 고해상도 PNG 로 supersample 한 <img>(표시 displayPx). 벡터 SVG <img> 는
 *  intrinsic 무시하고 표시크기×DPR 로만 래스터돼 DPR-1 PC 에서 흐릿 → canvas 로 3배 굽고 다운스케일
 *  → 어떤 DPR 에서도 또렷. PNG 준비 전엔 SVG 그대로 보여 깜빡임 없음. (data URI SVG = 동일출처라 taint 0.) */
function crispMarkerImg(svgUrl: string, displayPx: number): HTMLImageElement {
  const el = document.createElement('img');
  el.width = displayPx; el.height = displayPx; el.style.display = 'block';
  el.src = svgUrl;
  const probe = new Image();
  probe.onload = () => {
    try {
      const px = Math.max(1, Math.round(displayPx * 3));
      const cv = document.createElement('canvas'); cv.width = px; cv.height = px;
      const ctx = cv.getContext('2d');
      if (ctx) { ctx.drawImage(probe, 0, 0, px, px); el.src = cv.toDataURL('image/png'); }
    } catch { /* 실패 시 SVG 유지 */ }
  };
  probe.src = svgUrl;
  return el;
}

/** crispMarkerImg 의 PNG data URL 만 비동기 반환 (Kakao MarkerImage 용). 실패/준비전 = SVG. */
function crispMarkerPng(svgUrl: string, displayPx: number, cb: (url: string) => void): void {
  const probe = new Image();
  probe.onload = () => {
    try {
      const px = Math.max(1, Math.round(displayPx * 3));
      const cv = document.createElement('canvas'); cv.width = px; cv.height = px;
      const ctx = cv.getContext('2d');
      if (ctx) { ctx.drawImage(probe, 0, 0, px, px); cb(cv.toDataURL('image/png')); }
    } catch { /* SVG 유지 */ }
  };
  probe.src = svgUrl;
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
    // 마커 = canvas supersample(crispMarkerImg) — 벡터 SVG <img> 가 DPR-1 PC 에서 흐릿하던 것 해소.
    el.appendChild(crispMarkerImg(typhoonSvgUrl(size * 3, tColor, typhoonGradeNum(m.windSpeed)), size));
  } else if (m.icon === 'forecast') {
    // 예상 위치도 현재 위치와 같은 태풍 소용돌이 (현재보다 약간 작게). 밋밋한 원 대신.
    const size = Math.round(markerPixelSize(m.size ?? 'medium', true) * markerDeviceScale());
    const fColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
    el.appendChild(crispMarkerImg(typhoonSvgUrl(size * 3, fColor, typhoonGradeNum(m.windSpeed)), size));
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
            let crispMarker: { url: string; size: number } | null = null; // 태풍 마커 = 생성 후 PNG supersample 교체
            if (m.icon === 'typhoon') {
              const size = Math.round(markerPixelSize(m.size ?? 'large', true) * markerDeviceScale());
              const tColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
              const url = typhoonSvgUrl(size * 3, tColor, typhoonGradeNum(m.windSpeed));
              opts.image = makeDataUriImage(url, size); // PNG 준비 전엔 SVG
              crispMarker = { url, size };
            } else if (m.icon === 'forecast') {
              const size = Math.round(markerPixelSize(m.size ?? 'medium', true) * markerDeviceScale());
              const fColor = typhoonColorByWind(m.windSpeed) ?? colorHex(m.color, '#dc2626');
              const url = typhoonSvgUrl(size * 3, fColor, typhoonGradeNum(m.windSpeed));
              opts.image = makeDataUriImage(url, size);
              crispMarker = { url, size };
            } else if (m.icon && MARKER_ICON_EMOJI[m.icon]) {
              const size = Math.round(markerPixelSize(m.size ?? 'large', true) * markerDeviceScale());
              opts.image = makeEmojiMarkerImage(MARKER_ICON_EMOJI[m.icon], size);
            } else if (m.color) {
              opts.image = makeColorMarkerImage(colorHex(m.color, '#ef4444'), markerPixelSize(m.size, false));
            }
            // icon·color 미지정 — opts.image 비워둠 = 카카오 기본 마커 (빨간 핀). 옛 동작 복원.
            const marker = new w.kakao.maps.Marker(opts);
            marker.setMap(map);
            // 태풍 마커 = canvas supersample — 벡터 SVG MarkerImage 가 DPR-1 PC 에서 흐릿하던 것 해소.
            if (crispMarker) {
              const cm = crispMarker;
              crispMarkerPng(cm.url, cm.size, (png) => marker.setImage(makeDataUriImage(png, cm.size)));
            }
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
        // 컨테이너가 0크기일 때 fitBounds 하면 view 가 깨져(zoom 극단/NaN) 첫 렌더가 빈 화면 → F5(레이아웃
        // 안정) 해야 보이던 것. fitBoundsOnce = 컨테이너가 실제 크기를 가질 때 *한 번만* fit. resize 로 크기가
        // 잡히면 발동 → F5 없이 그려짐. 이미 fit 했으면(=사용자 pan/zoom) 재fit 안 함.
        let didFit = false;
        const fitBoundsOnce = () => {
          if (didFit || !container.clientWidth || !container.clientHeight) return;
          const conePts = safeCones.reduce((a, c) => a + c.points.length, 0);
          if (safeMarkers.length + safeCircles.length + safeLines.length + conePts < 2) { didFit = true; return; }
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
          didFit = true;
        };
        resizeObserver = new ResizeObserver(() => { map.resize(); fitBoundsOnce(); });
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
        // bounds fit — 컨테이너 크기 잡히면 한 번 (위 fitBoundsOnce, resize 로도 발동). 즉시 시도.
        fitBoundsOnce();
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
// loadCdn → @/lib/util/load-cdn (추출 — mermaid/katex/highlight 공용 lazy 로더).

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

// CodeComp → @/app/components/CodeBlock (추출 — render code 컴포넌트 + 채팅/공유 마크다운 펜스 공용).

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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.src ?? (img as any).url ?? ''} alt={img.alt ?? ''} className="max-w-full max-h-full object-contain" />
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
