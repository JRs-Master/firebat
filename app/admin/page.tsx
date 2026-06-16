'use client';

import { useState, useCallback, useEffect, useRef, useMemo, useId } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Cpu, AlertTriangle, Blocks, Ghost, ExternalLink, X, Check, Copy, CheckCheck, ImagePlus, Plus, Square, ListChecks, Share2, Image as ImageIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { CDN_LIBRARIES, IFRAME_CSP_META } from '../../lib/cdn-libraries';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { maskMath } from '../../lib/util/md';
import { Sidebar } from './components/Sidebar';
import { FileEditor } from './components/FileEditor';
import { SettingsModal } from './components/SettingsModal';
import { SystemModuleSettings } from './components/SystemModuleSettings';
import { SecretInput } from './components/ChatWidgets';
import { Tooltip } from './components/Tooltip';
import { FeedbackBadge } from './components/FeedbackBadge';
import { ActiveJobsIndicator } from './components/ActiveJobsIndicator';
import { BlockErrorBoundary } from './components/BlockErrorBoundary';
import { SourceTags } from './components/SourceTags';
import { ComponentRenderer } from '../(user)/[...slug]/components';
import { useChat } from './hooks/useChat';
import { readSetting, writeSetting, setSettingsKeyPrefix } from './hooks/settings-manager';
import { useTranslations } from '../../lib/i18n';
import { THINKING_STATUS, isSuggestionClickUserMessage, isSectionStartBlock, escapeHtmlTagMentions } from './hooks/chat-manager';
import { createShareLink, copyToClipboard } from './hooks/share-helper';
import { Message, PendingAction, StepStatus } from './types';
import { useViewportMaxHeight } from '../../lib/use-viewport-size';
import { logger } from '../../lib/util/logger';
import { apiGet, apiPost } from '../../lib/api-fetch';

/** 마크다운 table wrapper — viewport quirk 우회 + 모바일 320px / PC 480px 캡. */
function MarkdownTableBox(props: any) {
  const maxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });
  return (
    <div
      className="overflow-auto mb-2 rounded-xl border border-slate-200"
      style={{ maxHeight: maxH ? `${maxH}px` : '480px' }}
    >
      <table className="min-w-full text-[13px] border-separate border-spacing-0" {...props} />
    </div>
  );
}

// ─── 마크다운 커스텀 컴포넌트 ───────────────────────────────────────────────
const mdComponents = {
  h1: (props: any) => <h1 className="text-[18px] sm:text-[19px] font-extrabold text-slate-800 mt-5 mb-2" {...props} />,
  h2: (props: any) => <h2 className="text-[16px] sm:text-[17px] font-bold text-slate-800 mt-4 mb-1.5" {...props} />,
  h3: (props: any) => <h3 className="text-[15px] sm:text-[16px] font-bold text-slate-800 mt-3 mb-1" {...props} />,
  h4: (props: any) => <h4 className="text-[15px] font-semibold text-slate-700 mt-2 mb-1" {...props} />,
  p: (props: any) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props: any) => <ul className="list-disc list-outside ml-5 mb-2 space-y-1" {...props} />,
  ol: (props: any) => <ol className="list-decimal list-outside ml-5 mb-2 space-y-1" {...props} />,
  li: (props: any) => <li className="pl-0.5" {...props} />,
  strong: (props: any) => <strong className="font-bold text-slate-900" {...props} />,
  a: (props: any) => <a className="text-blue-600 hover:text-blue-800 underline" target="_blank" rel="noopener noreferrer" {...props} />,
  code: ({ inline, className, children, ...props }: any) => {
    const text = String(children).replace(/\n$/, '');
    const TOOL_NAMES = new Set(['render_iframe','execute','write_file','read_file','save_page','delete_page','delete_file','list_dir','list_pages','get_page','schedule_task','cancel_task','run_task','request_secret','suggest','mcp_call','network_request','list_cron_jobs','list_files']);
    if (TOOL_NAMES.has(text) || text.startsWith('sysmod_') || text.startsWith('mcp_')) {
      return <code className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-100 text-indigo-700 rounded-md text-[13px] font-bold tracking-tight" {...props}>{children}</code>;
    }
    if (inline) {
      return <code className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[13px] font-mono" {...props}>{children}</code>;
    }
    const lang = className?.replace('language-', '') || '';
    return (
      <div className="rounded-xl border border-slate-200 overflow-hidden mb-2">
        {lang && <div className="px-4 py-1.5 bg-slate-100 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wide">{lang}</div>}
        <pre className="bg-slate-50 text-slate-800 p-4 overflow-x-auto text-[13px] font-mono"><code {...props}>{children}</code></pre>
      </div>
    );
  },
  blockquote: (props: any) => <blockquote className="border-l-3 border-slate-300 pl-3 text-slate-600 italic mb-2" {...props} />,
  table: (props: any) => <MarkdownTableBox {...props} />,
  th: (props: any) => <th className="bg-slate-50 px-3 py-1.5 text-left font-bold text-slate-700 sticky top-0 z-10 border-b border-slate-200 min-w-[120px]" {...props} />,
  td: (props: any) => <td className="px-3 py-1.5 text-slate-600 border-b border-slate-100 min-w-[120px] align-top break-words" {...props} />,
  hr: () => <hr className="border-slate-200 my-3" />,
};

function cleanMarkdown(text: string): string {
  // **text** → <strong>text</strong> 변환 (CommonMark 파서가 한국어+따옴표 조합에서 볼드 인식 실패 방지)
  let cleaned = text.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>');
  // 남은 고아 ** 제거
  cleaned = cleaned.replace(/\*\*/g, '');
  // Gemini CLI 사고 과정 마커 — 파서가 놓친 경우 UI 에서 마지막 안전장치로 제거
  //   '[Thought: true]...' 이 한 번이라도 등장하면 그 이후 블록 전체 thought 로 간주하여 삭제
  if (cleaned.includes('[Thought:')) {
    cleaned = cleaned.replace(/\[Thought:\s*(?:true|false)\][\s\S]*?(?=\[Thought:\s*(?:true|false)\]|$)/g, '');
  }
  // AI 가 render_* / PageSpec 컴포넌트를 코드블록에 출력한 경우 제거 (렌더링 안 되고 길게 늘어지는 환각 텍스트)
  // 지원 패턴:
  //   1. "type":"render_xxx" 형태
  //   2. render_xxx(...) 함수 호출 형태
  //   3. "type":"Header"/"Metric"/"Grid" 등 PageSpec 컴포넌트 JSON (AI 가 tool 대신 text 로 뱉음)
  //   4. // 로 시작하는 주석이 있는 json 블록
  //   5. OHLCV/차트용 props 덤프 (symbol + data 배열 + open/high/low/close)
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?["']type["']\s*:\s*["']render_[a-z_]+["'][\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?render_[a-z_]+\s*\([\s\S]*?```/g, '');
  // PageSpec 컴포넌트 JSON (type + props 쌍 1회 이상) — 대부분 AI 가 tool 호출 대신 텍스트로 뱉는 환각
  // 주요 PascalCase 컴포넌트 이름 목록 매치 (의도하지 않은 코드 예시 제거 방지)
  const COMP_NAMES = 'Header|Text|Image|Form|Button|Divider|Table|Card|Grid|Html|Slider|Tabs|Accordion|Progress|Badge|Alert|Callout|List|Carousel|Countdown|Chart|StockChart|Metric|Timeline|Compare|KeyValue|StatusBadge|PlanCard|AdSlot';
  cleaned = cleaned.replace(new RegExp(`\`\`\`[a-zA-Z]*\\s*[\\s\\S]*?["']type["']\\s*:\\s*["'](?:${COMP_NAMES})["'][\\s\\S]*?["']props["']\\s*:[\\s\\S]*?\`\`\``, 'g'), '');
  cleaned = cleaned.replace(/```json\s*\n\s*\/\/[^\n]*\n[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?["']symbol["']\s*:[\s\S]*?["']data["']\s*:\s*\[[\s\S]*?["'](open|close|high|low)["'][\s\S]*?```/g, '');
  return cleaned;
}

function renderMarkdown(text: string) {
  // cleanMarkdown → escapeHtmlTagMentions 순서: JSON/render 블록 제거 후, 남은 텍스트의 HTML 태그 이름 보호.
  // **bold** 가 한국어/괄호 인접 시 commonmark 인식 실패(raw ** 노출) → 명시적 <strong> 변환 (user TextComp 동일).
  // 수식($...$) 보호 → escapeHtmlTagMentions + **bold** 주입이 LaTeX 안 건드리게 → 복원 → remark-math 파싱.
  const { masked, restore } = maskMath(cleanMarkdown(text));
  const withStrong = restore(
    escapeHtmlTagMentions(masked)
      .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*\*/g, ''),
  );
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={mdComponents}>{withStrong}</ReactMarkdown>;
}

// ─── 선택지 버튼 (단일 버튼 + 카드 aggregate: toggle + multi-input + plan-revise) ───
// 핵심 동작:
//   - string / plan-confirm: 클릭 즉시 전송 (단일)
//   - toggle / input / plan-revise: 카드 내 모든 값 집약 → 카드 하단 "전송" 버튼 한 번에
//   - input / plan-revise 는 여러 줄 (칸) 입력 가능. + 버튼 또는 Ctrl/⌘+Enter 로 추가, × 로 제거
//   - 키 매핑:
//     PC (pointer: fine) — Enter=전송(카드 전체), Shift+Enter=해당 칸 줄바꿈, Ctrl/⌘+Enter=새 칸 추가+포커스
//     Mobile (pointer: coarse) — Enter=해당 칸 줄바꿈, 전송/추가는 버튼 탭
function SuggestionButtons({ suggestions, loading, onSuggestion, fullWidth, pickedSuggestion }: {
  suggestions: (string | { type: 'input'; label: string; placeholder?: string } | { type: 'toggle'; label: string; options: string[]; defaults?: string[]; single?: boolean } | { type: 'plan-confirm'; planId: string; label: string } | { type: 'plan-revise'; planId: string; label: string; placeholder?: string })[];
  loading: boolean;
  onSuggestion?: (text: string, meta?: { planExecuteId?: string; planReviseId?: string }) => void;
  fullWidth?: boolean; // 빌드카드 옵션 단계 — 본문 폭 cap(max-w-md) 해제
  pickedSuggestion?: string; // set 이면 잠금 — 인터랙티브 칩 대신 선택 결과만 읽기전용으로(과거 빌드 단계 슬라이드 등)
}) {
  const t = useTranslations();
  // a11y — 매 카드 안 inline 입력 칸의 stable id base. SuggestionButtons 매 마운트마다 unique.
  const inlineInputBaseId = useId();
  // 카드 내 aggregate state
  const [toggleValues, setToggleValues] = useState<Record<number, Set<string>>>({});
  const [inputValues, setInputValues] = useState<Record<number, string[]>>({});  // idx → 여러 칸 배열
  const [customInput, setCustomInput] = useState('');  // 순수 선택지(string-only) 카드의 "직접 입력" 칸
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  // aggregate 항목 (toggle / input / plan-revise) 가 하나라도 있으면 카드 하단 전송 버튼 노출
  const hasAggregate = suggestions.some(it => typeof it !== 'string' && (it.type === 'toggle' || it.type === 'input' || it.type === 'plan-revise'));
  // 순수 선택지 카드(string 버튼만, 입력/토글/플랜 없음) — AI 가 "원하는 거 말하라"며 입력칸을 안 줘도
  // UI 가 항상 "직접 입력" 칸을 보장. AI 행동에 의존하지 않음.
  const pureChoiceCard = suggestions.length > 0 && suggestions.every(it => typeof it === 'string');

  // plan-revise 가 카드에 있으면 전송 시 planReviseId 동봉
  const aggregateMeta = (() => {
    for (const it of suggestions) {
      if (typeof it !== 'string' && it.type === 'plan-revise') return { planReviseId: it.planId };
    }
    return undefined;
  })();

  // suggestions 변경 시 기본값 세팅 — toggle defaults + input 빈 칸 1개. dep = 내용 기반(sigKey): 매 렌더
  // suggestions 가 새 ref 여도 내용 같으면 재실행 X → 탭 전환·리렌더 시 진행 중 토글 선택이 초기화되던 버그 fix.
  const sigKey = JSON.stringify(suggestions);
  useEffect(() => {
    const tInit: Record<number, Set<string>> = {};
    const iInit: Record<number, string[]> = {};
    suggestions.forEach((item, i) => {
      if (typeof item === 'string') return;
      if (item.type === 'toggle') tInit[i] = new Set(item.defaults ?? []); // 기본=빈 선택 (클릭=선택 직관화 — 옛 전체선택은 클릭이 '해제'라 "선택 안 됨" 혼란)
      if (item.type === 'input' || item.type === 'plan-revise') iInit[i] = [''];
    });
    setToggleValues(tInit);
    setInputValues(iInit);
    setCustomInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigKey]);

  const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  const toggleOption = (idx: number, opt: string) => {
    const item = suggestions[idx];
    const single = typeof item !== 'string' && item.type === 'toggle' && !!item.single;
    setToggleValues(prev => {
      if (single) return { ...prev, [idx]: new Set([opt]) }; // 단일선택(radio) — 그것만 선택, 나머지 해제
      const set = new Set(prev[idx] ?? []);
      if (set.has(opt)) set.delete(opt);
      else set.add(opt);
      return { ...prev, [idx]: set };
    });
  };

  const updateInputValue = (idx: number, subIdx: number, value: string) => {
    setInputValues(prev => {
      const arr = [...(prev[idx] ?? [''])];
      arr[subIdx] = value;
      return { ...prev, [idx]: arr };
    });
  };

  const addInputRow = (idx: number, afterSubIdx?: number) => {
    const rows = inputValues[idx] ?? [''];
    const insertAt = afterSubIdx !== undefined ? afterSubIdx + 1 : rows.length;
    setInputValues(prev => {
      const arr = [...(prev[idx] ?? [''])];
      arr.splice(insertAt, 0, '');
      return { ...prev, [idx]: arr };
    });
    // 새 칸으로 포커스
    setTimeout(() => textareaRefs.current[`${idx}-${insertAt}`]?.focus(), 20);
  };

  const removeInputRow = (idx: number, subIdx: number) => {
    setInputValues(prev => {
      const arr = [...(prev[idx] ?? [''])];
      if (arr.length <= 1) return prev;
      arr.splice(subIdx, 1);
      return { ...prev, [idx]: arr };
    });
  };

  // 카드 전체 aggregate 전송 — 모든 toggle + input 값을 label 기준으로 묶어 newline join
  const hasAnyContent = () => {
    for (let i = 0; i < suggestions.length; i++) {
      const item = suggestions[i];
      if (typeof item === 'string') continue;
      if (item.type === 'toggle' && (toggleValues[i]?.size ?? 0) > 0) return true;
      if ((item.type === 'input' || item.type === 'plan-revise') && (inputValues[i] ?? []).some(v => v.trim())) return true;
    }
    return false;
  };

  const handleAggregateSubmit = () => {
    const parts: string[] = [];
    suggestions.forEach((item, i) => {
      if (typeof item === 'string') return;
      if (item.type === 'toggle') {
        const selected = Array.from(toggleValues[i] ?? []);
        if (selected.length > 0) parts.push(`${item.label}: ${selected.join(', ')}`);
      }
      if (item.type === 'input' || item.type === 'plan-revise') {
        const vals = (inputValues[i] ?? []).map(v => v.trim()).filter(Boolean);
        if (vals.length > 0) parts.push(`${item.label}: ${vals.join(' / ')}`);
      }
    });
    const text = parts.join('\n');
    if (!text) return;
    onSuggestion?.(text, aggregateMeta);
  };

  // 순수 선택지 카드의 "직접 입력" 전송 — label 없이 사용자가 친 그대로 raw 전송.
  const submitCustom = () => {
    const v = customInput.trim();
    if (v) onSuggestion?.(v);
  };

  // 렌더 가능한 항목이 하나도 없으면 빈 테두리 박스(가로선처럼 보임)만 남으니 아예 그리지 않음.
  // (AI 가 인식 안 되는 형태로 suggest 를 보낸 경우 — 아래 map 의 coerce 와 같은 기준)
  const canRender = (it: any) =>
    typeof it === 'string'
      ? it.trim().length > 0
      : !!(it && (['plan-confirm', 'toggle', 'input', 'plan-revise'].includes(it.type) || it.label || it.text || it.value || it.title));
  if (!suggestions.some(canRender)) return null;

  // 잠금 — 픽한 칩(과거 빌드 단계 슬라이드 등): 활성 선택 UI 와 똑같은 레이아웃(full-width 버튼) 그대로, 단
  // 비활성 + 선택된 것 강조·나머지 흐리게. picked 텍스트에 그 옵션이 들어있으면 선택으로 간주(toggle 은 ", " 조인 → includes).
  if (pickedSuggestion) {
    const isPicked = (s: string) => !!s && pickedSuggestion.includes(s);
    return (
      <div className={`border border-blue-200/60 rounded-2xl overflow-hidden bg-gradient-to-br from-white to-blue-50/40 shadow-sm w-full ${fullWidth ? '' : 'max-w-md sm:ml-auto'}`}>
        {suggestions.map((item, i) => {
          if (typeof item === 'string') {
            const sel = isPicked(item);
            // 신호등: 선택 항목 — ✕=rose / ✓=emerald / 그 외=blue. 미선택=gray. (마커 string 은 자체 ✕/✓ 라 우측 ✓ 생략.)
            const mk = item.trimStart();
            const cancelMk = /^[✕✗×]/.test(mk);
            const approveMk = /^✓/.test(mk);
            const selCls = !sel ? 'text-slate-400' : cancelMk ? 'bg-rose-50 text-rose-700' : approveMk ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700';
            return (
              <div key={i} className={`w-full flex items-center justify-between gap-2 px-4 py-3 text-[13px] font-medium border-b border-blue-100/70 last:border-b-0 ${selCls}`}>
                <span className="min-w-0">{item}</span>
                {sel && !cancelMk && !approveMk && <span className="shrink-0 text-blue-500" aria-hidden>✓</span>}
              </div>
            );
          }
          if (item.type === 'toggle') {
            return (
              <div key={i} className="flex flex-col px-4 py-3 border-b border-slate-200 last:border-b-0">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{item.label}</span>
                <div className="flex flex-col gap-1 mt-2">
                  {(item.options ?? []).map(opt => {
                    const sel = isPicked(opt);
                    return (
                      <div key={opt} className={`w-full px-4 py-2.5 text-left text-[13px] font-medium rounded-xl border flex items-center justify-between gap-2 ${sel ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-slate-400 border-slate-100'}`}>
                        <span>{opt}</span>
                        {sel && <span className="shrink-0 text-blue-500" aria-hidden>✓</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }
          // input / plan-* — 옵션 없는 자유 입력/액션은 픽 텍스트 그대로(첫 항목에서 한 번만).
          if (i > 0) return null;
          // pickedSuggestion 이 string 항목(✕ 취소 등)과 동일하면 그 string path 가 이미 표시 → fallback skip(중복 방지).
          // (승인 픽 "✓ 실행" 은 string 아님 → fallback 이 표시 + 취소 string 은 gray 로 같이 보임.)
          if (suggestions.some(it => typeof it === 'string' && it.trim() === pickedSuggestion.trim())) return null;
          // pickedSuggestion 이 이미 마커(✓ 실행 / ✕ 취소 / ⚙ 수정) 포함 시 별도 ✓ prepend 금지(✓✓ 중복 방지).
          // 신호등: ✕ 취소 = rose(빨강) / ✓ 승인 = emerald(녹색) / 그 외 = blue(일반 픽). 플랜카드 soft 톤 매칭.
          const trimmedPick = pickedSuggestion.trimStart();
          const cancelPick = /^[✕✗×]/.test(trimmedPick);
          const approvePick = /^✓/.test(trimmedPick);
          const markedPick = /^[✓✕✗×⚙]/.test(trimmedPick);
          const pickTone = cancelPick ? 'text-rose-700 bg-rose-50/60' : approvePick ? 'text-emerald-700 bg-emerald-50/60' : 'text-blue-700 bg-blue-50/60';
          return (
            <div key={i} className={`px-4 py-3 text-[13px] flex items-start gap-1.5 ${pickTone}`}>
              {!markedPick && <span className="font-bold shrink-0 text-blue-500">✓</span>}
              <span className="whitespace-pre-wrap break-words">{pickedSuggestion}</span>
            </div>
          );
        })}
        {/* 직접 입력 — 순수 선택지 카드("직접 입력" 칸)에 친 커스텀 텍스트는 어떤 칩과도 안 맞아 위 map 에
            안 잡힌다. 그 픽을 파란 줄로 카드 맨 밑에 표시(뭘 보냈는지 보이게). input/plan-* 카드는 위
            fallback 이 이미 픽을 표시하므로 string-only 카드일 때만. */}
        {(() => {
          if (suggestions.some(it => typeof it !== 'string')) return null;
          const txt = pickedSuggestion.trim();
          if (!txt) return null;
          if (suggestions.some(it => typeof it === 'string' && pickedSuggestion.includes(it.trim()))) return null;
          return (
            <div className="px-4 py-3 text-[13px] flex items-start gap-1.5 text-blue-700 bg-blue-50/60 border-t border-blue-100/70">
              <span className="font-bold shrink-0 text-blue-500">✓</span>
              <span className="whitespace-pre-wrap break-words">{txt}</span>
            </div>
          );
        })()}
      </div>
    );
  }
  return (
    // PC: max-w-md(448px) 로 capped + sm:ml-auto 로 우측 정렬. 모바일: w-full 로 부모 너비 꽉 채움.
    // w-full 없이 max-w-md 만 두면 content 자연 너비로 줄어드는 문제 — 두 클래스 조합 필수.
    <div className={`border border-blue-200/60 rounded-2xl overflow-hidden bg-gradient-to-br from-white to-blue-50/40 shadow-sm w-full ${fullWidth ? '' : 'max-w-md sm:ml-auto'}`}>
      {suggestions.map((item, i) => {
        if (typeof item === 'string') {
          // 단일 버튼 — 즉시 전송. 신호등: ✓=emerald(승인) / ✕=rose(취소) / 그 외=기본(blue). 플랜카드 soft 톤 매칭.
          const mk = item.trimStart();
          const isCancel = /^[✕✗×]/.test(mk);
          const isApprove = /^✓/.test(mk);
          const btnCls = isCancel
            ? 'text-rose-700 bg-rose-50/50 hover:bg-rose-100 hover:text-rose-800'
            : isApprove
              ? 'text-emerald-700 bg-emerald-50/50 hover:bg-emerald-100 hover:text-emerald-800'
              : 'text-slate-700 hover:bg-blue-50/70 hover:text-blue-800';
          const arrowCls = isCancel ? 'text-rose-300 group-hover:text-rose-500' : isApprove ? 'text-emerald-300 group-hover:text-emerald-500' : 'text-blue-300 group-hover:text-blue-500';
          return (
            <button key={i} onClick={() => onSuggestion?.(item)} disabled={loading}
              className={`group w-full flex items-center justify-between gap-2 px-4 py-3 text-left text-[13px] font-medium transition-colors disabled:opacity-50 border-b border-blue-100/70 last:border-b-0 ${btnCls}`}>
              <span className="min-w-0">{item}</span>
              <span className={`shrink-0 transition-colors ${arrowCls}`} aria-hidden>›</span>
            </button>
          );
        }
        if (item.type === 'plan-confirm') {
          // ✓실행 — 단일 버튼, 즉시 전송 + planExecuteId 동봉
          return (
            <button key={i} onClick={() => onSuggestion?.(item.label, { planExecuteId: item.planId })} disabled={loading}
              className="w-full px-4 py-3 text-left text-[13px] font-bold text-emerald-700 bg-emerald-50/50 hover:bg-emerald-100 transition-colors disabled:opacity-50 border-b border-slate-200 last:border-b-0">
              {item.label}
            </button>
          );
        }
        if (item.type === 'toggle') {
          const selected = toggleValues[i] ?? new Set<string>();
          return (
            <div key={i} className="flex flex-col px-4 py-3 border-b border-slate-200 last:border-b-0">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{item.label}</span>
              <div className="flex flex-col gap-1 mt-2">
                {(item.options ?? []).map(opt => (
                  <button key={opt} onClick={() => toggleOption(i, opt)} disabled={loading}
                    className={`w-full px-4 py-2.5 text-left text-[13px] font-medium rounded-xl transition-colors border ${
                      selected.has(opt) ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-slate-500 border-slate-100 hover:bg-slate-50'
                    } disabled:opacity-50`}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (item.type === 'input' || item.type === 'plan-revise') {
          const isRevise = item.type === 'plan-revise';
          const rows = inputValues[i] ?? [''];
          const bgWrap = isRevise ? 'bg-amber-50/40' : '';
          const borderCls = isRevise ? 'border-amber-300 focus:ring-amber-200' : 'border-blue-300 focus:ring-blue-200';
          return (
            <div key={i} className={`flex flex-col gap-1.5 px-3 py-2.5 border-b border-slate-200 last:border-b-0 ${bgWrap}`}>
              <span className={`text-[11px] font-semibold uppercase tracking-wide ${isRevise ? 'text-amber-600' : 'text-slate-400'}`}>{item.label}</span>
              {rows.map((val, subIdx) => {
                const key = `${i}-${subIdx}`;
                return (
                  <div key={key} className="flex items-start gap-1.5">
                    <textarea
                      ref={el => { textareaRefs.current[key] = el; }}
                      value={val}
                      onChange={e => updateInputValue(i, subIdx, e.target.value)}
                      onKeyDown={e => {
                        // 모바일: Enter=기본(줄바꿈) — 버튼 탭으로만 전송·추가
                        if (isMobile()) return;
                        // PC
                        if (e.key === 'Enter' && e.shiftKey) return;          // Shift+Enter=이 칸 줄바꿈 (기본 동작)
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { // Ctrl/⌘+Enter=새 칸 추가
                          e.preventDefault();
                          addInputRow(i, subIdx);
                          return;
                        }
                        if (e.key === 'Enter') {                              // Enter=카드 전체 전송
                          e.preventDefault();
                          handleAggregateSubmit();
                        }
                      }}
                      placeholder={subIdx === 0 ? (item.placeholder || (isRevise ? '어떻게 수정할까요?' : '입력')) : ''}
                      rows={1}
                      style={{ resize: 'none', overflow: 'hidden' }}
                      onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }}
                      id={`${inlineInputBaseId}-${i}-${subIdx}`}
                      name={`inlineInput-${i}-${subIdx}`}
                      autoComplete="off"
                      aria-label={item.label || (isRevise ? '수정 입력' : '입력')}
                      className={`flex-1 px-3 py-1.5 border rounded-lg text-[13px] text-slate-700 focus:outline-none focus:ring-2 bg-white ${borderCls}`}
                    />
                    {rows.length > 1 && (
                      <Tooltip label={t('admin_page_chat.delete_message')}>
                        <button onClick={() => removeInputRow(i, subIdx)}
                          className="p-1.5 text-slate-400 hover:text-red-500 shrink-0 rounded-md hover:bg-red-50 transition-colors">
                          <X size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
              <button onClick={() => addInputRow(i)} disabled={loading}
                className={`self-start mt-0.5 flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  isRevise ? 'text-amber-600 hover:text-amber-800 hover:bg-amber-100' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                }`}>
                <Plus size={12} /> {t('suggest.add_item')}
              </button>
            </div>
          );
        }
        // type 없는/모르는 객체라도 텍스트 필드(label/text/value/title)가 있으면 버튼으로 coerce —
        // AI 가 비표준 형태로 보낸 옵션이 사라지고 빈 박스만 남던 것 방지 (일반 처리, 케이스 하드코딩 X).
        const coerced = (item as any).label || (item as any).text || (item as any).value || (item as any).title;
        if (coerced) {
          return (
            <button key={i} onClick={() => onSuggestion?.(String(coerced))} disabled={loading}
              className="w-full px-4 py-3 text-left text-[13px] font-medium text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50 border-b border-slate-200 last:border-b-0">
              {String(coerced)}
            </button>
          );
        }
        return null;
      })}
      {/* 순수 선택지 카드엔 "직접 입력" 칸을 항상 노출 — AI 가 input 타입을 안 줘도 사용자가 커스텀 입력 가능 */}
      {pureChoiceCard && (
        <div className="flex items-center gap-1.5 px-3 py-2.5 border-t border-slate-200 bg-slate-100/40">
          <textarea
            ref={el => { textareaRefs.current['__custom'] = el; }}
            value={customInput}
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={e => {
              if (isMobile()) return;                                   // 모바일: Enter=줄바꿈, 버튼으로 전송
              if (e.key === 'Enter' && e.shiftKey) return;              // Shift+Enter=줄바꿈
              if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } // PC: Enter=전송
            }}
            placeholder={t('suggest.custom_placeholder')}
            rows={1}
            style={{ resize: 'none', overflow: 'hidden' }}
            onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }}
            id={`${inlineInputBaseId}-custom`}
            name="customInput"
            autoComplete="off"
            aria-label={t('suggest.custom_aria')}
            className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white"
          />
          <button onClick={submitCustom} disabled={loading || !customInput.trim()}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-[12px] font-bold rounded-full transition-colors shrink-0">
            <Send size={12} />
          </button>
        </div>
      )}
      {/* 카드 하단 공통 전송 버튼 — aggregate 항목 있을 때만 */}
      {hasAggregate && (
        <div className="sticky bottom-0 flex items-center justify-end gap-2 px-3 py-2.5 bg-white border-t border-slate-200">
          <button onClick={handleAggregateSubmit} disabled={loading || !hasAnyContent()}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-[12px] font-bold rounded-full transition-colors shadow-sm">
            <Send size={12} /> {t('suggest.send')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── 자동 높이 iframe — 내부 콘텐츠에 맞춰 높이 자동 확장 ──────────────────
function AutoResizeIframe({ src, initialHeight, dependencies }: { src: string; initialHeight?: string; dependencies?: string[] }) {
  const idRef = useRef('ifr-' + Math.random().toString(36).slice(2, 10));
  const [height, setHeight] = useState(initialHeight || '200px');

  // srcdoc 은 src 가 실제로 바뀔 때만 재계산 — 답변 애니메이션 중 부모 리렌더 때마다
  // 새 srcdoc 문자열을 생성해서 iframe 이 리로드되던 문제 (leaflet 지도 깜빡임 등) 방지
  const srcdoc = useMemo(() => {
    const isFullDoc = src.trim().toLowerCase().startsWith('<!doctype') || src.trim().toLowerCase().startsWith('<html');
    // dependencies 배열 → CDN 태그 합성 (lib/cdn-libraries.ts 카탈로그). AI 가 직접 하지 말고 키만 선언.
    const cdnTags = dependencies && dependencies.length > 0
      ? dependencies.map(k => CDN_LIBRARIES[k]).filter(Boolean).join('\n')
      : '';
    const baseStyle = `<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" /><style>html,body{overflow:hidden !important;font-family:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;color:#1e293b;background:#ffffff;-webkit-font-smoothing:antialiased;}body{font-size:14px;line-height:1.6;}h1,h2,h3,h4,h5,h6{font-weight:700;color:#0f172a;letter-spacing:-0.01em;}h1{font-size:20px;}h2{font-size:17px;}h3{font-size:15px;}table{font-size:13px;}canvas,svg{font-family:inherit !important;}</style>${cdnTags}`;
    const autoScript = `<script>(function(){var id=${JSON.stringify(idRef.current)};var peak=0;function measure(){var b=document.body;if(!b)return 0;return Math.max(b.scrollHeight,b.offsetHeight,Math.ceil(b.getBoundingClientRect().height));}function send(){var h=measure();if(h<=peak)return;peak=h;parent.postMessage({type:'iframe-resize',id:id,height:h},'*');}function attach(){if(!document.body)return;if(window.ResizeObserver)new ResizeObserver(send).observe(document.body);send();}if(document.body)attach();else document.addEventListener('DOMContentLoaded',attach);window.addEventListener('load',send);[100,500,1500,3000].forEach(function(t){setTimeout(send,t);});})();<\/script><script>(function(){var last=null;function toMouse(e){if(!e.touches||e.touches.length!==1)return;var t=e.touches[0];var tg=document.elementFromPoint(t.clientX,t.clientY);if(!tg)return;tg.dispatchEvent(new MouseEvent('mousemove',{clientX:t.clientX,clientY:t.clientY,bubbles:true,cancelable:true,view:window}));last=tg;}document.addEventListener('touchstart',toMouse,{passive:true});document.addEventListener('touchmove',toMouse,{passive:true});document.addEventListener('touchend',function(){if(last){last.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));last=null;}},{passive:true});})();<\/script>`;
    // CSP meta — sandbox=allow-scripts 위에 defense-in-depth.
    // isFullDoc 케이스도 CSP 주입 — AI 가 직접 짠 doc 도 동일 보호. 이미 CSP 설정되어 있으면 중복 무해 (브라우저가 강한 정책 채택).
    return isFullDoc
      ? src
          .replace(/<head[^>]*>/i, m => `${m}${IFRAME_CSP_META}`)
          .replace(/<\/head>/i, baseStyle + '</head>')
          .replace(/<\/body>/i, autoScript + '</body>')
      : `<!DOCTYPE html><html><head>${IFRAME_CSP_META}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${baseStyle}<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:4px;max-width:100vw}img,table{max-width:100%!important;height:auto}canvas{max-width:100%}</style></head><body>${src}${autoScript}</body></html>`;
  }, [src]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'iframe-resize' && e.data?.id === idRef.current && typeof e.data.height === 'number') {
        setHeight(e.data.height + 'px');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <iframe
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      className="w-full border border-slate-200 rounded-xl bg-white block"
      style={{ height, maxWidth: '100%' }}
      title="Inline HTML"
    />
  );
}

// ─── Thinking 블록 — spinner + "생각중" 라벨 + thinkingText 같은 줄 inline 표시.
// 완료 후엔 spinner 끄고 "답변완료" 라벨 유지 (옛 동작 — 응답 끝났는지 사용자가 즉시 인지).
function ThinkingBlock({
  statusText,
  thinkingText,
  isActive,
  isComplete,
}: {
  statusText?: string;
  thinkingText?: string;
  isActive?: boolean;
  isComplete?: boolean;
}) {
  if (!isActive && !isComplete && !thinkingText) return null;
  const sentinelValues = Object.values(THINKING_STATUS);
  const isSentinel = thinkingText ? sentinelValues.includes(thinkingText as (typeof sentinelValues)[number]) : true;
  const label = statusText || (isActive ? '생각중...' : (isComplete ? '답변완료' : ''));
  // "[도구 호출: ...]" / "[계획 정리]" 마커 줄은 본문에 표시하지 않는다 — 도구 호출 진행은 위 단일
  // 상태줄(label: 도구 호출 중)로만. CLI 스트림은 reducer 가 이미 라우팅하지만, API batch·reload 로
  // 들어온 thinkingText 안 마커도 여기서 정리 (실제 추론 텍스트만 본문에 남김).
  const rawBody = (!isSentinel && thinkingText) ? thinkingText : '';
  // 도구 호출/계획 마커 줄 제외 후 한 줄로 합침(개행=공백). 스트림 누적 시 최신(끝) 내용이 흐르듯
  // 계속 갱신되되 화면 높이는 한 줄 고정 — 끝을 보여주려고 rtl 방향 truncate(앞에 …) + <bdi dir=ltr>
  // 로 실제 글자 순서 보존. (옛 줄바꿈 누적 = 화면 높이 왔다갔다 → 단일 라인 ticker.)
  const bodyLine = rawBody
    ? rawBody.split('\n').map((l) => l.trim()).filter((l) => l && !/^\[(도구 호출:|계획 정리)/.test(l)).join('  ')
    : '';
  return (
    <div className="flex items-center gap-2 text-slate-400 min-w-0">
      {isActive && <div className="animate-spin shrink-0"><Cpu size={13} /></div>}
      {!isActive && isComplete && <div className="shrink-0"><Cpu size={13} /></div>}
      {label && <span className="text-[12px] text-slate-500 shrink-0">{label}</span>}
      {bodyLine && (
        <span
          className="text-[12px] text-slate-400 flex-1 min-w-0 truncate text-left"
          style={{ direction: 'rtl' }}
        >
          <bdi style={{ direction: 'ltr' }}>{bodyLine}</bdi>
        </span>
      )}
    </div>
  );
}

// ─── 복사 버튼 ─────────────────────────────────────────────────────────────────
function fallback(text: string, onOk: () => void) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) onOk();
  } catch { /* 무시 */ }
}

/** chat block (text / html / component) → 복사용 마크다운 직렬화.
 *  컴포넌트 종류별로 사람이 읽기 좋은 형태로 변환 — 표는 |---| 표, Metric 은 "라벨: 값" 등. */
function serializeBlockToMarkdown(b: any): string {
  if (!b || typeof b !== 'object') return '';
  if (b.type === 'text') return String(b.text || '').trim();
  if (b.type === 'html') return ''; // iframe 콘텐츠는 복사 제외 (HTML 원문 노출 부적절)
  if (b.type !== 'component') return '';
  const name = b.name as string;
  const p = (b.props || {}) as Record<string, any>;
  switch (name) {
    case 'Header': return `${'#'.repeat(Math.min(Math.max(p.level || 2, 1), 6))} ${p.text ?? ''}`.trim();
    case 'Text': return String(p.content ?? '').trim();
    case 'Divider': return '---';
    case 'Table': {
      const headers = Array.isArray(p.headers) ? p.headers : [];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      if (headers.length === 0) return '';
      const headerLine = `| ${headers.join(' | ')} |`;
      const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;
      const rowLines = rows.map((r: any[]) => `| ${r.map(c => String(c ?? '')).join(' | ')} |`);
      return [headerLine, sepLine, ...rowLines].join('\n');
    }
    case 'Metric': {
      const parts = [`**${p.label ?? ''}**: ${p.value ?? ''}${p.unit ? ' ' + p.unit : ''}`];
      if (p.delta != null) parts.push(`(Δ ${p.delta})`);
      if (p.subLabel) parts.push(`— ${p.subLabel}`);
      return parts.join(' ').trim();
    }
    case 'KeyValue': {
      const items = Array.isArray(p.items) ? p.items : [];
      const lines = items.map((it: any) => `- **${it.key ?? ''}**: ${it.value ?? ''}`);
      return p.title ? `**${p.title}**\n${lines.join('\n')}` : lines.join('\n');
    }
    case 'List': {
      const items = Array.isArray(p.items) ? p.items : [];
      const ordered = !!p.ordered;
      return items.map((it: string, i: number) => `${ordered ? `${i + 1}.` : '-'} ${it}`).join('\n');
    }
    case 'Alert':
    case 'Callout': {
      const icon = name === 'Alert' ? '⚠' : 'ℹ';
      return `${icon} ${p.title ? `**${p.title}** — ` : ''}${p.message ?? ''}`;
    }
    case 'Badge':
    case 'StatusBadge': {
      if (Array.isArray(p.items)) return p.items.map((it: any) => `[${it.label ?? ''}]`).join(' ');
      return `[${p.text ?? ''}]`;
    }
    case 'Progress':
      return `**${p.label ?? ''}**: ${p.value ?? 0}${p.max ? ` / ${p.max}` : ''}`;
    case 'Countdown':
      return `**${p.label ?? '카운트다운'}**: ${p.targetDate ?? ''}`;
    case 'Compare': {
      const lh = p.left?.label ?? 'A';
      const rh = p.right?.label ?? 'B';
      const allKeys = new Set<string>();
      (p.left?.items ?? []).forEach((it: any) => allKeys.add(it.key));
      (p.right?.items ?? []).forEach((it: any) => allKeys.add(it.key));
      const lMap = new Map((p.left?.items ?? []).map((it: any) => [it.key, it.value]));
      const rMap = new Map((p.right?.items ?? []).map((it: any) => [it.key, it.value]));
      const lines = [
        p.title ? `**${p.title}**` : '',
        `| 항목 | ${lh} | ${rh} |`,
        `| --- | --- | --- |`,
        ...Array.from(allKeys).map(k => `| ${k} | ${lMap.get(k) ?? '-'} | ${rMap.get(k) ?? '-'} |`),
      ].filter(Boolean);
      return lines.join('\n');
    }
    case 'Timeline': {
      const items = Array.isArray(p.items) ? p.items : [];
      return items.map((it: any) => `- **${it.date ?? ''}** ${it.title ?? ''}${it.description ? ` — ${it.description}` : ''}`).join('\n');
    }
    case 'PlanCard': {
      const steps = Array.isArray(p.steps) ? p.steps : [];
      const stepLines = steps.map((s: any, i: number) => `${i + 1}. **${s.title ?? ''}**${s.description ? ` — ${s.description}` : ''}${s.tool ? ` [${s.tool}]` : ''}`);
      const lines = [
        `## 📋 ${p.title ?? '플랜'}`,
        ...stepLines,
        p.estimatedTime ? `_⏱ 예상 소요: ${p.estimatedTime}_` : '',
        ...(Array.isArray(p.risks) && p.risks.length > 0 ? ['', '**⚠ 주의사항**', ...p.risks.map((r: string) => `- ${r}`)] : []),
      ].filter(Boolean);
      return lines.join('\n');
    }
    case 'Chart':
    case 'StockChart':
      return `[${name === 'StockChart' ? '주식 차트' : '차트'}: ${p.title ?? p.symbol ?? ''}]`;
    case 'Image':
      return p.alt ? `![${p.alt}](${p.src ?? ''})` : `![](${p.src ?? ''})`;
    default:
      return '';
  }
}

function CopyButton({ text }: { text: string }) {
  const tr = useTranslations();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const showOk = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    // 1) 모던 clipboard API (secure context)
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(showOk).catch(() => fallback(text, showOk));
      return;
    }
    // 2) 폴백 (execCommand)
    fallback(text, showOk);
  }, [text]);
  return (
    <div className="relative inline-flex">
      <Tooltip label={tr('common.copy')}>
        <button
          onClick={handleCopy}
          className="p-1 rounded text-slate-300 hover:text-slate-500 transition-colors"
        >
          {copied ? <CheckCheck size={14} className="text-emerald-500" /> : <Copy size={14} />}
        </button>
      </Tooltip>
      <FeedbackBadge state={copied ? 'ok' : null} okLabel="복사됨" absolute />
    </div>
  );
}

/** 단일턴 (user + AI 응답 한 쌍) 공유 버튼. 복사 버튼 옆에 배치.
 *  POST /api/share 로 24시간 TTL 공유 slug 생성 → 클립보드 복사 + 토스트.
 *  Hub mode 이면 POST /api/hub/<slug>/share 로 분기 (anonymous + apiToken). */
function ShareTurnButton({ messages, conversationId, title, msgId, hubContext }: { messages: unknown[]; conversationId: string; title?: string; msgId?: string; hubContext?: { slug: string; apiToken: string; sessionId: string } }) {
  const t = useTranslations();
  const [status, setStatus] = useState<'idle' | 'sharing' | 'done' | 'error'>('idle');
  const handleShare = useCallback(async () => {
    if (status === 'sharing') return;
    setStatus('sharing');
    // 백엔드 DB 가 dedupKey 기반 재사용 담당 — 24h 내 같은 메시지 공유 요청이면 기존 slug 반환
    const dedupKey = msgId ? `turn:${conversationId}:${msgId}` : undefined;
    const res = await createShareLink({ type: 'turn', conversationId, title, messages, dedupKey, hubContext });
    if ('error' in res) {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2200);
      return;
    }
    const ok = await copyToClipboard(res.url);
    setStatus(ok ? 'done' : 'error');
    setTimeout(() => setStatus('idle'), 2200);
  }, [messages, conversationId, title, status, msgId, hubContext]);
  const badgeState: 'ok' | 'err' | 'loading' | null =
    status === 'done' ? 'ok' : status === 'error' ? 'err' : status === 'sharing' ? 'loading' : null;
  return (
    <div className="relative inline-flex">
      <Tooltip label={t('admin_page_chat.share_response')}>
        <button
          onClick={handleShare}
          disabled={status === 'sharing'}
          className="p-1 rounded text-slate-300 hover:text-slate-500 transition-colors disabled:opacity-50"
        >
          {status === 'done' ? <CheckCheck size={14} className="text-emerald-500" /> : <Share2 size={14} />}
        </button>
      </Tooltip>
      <FeedbackBadge state={badgeState} okLabel="링크 복사됨" errLabel="공유 실패" loadingLabel="생성 중" absolute />
    </div>
  );
}

// ─── 액션 태그 (에러 시 빨간색 + 클릭 펼침) ──────────────────────────────────
function ActionTags({ actions, steps, toolResults }: { actions: string[]; steps?: StepStatus[]; toolResults?: import('./types').ToolResultSummary[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // 같은 도구 중복은 하나로 합치고 호출 횟수를 xN으로 표시
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const a of actions) {
    if (!counts.has(a)) order.push(a);
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  // 도구 이름 → toolResults 안 fail 결과 매칭 (옛 TS 에러 뱃지 메커니즘 1:1).
  const errorFromTool = (action: string): string | null => {
    const t = toolResults?.find(r => r.name === action && !r.success);
    return t?.error || null;
  };
  // 도구 이름 → toolResults 안 input 매칭 (success/fail 무관, 첫 매칭). 같은 도구 N회 호출 시 첫 호출만.
  const inputFromTool = (action: string): unknown => {
    const t = toolResults?.find(r => r.name === action);
    return t?.input;
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {order.map((action, i) => {
          const step = steps?.find(s => s.type === action && s.status === 'error');
          const toolErr = errorFromTool(action);
          const isError = !!step || !!toolErr;
          const n = counts.get(action) || 1;
          return (
            <div
              key={i}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer transition-colors ${isError ? 'bg-red-50 border border-red-100 text-red-600 hover:bg-red-100' : 'bg-slate-50 border border-slate-200 text-slate-500 hover:bg-slate-100'}`}
              onClick={() => setOpenIdx(openIdx === i ? null : i)}
            >
              {isError ? <AlertTriangle size={10} className="text-red-400" /> : <Blocks size={10} className="text-slate-400" />}
              {action}{n > 1 && <span className="text-slate-400 ml-0.5">×{n}</span>}
            </div>
          );
        })}
      </div>
      {openIdx !== null && (() => {
        const action = order[openIdx];
        const step = steps?.find(s => s.type === action && s.status === 'error');
        const toolErr = errorFromTool(action);
        const errMsg = step?.error || toolErr;
        const input = inputFromTool(action);
        return (
          <div className="flex flex-col gap-1.5">
            {errMsg && (
              <div className="px-3 py-2 bg-red-50/50 border border-red-100 rounded-md text-[12px] font-mono text-red-600 leading-relaxed break-all">
                {errMsg}
              </div>
            )}
            {input !== undefined && input !== null && (
              <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-[11px] font-mono text-slate-600 leading-relaxed break-all whitespace-pre-wrap">
                {JSON.stringify(input, null, 2)}
              </div>
            )}
            {!errMsg && (input === undefined || input === null) && (
              <div className="px-3 py-2 text-[11px] text-slate-400 italic">호출 정보 없음</div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ─── 에러 접이식 박스 ──────────────────────────────────────────────────────────
function ErrorCollapsible({ error, label }: { error: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 w-fit max-w-full">
      <div
        className="flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-100 text-red-600 rounded text-[11px] font-medium cursor-pointer hover:bg-red-100 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <AlertTriangle size={10} className="text-red-400 shrink-0" />
        <span>{label || '오류 발생'}</span>
      </div>
      {open && (
        <div className="px-3 py-2 bg-red-50/50 border border-red-100 rounded-md text-[12px] font-mono text-red-600 leading-relaxed break-all">
          {error}
        </div>
      )}
    </div>
  );
}

// ─── 메시지 버블 ─────────────────────────────────────────────────────────────
/** Localized pending-action summary — rebuilt from name+args so hub visitors (and any non-ko UI) see
 *  it in their own language. Falls back to the backend-generated p.summary for unknown tool names. */
function planSummary(
  p: PendingAction,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const a = (p.args ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (p.name) {
    case 'save_page': return t('plan.summary_save_page', { slug: s('slug') });
    case 'delete_page': return t('plan.summary_delete_page', { slug: s('slug') });
    case 'write_file': return t('plan.summary_write_file', { path: s('path') });
    case 'delete_file': return t('plan.summary_delete_file', { path: s('path') });
    case 'schedule_task': return t('plan.summary_schedule', { title: s('title') || s('targetPath') });
    case 'cancel_cron_job': return t('plan.summary_cancel_cron', { job: s('jobId') });
    default: return p.summary || '';
  }
}

/** Project Builder 빌드 카드 상태 — AiResponse.buildSession 직렬화 ({id, step, tier, status, createdAt}). */
type BuildSessionView = { id?: string; step?: string; tier?: string; status?: string; createdAt?: number; request?: string };
/** 빌드 세션의 한 단계(슬라이드) — 그 단계 메시지의 state + 칩/픽/pending. */
type BuildStageEntry = { msgId: string; state: BuildSessionView; suggestions?: Message['suggestions']; pickedSuggestion?: string; pendingActions?: PendingAction[] };
/** 빌드 카드 1개 = 세션의 단계들(슬라이드 캐러셀). anchor(마지막) 메시지에만 전달, 앞 단계 메시지는 fold. */
type BuildCardData = { stages: BuildStageEntry[] };

// 빌드 라이브 상태 도구명 → 친숙어 i18n 키 매핑. 매핑 없으면 정리된 이름(공백) fallback.
// (옛엔 raw 도구 id 가 그대로 노출돼 "write file" 같은 영문이 보였음 — 사용자 지적.)
const BUILD_TOOL_LABEL: Record<string, string> = {
  write_file: 'build.tool.write',
  save_page: 'build.tool.save_page',
  render: 'build.tool.render',
  run_module: 'build.tool.run_module',
  start_build: 'build.tool.build',
  advance_build: 'build.tool.build',
  propose_plan: 'build.tool.plan',
  search_components: 'build.tool.search',
};

// 빌드 라이브 상태 — 팩맨(루프·게임) 대신 실제 진행을 피드로. status(="도구 호출 중: render" 등 = lastMsg.statusText)가
// 바뀔 때마다 누적해 ✓도구 / ⟳현재 로 표시. thinking 의존 0 (CLI stream-json 회귀로 thinking 비어도 status·도구는 옴).
// 완료 시 단일 "완성했어요" 로 끝(루프 X). 진행바 = 슬라이딩 indeterminate(가짜 % 아님, "작업 중" 표시).
function BuildLiveStatus({ status, done }: { status?: string; done?: boolean }) {
  const t = useTranslations();
  const [hist, setHist] = useState<string[]>([]);
  useEffect(() => {
    const raw = (status || '').replace(/^도구 호출 중:\s*/, '').replace(/^sysmod[_-]/, '').trim();
    if (!raw) return;
    const key = BUILD_TOOL_LABEL[raw];
    const label = key ? t(key) : raw.replace(/_/g, ' ').trim();
    setHist(h => (h[h.length - 1] === label ? h : [...h.slice(-5), label])); // 최근 6개 — 직전과 다르면 누적
  }, [status, t]);
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full w-full px-4">
      <FirebatGhostAssembly size={56} variant="accent" settled={done} />
      {done ? (
        // 완료 — 단일 "완성했어요" (옛 "만드는 중이에요" + "✓ 완료" 중복 제거).
        <div className="text-[13px] font-bold text-emerald-600">✓ {t('build.completed')}</div>
      ) : (
        <>
          <div className="w-full max-w-[240px] flex flex-col gap-1">
            {hist.length === 0 ? (
              <div className="flex items-center gap-1.5 text-[12px]">
                <span className="text-blue-500 animate-pulse" aria-hidden>⟳</span>
                <span className="text-slate-600 font-medium">{t('build.making')}</span>
              </div>
            ) : hist.map((h, i) => {
              const isCur = i === hist.length - 1;
              return (
                <div key={`${i}-${h}`} className="flex items-center gap-1.5 text-[12px]">
                  <span className={`shrink-0 ${isCur ? 'text-blue-500 animate-pulse' : 'text-emerald-500'}`} aria-hidden>{isCur ? '⟳' : '✓'}</span>
                  <span className={`truncate ${isCur ? 'text-slate-700 font-semibold' : 'text-slate-400'}`}>{h}</span>
                </div>
              );
            })}
          </div>
          {/* 슬라이딩 indeterminate — 한 자리서 펄스(stuck 처럼 보임) 대신 좌→우로 흘러 "작업 중" 표현. */}
          <div className="w-full max-w-[240px] h-1 rounded-full bg-slate-200/70 overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-blue-300 to-blue-500 firebat-bar-slide" />
          </div>
        </>
      )}
    </div>
  );
}

// Project Builder 빌드 카드 — 세션의 단계들을 한 카드 안 캐러셀(슬라이더)로. 헤더 stepper(최신 기준) + 본문은
// 보고 있는 단계(viewIdx, 기본=최신, auto-follow). 옵션 단계=칩(과거=잠김/현재=활성) / 구현=라이브 상태 피드.
function BuildCard({ stages, loading, building, buildStatus, onSuggestion, onLockSuggestion }: {
  stages: BuildStageEntry[];
  loading: boolean;
  building?: boolean; // 다음 단계 생성 중 — 최신 슬라이드 본문을 팩맨(대기 애니)으로.
  buildStatus?: string; // 생성 중 라이브 상태(도구 호출 등) — 팩맨 캡션 "단계 · 상태".
  onSuggestion?: (text: string, meta?: { planExecuteId?: string; planReviseId?: string }) => void;
  onLockSuggestion?: (msgId: string, picked: string) => void;
}) {
  const t = useTranslations();
  const last = stages.length - 1;
  const [viewIdx, setViewIdx] = useState(last);
  const prevLen = useRef(stages.length);
  useEffect(() => {
    // auto-follow — 최신 보던 중이면 새 단계로 따라감 / 과거 리뷰 중이면 유지(+ '최신으로' cue).
    setViewIdx(v => (v >= prevLen.current - 1 ? stages.length - 1 : v));
    prevLen.current = stages.length;
  }, [stages.length]);
  const vi = Math.min(viewIdx, last);
  const latest = stages[last];
  const bs = latest.state;
  const STEPS = [
    { key: 'requirements', label: t('build.step_requirements') },
    { key: 'design', label: t('build.step_design') },
    { key: 'refine', label: t('build.step_refine') },
    { key: 'implement', label: t('build.step_implement') },
  ];
  const expired = !!bs.createdAt && Date.now() - bs.createdAt > 30 * 24 * 60 * 60 * 1000;
  const done = bs.status === 'completed'
    || (bs.step === 'implement' && (latest.pendingActions ?? []).some(p => p.name === 'save_page' && p.status === 'approved'));
  const curIdx = STEPS.findIndex(s => s.key === bs.step);
  const stage = stages[vi];
  const onLatest = vi === last;
  // 로더(라이브 상태)는 **구현(앱 빌드)** 때만 — 구현 단계 OR 최신서 (완료 OR 구현 생성 중). 옛 `onLatest && building`
  // 은 디자인→검토 같은 옵션 단계 생성에도 떠서(사용자: "디자인부터 팩맨") 다음 생성 단계가 implement 일 때로 한정.
  const genNextImplement = !!building && curIdx >= 0 && STEPS[Math.min(curIdx + 1, STEPS.length - 1)].key === 'implement';
  const stageImplement = stage.state.step === 'implement' || (onLatest && (done || genNextImplement));
  const stageChips = !!stage.suggestions && stage.suggestions.length > 0
    && !stage.pendingActions?.some(p => p.status === 'past-runat');
  return (
    <div className="mt-2 rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-slate-50 shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 border-b border-blue-200/60">
        <span className="text-[12px] font-bold text-slate-700 whitespace-nowrap">🔨 {t('build.in_progress')}{bs.tier ? ` · ${bs.tier}` : ''}</span>
        <div className="flex items-center gap-1 flex-wrap">
          {STEPS.map((s, i) => {
            const stepDone = done || i < curIdx;
            const cur = !done && i === curIdx;
            const stageIdx = stages.findIndex(st => st.state.step === s.key);
            return (
              <div key={s.key} className="flex items-center gap-1">
                <button type="button" disabled={stageIdx < 0} onClick={() => { if (stageIdx >= 0) setViewIdx(stageIdx); }}
                  className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                    stepDone ? 'bg-blue-100 text-blue-700'
                    : cur ? 'bg-blue-600 text-white font-bold ring-2 ring-blue-200 step-pulse'
                    : 'bg-white text-slate-400 border border-slate-200'
                  } ${stageIdx >= 0 ? 'cursor-pointer' : 'cursor-default'} ${stageIdx === vi && stageIdx >= 0 ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}>
                  {stepDone ? '✓ ' : `${i + 1}. `}{s.label}
                </button>
                {i < STEPS.length - 1 && <span className={`text-[10px] ${i < curIdx ? 'text-blue-400' : 'text-slate-300'}`}>→</span>}
              </div>
            );
          })}
        </div>
        {done && <span className="text-[11px] text-emerald-600 font-semibold ml-auto">✓ {t('build.done')}</span>}
        {expired && <span className="text-[11px] text-slate-400 ml-auto">⏰ {t('build.expired')}</span>}
      </div>
      {stageImplement ? (
        <div className="p-3 h-[310px] flex items-center justify-center"><BuildLiveStatus done={done} status={buildStatus} /></div>
      ) : (
        <div className="flex flex-col gap-2.5 p-3 h-[310px]">
          <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500 shrink-0">
            <FirebatGhostAssembly size={36} variant="accent" />
            <span>{onLatest ? t('build.preparing') : (STEPS.find(s => s.key === stage.state.step)?.label ?? '')}</span>
          </div>
          {stageChips && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SuggestionButtons
                suggestions={stage.suggestions!}
                loading={loading}
                fullWidth
                pickedSuggestion={stage.pickedSuggestion}
                onSuggestion={(text, meta) => { onLockSuggestion?.(stage.msgId, text); onSuggestion?.(text, meta); }}
              />
            </div>
          )}
        </div>
      )}
      {stages.length > 1 && (
        <div className="flex items-center justify-center gap-3 px-3 py-2 border-t border-blue-200/50 bg-white/40">
          <button type="button" disabled={vi <= 0} onClick={() => setViewIdx(Math.max(0, vi - 1))} className="text-[14px] text-slate-500 disabled:opacity-30 hover:text-slate-700">←</button>
          <div className="flex items-center gap-1">
            {stages.map((_, i) => <span key={i} className={`w-1.5 h-1.5 rounded-full ${i === vi ? 'bg-blue-600' : 'bg-slate-300'}`} />)}
          </div>
          <button type="button" disabled={vi >= last} onClick={() => setViewIdx(Math.min(last, vi + 1))} className="text-[14px] text-slate-500 disabled:opacity-30 hover:text-slate-700">→</button>
          {vi < last && <button type="button" onClick={() => setViewIdx(last)} className="text-[11px] text-blue-600 hover:underline ml-1">{t('build.view_latest')}</button>}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, loading, onSuggestion, onLockSuggestion, onApprovePending, onRejectPending, onApprovePendingAction, shareContext, hubContext, buildCard, building, buildStatus }: {
  msg: Message;
  loading: boolean;
  onSuggestion?: (text: string, meta?: { planExecuteId?: string; planReviseId?: string }) => void;
  onLockSuggestion?: (msgId: string, picked: string) => void;
  onApprovePending?: (msgId: string, planId: string) => void;
  onRejectPending?: (msgId: string, planId: string) => void;
  onApprovePendingAction?: (msgId: string, planId: string, action: 'now' | 'reschedule', newRunAt?: string) => void;
  /** 단일턴 공유용 — user 메시지 + 현재 system 메시지 쌍. 없으면 공유 버튼 숨김. */
  shareContext?: { conversationId: string; turnMessages: unknown[] };
  /** Hub page mode — share 호출 시 /api/hub/<slug>/share 분기 (anonymous + apiToken). */
  hubContext?: { slug: string; apiToken: string; sessionId: string };
  /** Project Builder — 이 메시지가 빌드 세션의 카드 위치(최신 빌드 메시지)면 그 세션의 stepper state + 미리보기.
   *  백엔드 멀티턴이어도 세션당 카드 1개로 보이게 부모가 그룹핑해 전달. undefined = 카드 안 그림. */
  buildCard?: BuildCardData;
  /** 이 빌드 카드가 다음 단계 생성 중(loading) — 카드 본문을 팩맨(대기 애니)으로. */
  building?: boolean;
  /** 생성 중 라이브 상태(도구 호출 등) — 팩맨 캡션 "단계 · 상태". */
  buildStatus?: string;
}) {
  const t = useTranslations();
  // 초기 인사 메시지 — 히어로 (스크롤에 밀려 올라가며 사라짐)
  if (msg.id === 'system-init') {
    return (
      <div className="flex flex-col items-center justify-center gap-5 py-20 sm:py-32 select-none">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-indigo-100 to-blue-200 border border-blue-200 flex items-center justify-center shadow-lg">
          <Ghost size={36} className="text-blue-600 sm:hidden" />
          <Ghost size={44} className="text-blue-600 hidden sm:block" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="text-[22px] sm:text-[28px] font-extrabold tracking-tight text-slate-800">Firebat</h1>
          <p className="text-slate-400 text-[13px] sm:text-[15px] font-medium italic tracking-wide">Just Imagine. Firebat Runs.</p>
        </div>
      </div>
    );
  }

  if (msg.role === 'user') {
    return (
      <div className="flex w-full gap-4 items-start justify-end">
        <div className="flex flex-col gap-2 max-w-[75%] items-end">
          {msg.image && (
            <img src={msg.image} alt="첨부 이미지" className="max-w-[240px] max-h-[180px] rounded-2xl border border-slate-600 shadow-md object-cover" />
          )}
          <div className="bg-slate-800 text-white px-4 py-3 sm:px-6 sm:py-4 rounded-3xl rounded-tr-sm shadow-md text-[15px] sm:text-[16px] font-normal sm:font-medium leading-relaxed break-words border border-slate-700 w-fit">
            {msg.content}
          </div>
        </div>
      </div>
    );
  }

  const isActive = msg.isThinking || msg.streaming || msg.executing;
  return (
    <div className="flex w-full gap-2 sm:gap-4 items-start" {...(isActive ? { 'data-msg-active': '' } : {})}>
      <div className="hidden sm:flex w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-50 to-blue-100 border border-blue-200 items-center justify-center shadow-sm shrink-0">
        <Ghost size={22} className="text-blue-600" />
      </div>
      {/* 첫 줄이 유령 아이콘 중앙(높이 44px의 ~50%)에 맞도록 pt-3 */}
      <div className="flex flex-col gap-1 flex-1 min-w-0 sm:pt-3">
        <div className="flex flex-col gap-3 w-full">
          {/* thinking — 버블 상단에 항상 표시. spinner = thinking 또는 streaming 또는 executing 중.
              완료 후엔 spinner 꺼지고 "답변완료" 라벨 유지 (옛 sentinel DONE 시점). */}
          {(() => {
            const active = !!(msg.isThinking || msg.streaming || msg.executing);
            const complete = !active && msg.thinkingText === THINKING_STATUS.DONE;
            if (!active && !complete && !msg.thinkingText) return null;
            return (
              <ThinkingBlock
                statusText={msg.statusText}
                thinkingText={msg.thinkingText}
                isActive={active}
                isComplete={complete}
              />
            );
          })()}
          {(!msg.isThinking || msg.streaming || msg.content) && (
            <div className="flex flex-col gap-5">
              {/* 인라인 블록 렌더링 — text/html 순서 보존 (Claude 스타일) */}
              {msg.data?.blocks && Array.isArray(msg.data.blocks) && msg.data.blocks.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {msg.data.blocks.map((b: any, i: number) => {
                    // 섹션 경계 (Header / Divider) 앞에 추가 여백 — chat-manager 의 공통 규칙 (share 페이지와 동일)
                    const wrapCls = isSectionStartBlock(b, i) ? 'mt-5' : '';
                    // BlockErrorBoundary — 한 block 의 invalid props 가 admin 전역 죽이는 케이스 격리.
                    // throw 시 그 block 만 inline 에러 카드 + 다른 block / 메시지 정상 동작.
                    const label = b.type === 'component' ? `${b.name ?? 'unknown'} #${i}` : `${b.type} #${i}`;
                    return (
                      <BlockErrorBoundary key={i} label={label}>
                        {b.type === 'text' ? (
                          <div className={`text-slate-800 text-[15px] sm:text-[16px] font-normal sm:font-medium leading-relaxed space-y-1 ${wrapCls}`}>{renderMarkdown(b.text)}</div>
                        ) : b.type === 'html' ? (
                          <div className={wrapCls}><AutoResizeIframe src={b.htmlContent as string} initialHeight={b.htmlHeight} dependencies={(b as { dependencies?: string[] }).dependencies} /></div>
                        ) : b.type === 'component' ? (
                          <div className={wrapCls}><ComponentRenderer components={[{ type: b.name, props: b.props || {} }]} /></div>
                        ) : null}
                      </BlockErrorBoundary>
                    );
                  })}
                </div>
              ) : (
                <>
                  {msg.content && (
                    <div className="text-slate-800 text-[15px] sm:text-[16px] font-normal sm:font-medium leading-relaxed space-y-1">
                      {renderMarkdown(msg.content)}
                    </div>
                  )}
                  {/* 인라인 HTML 렌더링 (차트/그래프 등) — 답변 바로 아래 (blocks 없을 때 fallback) */}
                  {msg.data && (() => {
                    const dataObj = msg.data as any;
                    const raw = dataObj?.htmlItems ?? (Array.isArray(dataObj) ? dataObj : [dataObj]);
                    const htmlItems = raw.filter((d: any) => d && 'htmlContent' in d);
                    return htmlItems.length > 0 ? (
                      <div className="space-y-3 mt-2">
                        {htmlItems.map((h: any, i: number) => (
                          <AutoResizeIframe key={i} src={h.htmlContent as string} initialHeight={h.htmlHeight} dependencies={h.dependencies} />
                        ))}
                      </div>
                    ) : null;
                  })()}
                </>
              )}

              {/* 에러 — 접이식 태그 */}
              {msg.error && !msg.steps?.some(s => s.error) && (
                <ErrorCollapsible error={msg.error} />
              )}

              {/* 선택지 버튼 — past-runat pendingAction 있으면 숨김 (즉시/시간변경 버튼과 중복 방지) */}
              {!buildCard && msg.suggestions && msg.suggestions.length > 0
                && !msg.pendingActions?.some(p => p.status === 'past-runat') && (
                <SuggestionButtons
                  suggestions={msg.suggestions}
                  loading={loading}
                  pickedSuggestion={msg.pickedSuggestion}
                  onSuggestion={(text, meta) => {
                    onLockSuggestion?.(msg.id, text);
                    onSuggestion?.(text, meta);
                  }}
                />
              )}

              {/* 시크릿 입력 요청 */}
              {msg.data && (() => {
                const items = Array.isArray(msg.data) ? msg.data : [msg.data];
                const secrets = items.filter((d: any) => d && d.requestSecret);
                if (secrets.length === 0) return null;
                return (
                  <div className="space-y-3 mt-2">
                    {secrets.map((s: any, i: number) => (
                      <SecretInput key={i} name={s.name} prompt={s.prompt} helpUrl={s.helpUrl} />
                    ))}
                  </div>
                );
              })()}

              {/* 데이터 + 미리보기 링크 */}
              {msg.data && (() => {
                const items = Array.isArray(msg.data) ? msg.data : [msg.data];
                const urls = items.filter((d: any) => d && 'openUrl' in d);
                return (
                  <>
                    {urls.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {urls.map((u: any, i: number) => (
                          <a key={i} href={u.openUrl} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-bold rounded-lg transition-colors shadow-sm">
                            <ExternalLink size={14} />
                            {u.savedPage || u.openUrl.replace(/^\//, '')} 미리보기
                          </a>
                        ))}
                      </div>
                    )}
                    {/* embedded 라이브 프리뷰 폐기(2026-06-09) — 완성 후 미리보기 불필요. 확인은 위 openUrl '미리보기' 링크. */}
                    {/* MCP 결과는 AI가 reply에서 자연어로 요약 — raw JSON 표시 안 함 */}
                    {/* 실행 결과 JSON은 표시하지 않음 — AI가 reply에서 자연어로 요약 */}
                  </>
                );
              })()}

              {/* Project Builder — 빌드 단계 stepper. 부모가 세션(buildSession.id) 단위로 그룹핑해 anchor(첫 등장)
                  메시지에만 최신 state 를 buildCard 로 전달 → 백엔드 멀티턴이어도 카드 1개가 첫 자리에서 1→2→3 진행. */}
              {buildCard && (
                <BuildCard
                  stages={buildCard.stages}
                  loading={loading}
                  building={building}
                  buildStatus={buildStatus}
                  onSuggestion={onSuggestion}
                  onLockSuggestion={onLockSuggestion}
                />
              )}

              {/* Pending Actions — 승인 버튼 (액션 필요, 눈에 띄게 위쪽) */}
              {msg.pendingActions && msg.pendingActions.length > 0 && (
                <div className="flex flex-col gap-2">
                  {msg.pendingActions.map(p => {
                    // 30일 경과 = 백엔드 pending_tools/plan_store TTL 만료. 종결(승인/거부)된 카드는 제외.
                    const isExpired = p.status !== 'approved' && p.status !== 'rejected' && !!p.createdAt && Date.now() - p.createdAt > 30 * 24 * 60 * 60 * 1000;
                    return (
                    <div key={p.planId} className={`flex flex-col gap-1 px-3 py-2.5 rounded-xl ${isExpired ? 'bg-slate-50 border border-slate-200' : p.status === 'past-runat' || p.status === 'error' ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'}`}>
                      {p.status === 'past-runat' && (
                        <div className="text-[11px] font-bold text-red-600">
                          {t('plan.past_runat', { time: p.originalRunAt ? new Date(p.originalRunAt).toLocaleString('ko-KR') : '-' })}
                        </div>
                      )}
                      {p.status === 'error' && p.errorMessage && (
                        <div className="text-[11px] font-bold text-red-600 break-all">{t('plan.exec_failed', { error: p.errorMessage })}</div>
                      )}
                      {isExpired && (
                        <div className="text-[11px] font-bold text-slate-500">{t('plan.expired')}</div>
                      )}
                      <div className="flex items-center gap-2">
                      <AlertTriangle size={15} className={`shrink-0 ${p.status === 'past-runat' ? 'text-red-500' : 'text-amber-600'}`} />
                      <span className="flex-1 text-[13px] font-medium text-slate-700 truncate">{planSummary(p, t)}</span>
                      {p.status === 'approved' ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-flex items-center px-3 py-1.5 text-[12px] font-bold text-emerald-600">✓ {p.name === 'schedule_task' ? t('plan.scheduled') : t('plan.executed')}</span>
                          {p.name === 'save_page' && (() => {
                            const a = p.args as Record<string, unknown> | undefined;
                            const slug = typeof a?.slug === 'string' ? (a.slug as string) : '';
                            return slug ? (
                              <a href={`/${slug}`} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[12px] font-bold rounded-lg border border-blue-200 transition-colors">
                                {t('plan.open')}
                              </a>
                            ) : null;
                          })()}
                        </span>
                      ) : p.status === 'rejected' ? (
                        <span className="inline-flex items-center px-3 py-1.5 text-[12px] font-medium text-rose-500">{t('plan.cancelled')}</span>
                      ) : p.status === 'error' ? null : p.status === 'past-runat' ? (
                        <>
                          <button
                            onClick={() => onApprovePendingAction?.(msg.id, p.planId, 'now')}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold rounded-lg transition-colors shadow-sm"
                          >
                            {t('plan.send_now')}
                          </button>
                          <button
                            onClick={() => {
                              const cur = new Date(Date.now() + 5 * 60_000);
                              const yyyy = cur.getFullYear(), mm = String(cur.getMonth() + 1).padStart(2, '0'), dd = String(cur.getDate()).padStart(2, '0');
                              const hh = String(cur.getHours()).padStart(2, '0'), mi = String(cur.getMinutes()).padStart(2, '0');
                              const suggested = `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
                              const input = window.prompt(t('plan.reschedule_prompt'), suggested);
                              if (!input) return;
                              // 초·타임존 보정 — 입력값은 사용자 로컬 시각 가정
                              const iso = input.length === 16 ? input + ':00' : input;
                              onApprovePendingAction?.(msg.id, p.planId, 'reschedule', iso);
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-bold rounded-lg border border-slate-300 transition-colors"
                          >
                            {t('plan.change_time')}
                          </button>
                          <button
                            onClick={() => onRejectPending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-2 py-1.5 bg-white hover:bg-rose-50 text-rose-500 text-[12px] font-bold rounded-lg border border-rose-200 transition-colors"
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : isExpired ? null : (
                        <>
                          <button
                            onClick={() => onApprovePending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[12px] font-bold rounded-lg border border-emerald-200 transition-colors"
                          >
                            <Check size={13} /> {t('plan.approve')}
                          </button>
                          <button
                            onClick={() => onRejectPending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-[12px] font-bold rounded-lg border border-rose-200 transition-colors"
                          >
                            <X size={13} /> {t('plan.reject')}
                          </button>
                        </>
                      )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}

              {/* 실행 완료된 액션 태그 — 최하단, 미니멀 */}
              {msg.executedActions && msg.executedActions.length > 0 && (
                <ActionTags actions={msg.executedActions} steps={msg.steps} toolResults={msg.toolResults} />
              )}

              {/* Library 출처 뱃지 — RetrievalEngine 매칭 결과 (Phase 1 단계 8.4). */}
              {msg.libraryHits && msg.libraryHits.length > 0 && (
                <SourceTags hits={msg.libraryHits} />
              )}
            </div>
          )}
        </div>
        {/* 복사·공유 버튼 — 버블 바깥 우측 하단 */}
        {(msg.content || (msg.data?.blocks && msg.data.blocks.length > 0)) && !msg.isThinking && (() => {
          // 전체 직렬화: text + 컴포넌트 (Table → 마크다운 표, Metric → "라벨: 값", Header → "## 제목" 등)
          let full = '';
          if (msg.data?.blocks && Array.isArray(msg.data.blocks)) {
            full = msg.data.blocks.map((b: any) => serializeBlockToMarkdown(b)).filter((s: string) => s).join('\n\n');
          }
          if (!full && msg.content) full = msg.content;
          return full ? (
            <div className="flex justify-end pr-1 gap-0.5 items-center">
              <CopyButton text={full} />
              {shareContext && <ShareTurnButton msgId={msg.id} messages={shareContext.turnMessages} conversationId={shareContext.conversationId} hubContext={hubContext} />}
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
// Hub page mode context — anonymous 방문자가 hub instance 로 접근 시 채워짐.
// 채워지면 admin 전용 기능 (사이드바 settings / 헤더 logout / multi-conv local storage)
// 자동 hide + useChat 가 /api/hub/<slug>/chat 호출.
export interface HubContext {
  slug: string;
  apiToken: string;
  instanceName: string;
  instanceDescription?: string;
  modelId?: string;
}

/** Project Builder 라이브 프리뷰 — collapsed=인라인 iframe / "큰 화면"=우측 아티팩트 드로어.
 *  자체 expanded 상태 (prop-drilling/전역 이벤트 없이 자기완결). split-panel 의 바운디드 버전. */
// Firebat 유령(👻) 픽셀 조립 — 빌드 "만들어지는 느낌". 파티클이 랜덤 위치서 모여 유령 실루엣(브랜드 에셋)
// 완성 → idle float. 구현 완료 전(미리보기 URL 없음)에 persistent 미리보기 영역을 채움. 완료 시 BuildPreview 로 교체.
// Firebat 유령(👻) 픽셀 조립 — lucide Ghost body path 를 Path2D 로 grid 래스터화(로고 정확 일치 + 고해상도,
// 동기·canvas taint 없음). 눈은 destination-out 으로 파냄. 아래서 위로 "물 차오르듯" 채워 만들어지는 느낌.
// 파이어뱃 미니 팩맨 로더 — "만드는 중" 동안 파란 착한 유령(우리)이 빨간 나쁜 유령들을 피해 미로를 누비다,
// 빌드 완료(done)되면 갇힌 팩맨에게 BFS 로 달려가 "구출 성공!". 자동 어트랙트(조작 0). 빨강에 잡히면 깜빡 후
// 리셋·재시작, 파워펠릿 먹으면 빨강 잠깐 파랗게 질려 도망(닿으면 눈만 남아 집으로 복귀). done 일 땐 무적(반드시 구출).
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 보관: 현재 라이브 상태 피드로 대체, 추후 fun 자리에 재사용
function FirebatPacmanLoader({ done = false, caption }: { done?: boolean; caption?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(done);
  doneRef.current = done;
  const t = useTranslations();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const MAZE = [
      '###########',
      '#o.......o#',
      '#.#.#.#.#.#',
      '#.........#',
      '#.#.#P#.#.#',
      '#.........#',
      '#.#.#.#.#.#',
      '#o.......o#',
      '###########',
    ];
    const ROWS = MAZE.length, COLS = MAZE[0].length, CELL = 22;
    const W = COLS * CELL, H = ROWS * CELL;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const isWall = (c: number, r: number) => r < 0 || r >= ROWS || c < 0 || c >= COLS || MAZE[r][c] === '#';

    let pac = { c: 5, r: 4 };
    let dots: { dot: boolean; pellet: boolean }[][] = [];
    const resetDots = () => {
      dots = MAZE.map((row, r) => row.split('').map((ch, c) => {
        if (ch === 'P') { pac = { c, r }; return { dot: false, pellet: false }; }
        if (ch === '#') return { dot: false, pellet: false };
        return { dot: true, pellet: false }; // 'o'/'.' 모두 일반 점 — 파워펠릿은 placePellet 이 blue 먼 곳에 1개만 배치
      }));
    };

    type Dir = { dc: number; dr: number };
    type Mover = { c: number; r: number; tc: number; tr: number; p: number; ddc: number; ddr: number };
    type Red = Mover & { fright: number; eyes: boolean; guard: boolean; gt: number };
    const mk = (c: number, r: number): Mover => ({ c, r, tc: c, tr: r, p: 0, ddc: 0, ddr: 0 });
    const HOME = { c: 5, r: 1 };
    // 매 게임 랜덤 시작 — 고정 루트 탈피. walkable = pac 제외 통행 가능 칸(미로·pac 고정이라 1회 산출).
    const walkable: { c: number; r: number }[] = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!isWall(c, r) && !(c === pac.c && r === pac.r)) walkable.push({ c, r });
    const rand = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
    const md = (a: { c: number; r: number }, b: { c: number; r: number }) => Math.abs(a.c - b.c) + Math.abs(a.r - b.r);
    let blue: Mover, reds: Red[];
    const initChars = () => {
      const bs = rand(walkable); // blue 랜덤 시작 → 매 게임 다른 루트
      blue = mk(bs.c, bs.r);
      // reds 3 — blue 에서 3칸 이상 떨어진 칸 랜덤(즉사 방지). reds[0] = 가드(팩맨 통로 순찰). 풀 부족 시 전체서.
      const pool = walkable.filter(w => md(w, bs) >= 3);
      const bag = pool.length >= 3 ? [...pool] : [...walkable];
      const picks: { c: number; r: number }[] = [];
      for (let i = 0; i < 3 && bag.length; i++) picks.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
      while (picks.length < 3) picks.push(rand(walkable));
      reds = picks.map((s, i) => ({ ...mk(s.c, s.r), fright: 0, eyes: false, guard: i === 0, gt: 1 }));
    };
    // 파워펠릿 1개만 — blue 에서 먼 칸(거리 상위 35%) 중 랜덤. blue 가 시작하자마자 못 먹게(추격·회피 플레이 지속).
    const placePellet = () => {
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (dots[r][c].pellet) { dots[r][c].pellet = false; dots[r][c].dot = true; }
      const cand = walkable.filter(w => !(w.c === pac.c && w.r === pac.r));
      const sorted = [...cand].sort((a, b) => md(b, blue) - md(a, blue));
      const topFar = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.35)));
      const cell = rand(topFar);
      dots[cell.r][cell.c] = { dot: false, pellet: true };
    };
    resetDots(); initChars(); placePellet();

    const DIRS: Dir[] = [{ dc: 1, dr: 0 }, { dc: -1, dr: 0 }, { dc: 0, dr: 1 }, { dc: 0, dr: -1 }];
    const bfs = (tc: number, tr: number) => {
      const d = Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(-1));
      if (isWall(tc, tr)) return d;
      d[tr][tc] = 0;
      const q: number[][] = [[tc, tr]];
      while (q.length) {
        const cur = q.shift()!; const c = cur[0], r = cur[1];
        for (const { dc, dr } of DIRS) { const nc = c + dc, nr = r + dr; if (!isWall(nc, nr) && d[nr][nc] < 0) { d[nr][nc] = d[r][c] + 1; q.push([nc, nr]); } }
      }
      return d;
    };
    const opensAt = (m: Mover) => DIRS.filter(d => !isWall(m.c + d.dc, m.r + d.dr));
    const noRev = (m: Mover, o: Dir[]) => { const f = o.filter(d => !(d.dc === -m.ddc && d.dr === -m.ddr)); return f.length ? f : o; };

    const blueDir = (): Dir => {
      const opts = opensAt(blue);
      if (!opts.length) return { dc: 0, dr: 0 };
      if (doneRef.current) {
        const dist = bfs(pac.c, pac.r);
        let best = opts[0], bd = Infinity;
        for (const o of opts) { const v = dist[blue.r + o.dr][blue.c + o.dc]; if (v >= 0 && v < bd) { bd = v; best = o; } }
        return best;
      }
      const threat = reds.filter(r => !r.eyes && r.fright === 0);
      const danger = (c: number, r: number) => { let m = 99; for (const tt of threat) m = Math.min(m, Math.abs(tt.c - c) + Math.abs(tt.r - r)); return m; };
      const toPac = bfs(pac.c, pac.r); // 팩맨까지 거리 — 파랑이 구출하러 다가감. 단 빨강이 가까우면 회피가 우선.
      const pool = noRev(blue, opts);
      let best = pool[0], bestScore = -Infinity;
      for (const o of pool) {
        const nc = blue.c + o.dc, nr = blue.r + o.dr;
        const dp = toPac[nr]?.[nc] ?? 99;
        // 빨강 6칸 이내면 회피 지배(겁탈출), 멀면 팩맨에 접근. 팩맨 칸도 후보 — 닿으면 구출(아래 won).
        const s = Math.min(danger(nc, nr), 6) * 1.5 - dp * 0.5 + Math.random() * 1.0;
        if (s > bestScore) { bestScore = s; best = o; }
      }
      return best;
    };
    const redDir = (rg: Red): Dir => {
      const opts = opensAt(rg);
      if (!opts.length) return { dc: 0, dr: 0 };
      const pool = noRev(rg, opts);
      // 가드 — done 아니고 안 겁먹었으면 팩맨 유일 통로(팩맨 위 칸)를 지킴. 도착하면 정지(막아섬). done(구출) 시
      // 아래 fright 로 도망가 길을 터줌.
      if (rg.guard && !doneRef.current && rg.fright === 0 && !rg.eyes) {
        // 팩맨 세로 통로(위 칸↔아래 칸, 팩맨 칸 관통)를 왔다갔다 — 빨강은 팩맨 지나도 되니 가운데서 양쪽 다 막음.
        const top = { c: pac.c, r: pac.r - 1 }, bot = { c: pac.c, r: pac.r + 1 };
        const inCol = rg.c === pac.c && rg.r >= top.r && rg.r <= bot.r;
        if (!inCol) {
          // 통로 밖 — 위 칸으로 진입(최단)
          const gd = bfs(top.c, top.r);
          let gbest = pool[0], gbd = Infinity;
          for (const o of pool) { const v = gd[rg.r + o.dr][rg.c + o.dc]; if (v >= 0 && v < gbd) { gbd = v; gbest = o; } }
          return gbest;
        }
        // 통로 안 — 끝 도달 시 반전하며 위↔아래 순찰
        if (rg.r <= top.r) rg.gt = 1;
        else if (rg.r >= bot.r) rg.gt = -1;
        if (!isWall(rg.c, rg.r + rg.gt)) return { dc: 0, dr: rg.gt };
        return { dc: 0, dr: -rg.gt };
      }
      const dist = rg.eyes ? bfs(HOME.c, HOME.r) : bfs(blue.c, blue.r);
      let best = pool[0];
      if (rg.fright > 0 && !rg.eyes) {
        // 도망 — 역방향까지 포함해 blue 에서 가장 먼 방향(들, 최대거리 ±1) 중 랜덤. 동점이 항상 오른쪽(DIRS 첫
        // 방향)으로 몰려 셋 다 우측 행진하던 것 해소 + 겁먹으면 방향 전환 자유(클래식 frightened).
        let bd = -Infinity;
        for (const o of opts) { const v = dist[rg.r + o.dr][rg.c + o.dc]; if (v >= 0 && v > bd) bd = v; }
        const far = opts.filter(o => { const v = dist[rg.r + o.dr][rg.c + o.dc]; return v >= 0 && v >= bd - 1; });
        return far.length ? far[Math.floor(Math.random() * far.length)] : opts[0];
      }
      let bd = Infinity;
      for (const o of pool) { const v = dist[rg.r + o.dr][rg.c + o.dc]; if (v >= 0 && v < bd) { bd = v; best = o; } }
      return best;
    };

    const SP = 0.07;
    let caught = 0, won = 0, raf = 0, frame = 0;
    const advance = (m: Mover, chooser: () => Dir, spd: number) => {
      m.p += spd;
      if (m.p >= 1) {
        m.c = m.tc; m.r = m.tr; m.p = 0;
        const d = chooser();
        if (d.dc === 0 && d.dr === 0) { m.tc = m.c; m.tr = m.r; m.ddc = 0; m.ddr = 0; }
        else { m.tc = m.c + d.dc; m.tr = m.r + d.dr; m.ddc = d.dc; m.ddr = d.dr; }
      }
    };
    const lx = (m: Mover) => (m.c + (m.tc - m.c) * m.p + 0.5) * CELL;
    const ly = (m: Mover) => (m.r + (m.tr - m.r) * m.p + 0.5) * CELL;

    const drawGhost = (x: number, y: number, rad: number, body: string, fr: boolean, eyesOnly: boolean) => {
      if (!eyesOnly) {
        ctx.fillStyle = fr ? '#bfdbfe' : body;
        ctx.beginPath();
        ctx.arc(x, y - rad * 0.15, rad, Math.PI, 0);
        ctx.lineTo(x + rad, y + rad * 0.8);
        const feet = 3, fw = (rad * 2) / feet;
        for (let i = 0; i < feet; i++) { const fx = x + rad - i * fw; ctx.lineTo(fx - fw / 2, y + rad * 0.5); ctx.lineTo(fx - fw, y + rad * 0.8); }
        ctx.closePath(); ctx.fill();
      }
      if (fr && !eyesOnly) {
        // 겁먹은 얼굴 — 작은 눈 2개 + 물결 입 (클래식 frightened)
        ctx.fillStyle = '#1e3a8a';
        ctx.beginPath(); ctx.arc(x - rad * 0.3, y - rad * 0.12, rad * 0.12, 0, Math.PI * 2); ctx.arc(x + rad * 0.3, y - rad * 0.12, rad * 0.12, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#1e3a8a'; ctx.lineWidth = 1.6; ctx.beginPath();
        const my = y + rad * 0.32, mw = rad * 0.5, segs = 4;
        ctx.moveTo(x - mw, my);
        for (let i = 1; i <= segs; i++) ctx.lineTo(x - mw + (mw * 2 * i) / segs, my + (i % 2 === 0 ? -rad * 0.14 : rad * 0.14));
        ctx.stroke();
      } else {
        const ex = rad * 0.4, ey = -rad * 0.12, er = rad * 0.26;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x - ex, y + ey, er, 0, Math.PI * 2); ctx.arc(x + ex, y + ey, er, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1e293b';
        ctx.beginPath(); ctx.arc(x - ex, y + ey, er * 0.5, 0, Math.PI * 2); ctx.arc(x + ex, y + ey, er * 0.5, 0, Math.PI * 2); ctx.fill();
      }
    };
    const drawPac = (x: number, y: number, rad: number) => {
      const mouth = won > 0 ? Math.abs(Math.sin(frame * 0.2)) * 0.3 : 0.06;
      ctx.fillStyle = '#facc15';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, rad, mouth * Math.PI, (2 - mouth) * Math.PI); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.beginPath(); ctx.arc(x, y - rad * 0.4, rad * 0.13, 0, Math.PI * 2); ctx.fill();
    };

    let lastTs = 0;
    const render = (ts: number) => {
      if (ts - lastTs < 15) { raf = requestAnimationFrame(render); return; } // 120Hz 등 고주사율서 2배속 방지 — ~60fps 캡
      lastTs = ts;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (MAZE[r][c] === '#') { ctx.fillStyle = '#1e40af'; ctx.fillRect(c * CELL + 3, r * CELL + 3, CELL - 6, CELL - 6); }
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const cell = dots[r][c];
        if (cell.dot) { ctx.fillStyle = '#fcd34d'; ctx.beginPath(); ctx.arc(c * CELL + CELL / 2, r * CELL + CELL / 2, 2, 0, Math.PI * 2); ctx.fill(); }
        else if (cell.pellet) { ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(c * CELL + CELL / 2, r * CELL + CELL / 2, 4 + Math.sin(frame * 0.2), 0, Math.PI * 2); ctx.fill(); }
      }
      const rad = CELL * 0.4;
      drawPac(pac.c * CELL + CELL / 2, pac.r * CELL + CELL / 2, rad * 0.92);

      if (won > 0) {
        drawGhost(pac.c * CELL + CELL / 2 - CELL * 0.55, pac.r * CELL + CELL / 2, rad, '#3b82f6', false, false);
        ctx.fillStyle = '#fde68a';
        const sp = frame % 36;
        ctx.globalAlpha = Math.max(0, 1 - sp / 36);
        for (let i = 0; i < 6; i++) { const a = i * 1.05; const rr = 12 + sp; ctx.beginPath(); ctx.arc(pac.c * CELL + CELL / 2 + Math.cos(a) * rr, pac.r * CELL + CELL / 2 + Math.sin(a) * rr, 2.2, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
        frame++;
        if (!doneRef.current) { won--; if (won === 0) { resetDots(); initChars(); placePellet(); } } // 플레이 중 구출 = 잠깐 축하 후 재시작(성공 루프). done 은 영구 SAVED.
        raf = requestAnimationFrame(render); return;
      }
      if (caught > 0) {
        if (Math.floor(caught / 5) % 2 === 0) drawGhost(lx(blue), ly(blue), rad, '#3b82f6', false, false);
        for (const rg of reds) drawGhost(lx(rg), ly(rg), rad, '#ef4444', false, rg.eyes);
        caught--; if (caught === 0) { resetDots(); initChars(); placePellet(); }
        frame++; raf = requestAnimationFrame(render); return;
      }

      advance(blue, blueDir, SP);
      const bc = dots[blue.r]?.[blue.c];
      if (bc) { if (bc.pellet) { bc.pellet = false; for (const rg of reds) if (!rg.eyes) rg.fright = 220; } else if (bc.dot) bc.dot = false; }
      for (const rg of reds) {
        if (doneRef.current && !rg.eyes) rg.fright = 30; // 구출 런 = 빨강 겁먹고 도망(길 트임, 파랑이 뚫는 그림 X)
        advance(rg, () => redDir(rg), rg.fright > 0 ? SP * 0.55 : SP * 0.9);
        if (rg.fright > 0) rg.fright--;
        if (rg.eyes && rg.c === HOME.c && rg.r === HOME.r && rg.p === 0) rg.eyes = false;
      }
      if (blue.c === pac.c && blue.r === pac.r) won = doneRef.current ? 1 : 44; // 구출 도달 — done=영구 SAVED, 플레이=44프레임 축하 후 재시작
      if (!won) for (const rg of reds) { // 이미 구출(won)이면 catch 무시 — 성공 우선 + 중복 리셋 방지
        if (rg.eyes) continue;
        if (Math.hypot(lx(blue) - lx(rg), ly(blue) - ly(rg)) < CELL * 0.7) {
          if (rg.fright > 0) { rg.eyes = true; rg.fright = 0; }
          else if (!doneRef.current) { caught = 28; break; } // done(구출 런)일 땐 무적
        }
      }

      for (const rg of reds) drawGhost(lx(rg), ly(rg), rad, '#ef4444', rg.fright > 0, rg.eyes);
      if (doneRef.current) {
        // 구출 런 — 파랑이 파워업(노란 오라) = 빨강이 겁먹고 도망가는 계기.
        const g = ctx.createRadialGradient(lx(blue), ly(blue), 2, lx(blue), ly(blue), rad * 2);
        g.addColorStop(0, 'rgba(250,204,21,0.55)'); g.addColorStop(1, 'rgba(250,204,21,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(lx(blue), ly(blue), rad * 2, 0, Math.PI * 2); ctx.fill();
      }
      drawGhost(lx(blue), ly(blue), rad, '#3b82f6', false, false);
      frame++; raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-2 py-4 rounded-xl border border-blue-100 bg-slate-900/95 overflow-hidden h-full">
      <canvas ref={ref} aria-hidden className="max-w-full" style={{ width: 'min(100%, 300px)' }} />
      <div className="text-[12px] font-semibold text-slate-200 px-3 text-center truncate max-w-full">{done ? '🎉 PAC-MAN SAVED!' : (caption || t('build.making'))}</div>
    </div>
  );
}

function FirebatGhostAssembly({ size = 160, caption, variant = 'main', settled = false }: { size?: number; caption?: string; variant?: 'main' | 'accent'; settled?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // 1) lucide Ghost body 를 RES×RES 그리드로 래스터화 → 채워진 셀 = 픽셀 target. 눈은 grid 정렬 대칭으로
    //    제거(arc 래스터화는 저해상도서 좌우 비대칭·찢김 → 셀 단위로 양쪽 동일하게 빼야 깔끔).
    // RES = 그리드 해상도. size 비례로 키워 픽셀(dot)을 ~2.5px 로 작게 유지 → 원래 lucide Ghost 윤곽에 더 가깝게
    // (옛 고정 36 은 큰 미리보기서 dot ~4.4px 라 뭉툭). 작은 악센트(size 48)는 32 로 floor — sub-pixel 방지.
    const RES = Math.max(40, Math.round(size / 1.8));
    const off = document.createElement('canvas');
    off.width = RES;
    off.height = RES;
    const octx = off.getContext('2d');
    const targets: { gx: number; gy: number }[] = [];
    if (octx) {
      octx.save();
      octx.scale(RES / 24, RES / 24); // lucide viewBox 24
      // 채운 실루엣 — 머리(반원 돔)가 둥글게 보이게 fill 로 래스터화. 옛 stroke(얇은 아웃라인)는 저해상도서
      // 곡선이 stair-step 으로 삐쭉했음. 채우면 돔이 솔리드 → 둥근 머리. 눈은 destination-out 으로 파내(클래식 유령).
      octx.fillStyle = '#000';
      octx.fill(new Path2D('M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z'));
      // 눈 2개 = 구멍(파냄) → 그 자리 픽셀 없음 = 배경 비침(블루 유령의 흰 눈 효과).
      octx.globalCompositeOperation = 'destination-out';
      octx.beginPath();
      octx.arc(9, 10, 1.5, 0, Math.PI * 2);
      octx.arc(15, 10, 1.5, 0, Math.PI * 2);
      octx.fill();
      octx.restore();
      const d = octx.getImageData(0, 0, RES, RES).data;
      for (let gy = 0; gy < RES; gy++) {
        for (let gx = 0; gx < RES; gx++) {
          if (d[(gy * RES + gx) * 4 + 3] > 30) targets.push({ gx, gy });
        }
      }
    }
    const dot = size / RES;
    const cx0 = size / 2;
    const cy0 = size / 2;

    // 픽셀별 상태 — 현재 위치(x,y)는 프레임 간 유지(이동). tx,ty=유령 자리. bAng=터질 때 바깥 방향.
    type GP = { x: number; y: number; tx: number; ty: number; gx: number; gy: number; rnd: number; rnd2: number; bAng: number };
    const ps: GP[] = targets.map(t => {
      const tx = t.gx * dot;
      const ty = t.gy * dot;
      const rnd = Math.random();
      const rnd2 = Math.random();
      const bAng = Math.atan2(ty + dot / 2 - cy0, tx + dot / 2 - cx0) + (rnd - 0.5) * 0.9;
      return { x: cx0, y: cy0, tx, ty, gx: t.gx, gy: t.gy, rnd, rnd2, bAng };
    });
    // 패턴별 등장 순서(0..1). 0~3 = 제자리에서 순서대로 채우기 / 4~5 = 가장자리·아래서 날아와 모임.
    const appearAt = (pattern: number, p: GP): number => {
      switch (pattern) {
        case 0: return (p.gy + p.gx / RES) / RES;                                  // 가로 줄 (위→아래)
        case 1: return (p.gx + p.gy / RES) / RES;                                  // 세로 줄 (좌→우)
        case 2: return p.rnd;                                                       // 랜덤 하나씩
        case 3: return Math.hypot(p.gx - RES / 2, p.gy - RES / 2) / (RES * 0.72);   // 중앙→밖
        case 4: return p.rnd;                                                       // 가장자리서 날아옴(랜덤 순)
        default: return (RES - p.gy) / RES;                                         // 아래서 날아옴
      }
    };
    const isConverge = (pattern: number) => pattern >= 4; // 날아와 모임 vs 제자리 등장
    // 4 = 네 가장자리(상/하/좌/우) 중 랜덤하게서 날아옴 / 5 = 아래서.
    const M = dot * 3; // 화면 밖 여유
    const scatterTo = (pattern: number, p: GP) => {
      if (pattern === 5) { p.x = p.rnd * size; p.y = size + M + p.rnd2 * size * 0.3; return; }
      const edge = Math.floor(p.rnd * 4);
      if (edge === 0) { p.x = p.rnd2 * size; p.y = -M; }            // 위
      else if (edge === 1) { p.x = p.rnd2 * size; p.y = size + M; } // 아래
      else if (edge === 2) { p.x = -M; p.y = p.rnd2 * size; }       // 왼
      else { p.x = size + M; p.y = p.rnd2 * size; }                 // 오
    };

    // 사이클: (제자리 채우기 or 날아와 모임) → 완성 부유 → 펑 분리 → 다음 패턴. 6패턴 순환, 느리게.
    const FILL = 250, HOLD = 50, BURST = 60;
    const CYCLE = FILL + HOLD + BURST;
    const PATTERNS = 6;
    let raf = 0;
    let frame = 0;
    let pattern = Math.floor(Math.random() * PATTERNS); // 사이클마다 랜덤 선택(순차 X)
    const render = () => {
      if (settled) {
        // 완료 — 조립·펑 루프 없이 완성된 유령이 제자리에서 그냥 통통(부유)만.
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#2563eb';
        ctx.globalAlpha = 1;
        const hb = Math.sin(frame * 0.07) * 2;
        for (const p of ps) ctx.fillRect(p.tx, p.ty + hb, dot + 0.6, dot + 0.6);
        frame++;
        raf = requestAnimationFrame(render);
        return;
      }
      const cf = frame % CYCLE;
      if (cf === 0) {
        let next = Math.floor(Math.random() * PATTERNS);
        if (next === pattern) next = (next + 1) % PATTERNS; // 직전 패턴 연속 회피
        pattern = next;
        for (const p of ps) {
          if (isConverge(pattern)) scatterTo(pattern, p); // 날아오기 = 가장자리서 시작
          else { p.x = p.tx; p.y = p.ty; }                // 제자리 채우기 = 처음부터 자리에(알파로 등장)
        }
      }
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#2563eb';
      if (cf < FILL) {
        const t = cf / FILL;
        for (const p of ps) {
          const aa = appearAt(pattern, p);
          if (isConverge(pattern)) {
            const started = t >= aa * 0.5;
            if (started) { p.x += (p.tx - p.x) * 0.12; p.y += (p.ty - p.y) * 0.12; } // 느린 lerp
            ctx.globalAlpha = started ? 1 : 0.25;
            ctx.fillRect(p.x, p.y, dot + 0.6, dot + 0.6);
          } else {
            const alpha = Math.min(1, (t - aa * 0.85) / 0.08); // 순서대로 페이드인(제자리)
            if (alpha <= 0) continue;
            ctx.globalAlpha = alpha;
            ctx.fillRect(p.tx, p.ty, dot + 0.6, dot + 0.6);
          }
        }
      } else if (cf < FILL + HOLD) {
        // 완성 — 자리 정착 + 살짝 부유
        const hb = Math.sin(frame * 0.07) * 2;
        ctx.globalAlpha = 1;
        for (const p of ps) {
          p.x += (p.tx - p.x) * 0.3;
          p.y += (p.ty - p.y) * 0.3;
          ctx.fillRect(p.x, p.y + hb, dot + 0.6, dot + 0.6);
        }
      } else {
        // 펑 — 바깥으로 가속 분리되며 페이드아웃
        const bt = (cf - FILL - HOLD) / BURST;
        const spd = 2.5 + bt * 9;
        ctx.globalAlpha = Math.max(0, 1 - bt);
        for (const p of ps) {
          p.x += Math.cos(p.bAng) * spd;
          p.y += Math.sin(p.bAng) * spd;
          ctx.fillRect(p.x, p.y, dot + 0.6, dot + 0.6);
        }
      }
      ctx.globalAlpha = 1;
      frame++;
      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [size, settled]);

  if (variant === 'accent') {
    // 작은 인라인 악센트 (옵션 단계 "준비 중") — 박스/캡션 없이 캔버스만.
    return <canvas ref={ref} style={{ width: size, height: size, transform: 'translateZ(0)' }} aria-hidden className="shrink-0" />;
  }
  // main — 구현 단계: 유령이 "만드는 중" 채우는 자리. 미리보기 폐기(2026-06-09) 후 16/10 거대 박스 불필요 →
  // 적당한 py 높이로 유령이 주역이 되게.
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 rounded-xl border border-blue-100 bg-blue-50/30">
      <canvas ref={ref} style={{ width: size, height: size, transform: 'translateZ(0)' }} aria-hidden />
      {caption && <div className="text-[12px] font-medium text-slate-500">{caption}</div>}
    </div>
  );
}

export default function AdminConsole() {
  return <ConsolePage hubContext={undefined} />;
}

export function ConsolePage({ hubContext }: { hubContext?: HubContext }) {
  const router = useRouter();
  const t = useTranslations();
  // settings-manager 의 module-level keyPrefix 설정 — hub mode 면 모든 useSetting / readSetting /
  // writeSetting 호출이 'firebat_<key>__hub-<slug>' suffix 자동 사용. admin 로그인 상태로 hub URL
  // 접속해도 admin localStorage 절대 사용 X.
  // useState initializer 안에서 동기 호출 — 첫 렌더 전에 prefix 설정되어야 useSetting initializer
  // 가 올바른 키 읽음. useEffect 는 첫 렌더 후 실행이라 race.
  useState(() => {
    setSettingsKeyPrefix(hubContext ? `hub-${hubContext.slug}` : null);
    return null;
  });
  useEffect(() => {
    setSettingsKeyPrefix(hubContext ? `hub-${hubContext.slug}` : null);
    return () => {
      // unmount 시 prefix 해제 — 다음 admin 진입 시 admin 키 정상 사용.
      if (hubContext) setSettingsKeyPrefix(null);
    };
  }, [hubContext]);
  // a11y — chat 입력창 / 이미지 file picker 의 안정 id (DevTools "form field id 중복" 회피).
  const chatInputId = useId();
  const imageFileInputId = useId();
  // CMS 설정 클릭 시 /admin/cms 로 이동 — sessionStorage flag 로 직접 URL 진입 차단.
  // sysmod 'cms' 만 분기, 그 외는 모달 그대로.
  const handleOpenModuleSettings = useCallback((name: string) => {
    if (name === 'cms') {
      sessionStorage.setItem('firebat_cms_entry', '1');
      router.push('/admin/cms');
      return;
    }
    setEditingModule(name);
  }, [router]);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'secrets' | 'mcp' | 'capabilities' | 'system' | undefined>(undefined);
  // 빈 문자열 디폴트 — 사용자가 인증(API 키 / CLI) + 설정에서 모델 선택 설정할 때까지 채팅 차단.
  const [aiModel, setAiModel] = useState('');
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editingModule, setEditingModule] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  // 첨부 이미지를 갤러리에 저장 — 사용자 명시 클릭 시에만 (자동 저장 X).
  // 'idle' 기본 → 'saving' 진행 → 'saved' 성공 → 'error' 실패. attachedImage 변경 시 'idle' 리셋.
  const [attachedSaveState, setAttachedSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [attachedSaveError, setAttachedSaveError] = useState<string>('');

  // 사이드바 갱신 — AI 도구 실행/모듈 삭제/파일 저장 후 패널이 듣는 'firebat-refresh' 발화.
  // (옛 fetchFileTree no-op 대체 — 워크스페이스 트리는 Sidebar 자체 refreshAll, 그 외 패널은 이 이벤트로 재조회.)
  const refreshSidebar = useCallback(() => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('firebat-refresh'));
  }, []);

  // Hub page mode 의 sessionId — localStorage sticky (방문자 동일 세션 유지) + handleNewConv 시 갱신.
  // useState initializer 안에서 동기 처리 — 첫 렌더 직전에 sid 확정. 옛에 useEffect 로 했더니
  // 첫 렌더 = hubSessionId='' → hubChatContext=undefined → useChat 의 init useEffect 가 admin
  // path 진입 (admin /api/conversations 호출) → admin 대화가 hub 사이드바에 잠시 노출되는 race.
  const [hubSessionId, setHubSessionId] = useState<string>(() => {
    if (!hubContext || typeof window === 'undefined') return '';
    const key = `firebat-hub-session-${hubContext.slug}`;
    try {
      const cached = localStorage.getItem(key);
      if (cached) return cached;
    } catch {}
    const sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try { localStorage.setItem(key, sid); } catch {}
    return sid;
  });
  const resetHubSession = useCallback(() => {
    if (!hubContext) return;
    const key = `firebat-hub-session-${hubContext.slug}`;
    const sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try { localStorage.setItem(key, sid); } catch {}
    setHubSessionId(sid);
  }, [hubContext]);

  // useMemo 강제 — 옛 = 매 렌더 새 객체 reference. useChat 의 useEffect dependency 안 hubContext
  // 가 있어 (commit `4d48d4d`) 매 렌더 useEffect 재발화 → fetch list-conversations + dispatch LOAD →
  // messages state 안 SEND_USER 직후 system isThinking 메시지 reset → ThinkingBlock 사라짐 +
  // 사이드바 제목 ↔ "새 대화" 깜빡 root cause.
  const hubChatContext = useMemo(() => {
    if (!hubContext || !hubSessionId) return undefined;
    return {
      slug: hubContext.slug,
      apiToken: hubContext.apiToken,
      sessionId: hubSessionId,
      onResetSession: resetHubSession,
    };
  }, [hubContext, hubSessionId, resetHubSession]);

  const {
    messages, input, setInput, loading,
    attachedImage, setAttachedImage,
    conversations, activeConvId, chatEndRef, chatContainerRef, handleScroll,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit,
    handleApprovePending, handleRejectPending, handleStop, lockSuggestion,
    planMode, setPlanMode,
    inputMode, setInputMode,
    refreshConversations,
  } = useChat(aiModel, refreshSidebar, hubChatContext);

  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleImageSelect = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) return; // 10MB 제한
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedImage(reader.result as string);
      // 새 첨부 — 갤러리 저장 상태 리셋
      setAttachedSaveState('idle');
      setAttachedSaveError('');
    };
    reader.readAsDataURL(file);
  }, [setAttachedImage]);

  /** 첨부 이미지를 갤러리에 저장 — 사용자 명시 클릭. 메시지 전송과 독립.
   *  결과는 source: 'upload' 메타로 기록되어 갤러리에서 AI 생성과 시각 구분 가능. */
  const handleSaveAttachedToGallery = useCallback(async () => {
    if (!attachedImage || attachedSaveState === 'saving' || attachedSaveState === 'saved') return;
    setAttachedSaveState('saving');
    setAttachedSaveError('');
    try {
      const json = await apiPost<{ success: boolean; error?: string }>(
        '/api/media/upload',
        { dataUrl: attachedImage },
        { category: 'media-upload' },
      );
      if (json.success) {
        setAttachedSaveState('saved');
      } else {
        setAttachedSaveState('error');
        setAttachedSaveError(json.error || '저장 실패');
      }
    } catch (e) {
      setAttachedSaveState('error');
      setAttachedSaveError(e instanceof Error ? e.message : '네트워크 오류');
    }
  }, [attachedImage, attachedSaveState]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleImageSelect(file);
  }, [handleImageSelect]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // 이미지 첨부 처리
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) handleImageSelect(file);
        e.preventDefault();
        return;
      }
    }
    // 텍스트 붙여넣기 시 끝 공백/개행 제거 (복사본 끝 \n 때문에 커서가 다음 줄로 가는 현상 방지)
    const text = e.clipboardData.getData('text');
    if (!text) return;
    const trimmed = text.replace(/[\s\n\r]+$/, '');
    if (trimmed === text) return; // 공백 없으면 기본 동작
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart ?? input.length;
    const end = ta.selectionEnd ?? input.length;
    const next = input.slice(0, start) + trimmed + input.slice(end);
    setInput(next);
    requestAnimationFrame(() => {
      const pos = start + trimmed.length;
      ta.setSelectionRange(pos, pos);
    });
  }, [handleImageSelect, input, setInput]);

  // 입력 카드 위에서 세로 드래그 → 채팅 영역 스크롤 포워딩 (모바일 UX)
  const cardTouchY = useRef<number | null>(null);
  const handleCardTouchStart = useCallback((e: React.TouchEvent) => {
    // textarea 안에서의 터치는 스킵 (textarea 자체 스크롤 유지)
    const t = e.target as HTMLElement;
    if (t.tagName === 'TEXTAREA' || t.closest('button')) { cardTouchY.current = null; return; }
    cardTouchY.current = e.touches[0]?.clientY ?? null;
  }, []);
  const handleCardTouchMove = useCallback((e: React.TouchEvent) => {
    if (cardTouchY.current == null) return;
    const y = e.touches[0]?.clientY ?? 0;
    const dy = cardTouchY.current - y;
    cardTouchY.current = y;
    if (chatContainerRef.current) chatContainerRef.current.scrollTop += dy;
  }, [chatContainerRef]);

  // 초기화 — 서버(Vault) 설정을 localStorage 에 sync. DB 가 진실의 원천, localStorage 는 fast path cache.
  // valid 모델 list 도 같은 응답 (data.aiModels — Rust core::llm::config::builtin_models()) 에 포함.
  // hub mode = 익명 visitor → `/api/settings` 는 admin 전용 (proxy 401). 모델은 backend hub
  // chat endpoint 가 소유자 설정으로 서버 주입하므로 visitor 가 조회할 필요 자체가 없다.
  useEffect(() => {
    if (hubContext) return;
    (async () => {
      let loadedFromServer = false;
      let validIds: Set<string> | null = null;
      try {
        const data = await apiGet<any>('/api/settings', { category: 'page' });
        if (data.success) {
          if (Array.isArray(data.aiModels)) {
            validIds = new Set<string>(
              data.aiModels.map((m: { id: string }) => m.id),
            );
          }
          const isValid = (m: string) => validIds === null || validIds.has(m);
          if (data.aiModel && isValid(data.aiModel)) {
            setAiModel(data.aiModel);
            writeSetting('firebat_model', data.aiModel); // localStorage cache sync
            loadedFromServer = true;
          }
          // "AI 카테고리별 마지막 선택 모델" 도 DB → localStorage sync (멀티기기 동기화의 핵심)
          if (data.lastModelByCategory && typeof data.lastModelByCategory === 'object') {
            writeSetting('firebat_last_model_by_category', data.lastModelByCategory);
          }
        }
      } catch (e) { logger.debug('admin-page', 'settings 초기 sync 실패', { error: e }); }
      if (!loadedFromServer) {
        const savedModel = readSetting('firebat_model');
        // 빈 폴백 — 사용자가 인증 설정하고 설정에서 명시 선택 하지 않은 한 채팅 차단.
        // 자동 폴백 모델 설정하면 사용자가 "어떤 모델 쓰는지 모름" 마찰 발생.
        const isValid = (m: string) => validIds === null || validIds.has(m);
        setAiModel(savedModel && isValid(savedModel) ? savedModel : '');
      }
    })();
  }, [hubContext]);

  // 레이아웃 헤더 햄버거 토글 이벤트 수신
  useEffect(() => {
    const handler = () => setMobileMenuOpen(prev => !prev);
    window.addEventListener('firebat-toggle-sidebar', handler);
    return () => window.removeEventListener('firebat-toggle-sidebar', handler);
  }, []);

  // 사이드바 상태를 layout.tsx 헤더 토글 버튼에 동기화
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('firebat-sidebar-state', { detail: { open: mobileMenuOpen } }));
  }, [mobileMenuOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 모바일 (가상 키보드에 Shift 없음): Enter=기본 동작(줄바꿈) 허용, 전송은 버튼 탭만
    // PC: Enter=전송, Shift+Enter=줄바꿈 (표준 chat 패턴)
    const isCoarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    if (isCoarse) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  return (
    <div className="flex w-full h-full bg-slate-50 overflow-hidden font-sans tracking-tight">
      <Sidebar
        onRefreshTree={refreshSidebar}
        conversations={conversations}
        activeConvId={activeConvId}
        activeMessages={messages}
        onSelectConv={handleSelectConv}
        onNewConv={handleNewConv}
        onDeleteConv={handleDeleteConv}
        onRefreshChats={refreshConversations}
        aiModel={aiModel}
        onOpenSettings={hubContext ? undefined : () => setShowSettings(true)}
        onEditFile={hubContext ? undefined : (filePath: string) => setEditingFile(filePath)}
        onOpenModuleSettings={hubContext ? undefined : handleOpenModuleSettings}
        mobileOpen={mobileMenuOpen}
        onMobileOpenChange={setMobileMenuOpen}
        hubMode={!!hubContext}
        hubShareContext={hubChatContext}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full relative"
        onMouseDown={() => window.dispatchEvent(new Event('firebat-collapse-sidebar'))}>
        {/* PC 상단 그라디언트 */}
        <div className="hidden md:block absolute top-0 left-0 w-full h-12 bg-gradient-to-b from-slate-50 to-transparent z-10 pointer-events-none" />

        {/* 메시지 목록 */}
        <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 md:px-12 pt-4 md:pt-16 scrolltext">
          <div className="w-full md:w-[70%] max-w-6xl mx-auto space-y-10">
            {(() => {
              // Project Builder — 빌드 카드 통합: 같은 세션(buildSession.id)은 백엔드 멀티턴이어도 프론트엔 카드
              // 1개만. 세션별 첫 등장 메시지(anchor)에 최신 state 를 몰아줘 "한 자리에서 진행"처럼 보이게.
              const buildCardByMsg = new Map<string, BuildCardData>();
              const foldedBuildMsgIds = new Set<string>();
              {
                // 세션별로 단계(step)당 마지막 메시지를 모아 stages(슬라이드) 구성. anchor(마지막 단계 메시지)에만
                // 카드 1개를 두고, 그 세션의 나머지 빌드 메시지는 fold(숨김) → 화면엔 카드 1개 + 카드 안 캐러셀.
                const STEP_ORDER = ['requirements', 'design', 'refine', 'implement'];
                const byStep = new Map<string, Map<string, BuildStageEntry>>();
                const msgsBySession = new Map<string, string[]>();
                for (const m of messages) {
                  if (Array.isArray(m.data)) continue;
                  const d = m.data as { buildSession?: BuildSessionView } | undefined;
                  const bsv = d?.buildSession;
                  if (!bsv?.id) continue;
                  let mids = msgsBySession.get(bsv.id);
                  if (!mids) { mids = []; msgsBySession.set(bsv.id, mids); }
                  mids.push(m.id);
                  let sm = byStep.get(bsv.id);
                  if (!sm) { sm = new Map<string, BuildStageEntry>(); byStep.set(bsv.id, sm); }
                  sm.set(bsv.step ?? '', { msgId: m.id, state: bsv, suggestions: m.suggestions, pickedSuggestion: m.pickedSuggestion, pendingActions: m.pendingActions });
                }
                for (const [sid, sm] of byStep) {
                  const stages = STEP_ORDER.filter(s => sm.has(s)).map(s => sm.get(s)!);
                  if (!stages.length) continue;
                  const anchor = stages[stages.length - 1].msgId;
                  buildCardByMsg.set(anchor, { stages });
                  for (const mid of msgsBySession.get(sid) ?? []) if (mid !== anchor) foldedBuildMsgIds.add(mid);
                }
              }
              // 활성 빌드(미완료)가 다음 단계 생성 중(loading)이면 → 그 카드가 팩맨(대기 애니)을 보여주고, 뒤따르는
              // 빌드 외 스트리밍 thinking 메시지는 fold. "원래 대화가 생각중으로" + "팩맨이 구현 *대기 중* 나옴".
              let buildingAnchor: string | null = null;
              let buildStatus: string | undefined; // 생성 중 라이브 상태(statusText: "render 호출중" 등) → 팩맨 캡션에 표시
              {
                let latestAnchor: string | null = null;
                for (let i = messages.length - 1; i >= 0; i--) { if (buildCardByMsg.has(messages[i].id)) { latestAnchor = messages[i].id; break; } }
                if (loading && latestAnchor) {
                  const st = buildCardByMsg.get(latestAnchor)!.stages;
                  const lt = st[st.length - 1];
                  const latestDone = lt.state.status === 'completed'
                    || (lt.state.step === 'implement' && (lt.pendingActions ?? []).some(p => p.name === 'save_page' && p.status === 'approved'));
                  // 다음 단계 생성 중 = 마지막 메시지가 "빌드 아닌 스트리밍 system"일 때만 → 그 thinking 을 fold 하고
                  // 현재 카드가 대신 팩맨(생성 대기)으로 표시. 별도 "생각중" 메시지 안 뜨고 현재 카드에서 진행됨
                  // (thinking-merge 해소). 트레일링 스트림 존재 = 현재 단계 픽이 끝나 잠긴 상태라 활성 칩을 안 가림.
                  // refine/implement 메시지가 막 도착한 순간은 lastMsg 가 빌드 메시지(lastIsBuild) → building=false →
                  // 옵션·승인카드 그대로(검토 들어가자마자 깜빡 팩맨 + 옵션/전송 가려지던 것 방지).
                  if (!latestDone) {
                    const lastMsg = messages[messages.length - 1];
                    const lastIsBuild = !!lastMsg && !Array.isArray(lastMsg.data) && !!(lastMsg.data as { buildSession?: BuildSessionView } | undefined)?.buildSession?.id;
                    if (lastMsg && lastMsg.id !== latestAnchor && lastMsg.role === 'system' && !lastIsBuild) {
                      buildingAnchor = latestAnchor;
                      // 실제 thinking 내용 우선(라이브 추론의 마지막 줄), 없으면 generic statusText → 팩맨 캡션에 표시.
                      const _tt = lastMsg.thinkingText;
                      const _real = _tt && !(Object.values(THINKING_STATUS) as string[]).includes(_tt)
                        ? (_tt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[도구') && !l.startsWith('[계획')).slice(-1)[0] || '')
                        : '';
                      buildStatus = _real || lastMsg.statusText;
                      foldedBuildMsgIds.add(lastMsg.id);
                    }
                  }
                }
              }
              return messages.map((msg, idx) => {
              // 버튼 클릭 흔적 user 메시지 (✓ 실행, ✕ 취소, ⚙ 수정 등) — 과거 SEND_USER 경로로 저장된 잔재.
              // SEND_SUGGESTION 도입 이후 신규 대화에선 생성되지 않지만, 기존 대화 로드 시 잔존 — 렌더에서 숨김.
              if (isSuggestionClickUserMessage(msg)) return null;
              if (foldedBuildMsgIds.has(msg.id)) return null; // 앞 단계 빌드 메시지 = 카드 안 캐러셀로 fold(숨김)
              // 단일턴 공유용 — system 메시지 바로 앞의 user 메시지 + 현재 system 메시지 쌍
              // 플랜 전체 흐름은 사이드바의 "대화 전체 공유" 로 묶는다 (여기선 턴 단위만).
              // activeConvId 는 단순 참조 (share slug 는 독립) — 없어도 공유 가능
              let shareContext: { conversationId: string; turnMessages: unknown[] } | undefined;
              if (msg.role === 'system' && msg.id !== 'system-init') {
                for (let i = idx - 1; i >= 0; i--) {
                  const prev = messages[i];
                  // 버튼 클릭 흔적은 실제 user prev 로 간주 X — 계속 walk back
                  if (prev && prev.role === 'user' && !isSuggestionClickUserMessage(prev)) {
                    shareContext = { conversationId: activeConvId || 'unsaved', turnMessages: [prev, msg] };
                    break;
                  }
                }
              }
              return (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  loading={loading}
                  onSuggestion={(text, meta) => handleSubmit(text, true, meta)}
                  onLockSuggestion={lockSuggestion}
                  onApprovePending={handleApprovePending}
                  onApprovePendingAction={(msgId, planId, action, newRunAt) => handleApprovePending(msgId, planId, action, newRunAt)}
                  onRejectPending={handleRejectPending}
                  shareContext={shareContext}
                  hubContext={hubChatContext}
                  buildCard={buildCardByMsg.get(msg.id)}
                  building={msg.id === buildingAnchor}
                  buildStatus={msg.id === buildingAnchor ? buildStatus : undefined}
                />
              );
              });
            })()}
            {/* 하단 spacer = 입력창 오버레이 높이 ≈. 마지막 메시지가 입력창 바로 위에 오게.
                모바일 입력창(~130px)에 맞춰 h-36(144). 옛 h-48(192) 은 모바일에서 ~60px 빈 틈 발생. */}
            <div className="h-36 sm:h-64 shrink-0 pointer-events-none" />
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* 입력창 */}
        {/* z-30 — 채팅 내용이 이 오버레이 밑으로 스크롤되는 구조라, 테이블 sticky 헤더/코너셀(z-20)이
            입력창 위로 떠 보이던 문제. 입력 오버레이를 테이블 sticky 위로 올려 가린다. */}
        <div className="absolute bottom-0 w-full bg-gradient-to-t from-slate-50 via-slate-50 to-transparent pt-8 sm:pt-16 pb-3 sm:pb-8 px-4 md:px-12 pointer-events-none z-30">
          <div className="w-full md:w-[70%] max-w-6xl mx-auto relative pointer-events-auto flex flex-col">
            <div className="flex w-full gap-4">
              <div className="w-11 shrink-0 opacity-0 pointer-events-none hidden md:block" />
              <div
                className="flex-1 min-w-0 flex flex-col bg-white border border-slate-300 rounded-2xl shadow-xl focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-100/50 transition-all overflow-hidden"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onTouchStart={handleCardTouchStart}
                onTouchMove={handleCardTouchMove}
              >
                {/* 이미지 미리보기 + 갤러리 저장 토글 */}
                {attachedImage && (
                  <div className="px-4 pt-3 pb-1 flex items-end gap-2">
                    <div className="relative inline-block">
                      <img src={attachedImage} alt="첨부" className="max-h-[120px] max-w-[200px] rounded-xl border border-slate-200 object-cover" />
                      <button
                        onClick={() => { setAttachedImage(null); setAttachedSaveState('idle'); setAttachedSaveError(''); }}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-slate-800 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {/* 갤러리 저장 — 사용자 명시 클릭 시에만. 메시지 전송과 독립. */}
                    <Tooltip
                      label={
                        attachedSaveState === 'saved' ? '갤러리에 저장됨'
                        : attachedSaveState === 'error' ? `저장 실패: ${attachedSaveError}`
                        : attachedSaveState === 'saving' ? '저장 중...'
                        : '이 이미지를 갤러리에 저장 (선택)'
                      }
                    >
                      <button
                        onClick={handleSaveAttachedToGallery}
                        disabled={attachedSaveState === 'saving' || attachedSaveState === 'saved'}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors disabled:cursor-default ${
                          attachedSaveState === 'saved' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : attachedSaveState === 'error' ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                          : attachedSaveState === 'saving' ? 'bg-slate-100 text-slate-500 border border-slate-200'
                          : 'text-slate-500 hover:text-purple-700 hover:bg-purple-50 border border-slate-200 hover:border-purple-200'
                        }`}
                      >
                        <ImageIcon size={12} />
                        <span>
                          {attachedSaveState === 'saved' ? '저장됨 ✓'
                          : attachedSaveState === 'error' ? '재시도'
                          : attachedSaveState === 'saving' ? '저장 중'
                          : '갤러리 저장'}
                        </span>
                      </button>
                    </Tooltip>
                  </div>
                )}
                <label htmlFor={chatInputId} className="sr-only">{t('admin_chat.placeholder_default')}</label>
                <textarea
                  id={chatInputId}
                  name="chatInput"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  disabled={loading}
                  autoComplete="off"
                  aria-label={t('admin_chat.placeholder_default')}
                  style={{ touchAction: 'pan-y', overscrollBehavior: 'contain', WebkitUserSelect: 'text', WebkitOverflowScrolling: 'touch' }}
                  className="w-full min-h-[56px] sm:min-h-[90px] max-h-[250px] px-4 sm:px-5 pt-3 sm:pt-4 pb-1 bg-transparent outline-none resize-none text-[16px] leading-relaxed text-slate-800 disabled:opacity-50 select-text overflow-y-auto"
                  placeholder={
                    loading
                      ? t('admin_chat.placeholder_loading')
                      : (inputMode === 'image' ? t('admin_chat.placeholder_image_mode') : t('admin_chat.placeholder_default'))
                  }
                />
                <input
                  ref={imageInputRef}
                  id={imageFileInputId}
                  name="chatImageAttach"
                  type="file"
                  accept="image/*"
                  autoComplete="off"
                  aria-label={t('chat_input.attach_image')}
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageSelect(f); e.target.value = ''; }}
                />
                <div className="flex items-center justify-between px-2 sm:px-3 py-2">
                  <div className="flex items-center gap-1">
                    <div className="relative">
                      <button
                        onClick={() => setShowPlusMenu(v => !v)}
                        disabled={loading}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                      >
                        <Plus size={20} />
                      </button>
                      {showPlusMenu && (
                        <>
                          <div className="fixed inset-0 z-20" onClick={() => setShowPlusMenu(false)} />
                          <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-xl shadow-lg z-30 py-1 min-w-[160px]">
                            <button
                              onClick={() => { imageInputRef.current?.click(); setShowPlusMenu(false); }}
                              className="flex items-center gap-2.5 w-full px-4 py-2.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                            >
                              <ImagePlus size={16} className="text-slate-400" />
                              {t('chat_input.attach_image')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    {/* 플랜모드 3단계 토글 — OFF / AUTO / ALWAYS 순환. 이미지 모드일 땐 의미 없음 (비활성) */}
                    {(() => {
                      const planTooltip = inputMode === 'image'
                        ? t('chat_input.plan_image_mode_disabled')
                        : planMode === 'always'
                          ? t('chat_input.plan_mode_always_tooltip')
                          : planMode === 'auto'
                            ? t('chat_input.plan_mode_auto_tooltip')
                            : t('chat_input.plan_mode_off_tooltip');
                      const planLabel = planMode === 'always' ? 'ALWAYS' : planMode === 'auto' ? 'AUTO' : 'OFF';
                      const planClass = planMode === 'always'
                        ? 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100'
                        : planMode === 'auto'
                          ? 'bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100'
                          : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100 border border-transparent';
                      const cyclePlan = () => {
                        const next = planMode === 'off' ? 'auto' : planMode === 'auto' ? 'always' : 'off';
                        setPlanMode(next);
                      };
                      return (
                        <Tooltip label={planTooltip}>
                          <button
                            onClick={cyclePlan}
                            disabled={loading || inputMode === 'image'}
                            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-50 ${planClass}`}
                          >
                            <ListChecks size={14} />
                            <span className="inline-block min-w-[42px] text-center">{planLabel}</span>
                          </button>
                        </Tooltip>
                      );
                    })()}
                    {/* 이미지 모드 토글 — LLM 우회 직접 image_gen */}
                    <Tooltip label={inputMode === 'image' ? t('chat_input.image_mode_on') : t('chat_input.image_mode_toggle')}>
                    <button
                      onClick={() => setInputMode(inputMode === 'image' ? 'text' : 'image')}
                      disabled={loading}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-50 ${
                        inputMode === 'image'
                          ? 'bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100'
                          : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100 border border-transparent'
                      }`}
                    >
                      <ImageIcon size={14} />
                      <span>{t('chat_input.image_label')}</span>
                    </button>
                    </Tooltip>
                    {/* StatusManager 활성 작업 인디케이터 — 활성·종료 작업 0이면 자동 숨김 */}
                    <ActiveJobsIndicator />
                  </div>
                  <Tooltip label={loading ? t('chat_input.stop_generation') : t('chat_input.send')}>
                  <button
                    onClick={() => loading ? handleStop() : handleSubmit()}
                    disabled={!loading && !input.trim()}
                    className="bg-slate-800 hover:bg-slate-900 border border-slate-700 text-white disabled:bg-slate-300 disabled:text-slate-500 disabled:border-slate-300 disabled:cursor-not-allowed h-8 w-8 sm:h-10 sm:w-10 rounded-lg sm:rounded-xl transition-all flex items-center justify-center shadow-md active:scale-[0.98]"
                  >
                    {loading
                      ? <><Square size={12} fill="currentColor" className="sm:hidden" /><Square size={16} fill="currentColor" className="hidden sm:block" /></>
                      : <><Send size={14} className="sm:hidden" /><Send size={18} className="hidden sm:block" /></>
                    }
                  </button>
                  </Tooltip>
                </div>
              </div>
            </div>
            <div className="mt-2 sm:mt-4 text-center pb-1 sm:pb-2">
              <span className="text-[10px] sm:text-[11px] font-bold tracking-[0.2em] text-slate-400 uppercase">
                © All rights reserved Firebat
              </span>
            </div>
          </div>
        </div>

        {/* Hub page mode = 익명 방문자라 admin 전용 모달 (FileEditor / SettingsModal /
            SystemModuleSettings) 자동 mount 차단 — 사이드바 진입 경로 자체도 차단되어 있어
            상태 변경 자체가 불가능하지만 defense-in-depth 차원에서 추가. */}

        {/* 파일 에디터 모달 */}
        {!hubContext && editingFile && (
          <FileEditor
            filePath={editingFile}
            aiModel={aiModel}
            onClose={() => setEditingFile(null)}
            onSaved={() => refreshSidebar()}
          />
        )}

        {/* 설정 모달 */}
        {!hubContext && showSettings && (
          <SettingsModal
            aiModel={aiModel}
            onAiModelChange={setAiModel}
            onClose={() => { setShowSettings(false); setSettingsInitialTab(undefined); }}
            onSave={() => { setShowSettings(false); setSettingsInitialTab(undefined); }}
            onOpenModuleSettings={(name) => { setShowSettings(false); handleOpenModuleSettings(name); }}
            initialTab={settingsInitialTab}
          />
        )}

        {/* 시스템 모듈 설정 모달 — cms 는 라우트 (/admin/cms) 로 이동, 그 외는 모달 그대로 */}
        {!hubContext && editingModule && (
          <SystemModuleSettings
            moduleName={editingModule}
            onClose={() => setEditingModule(null)}
            onBack={() => { setEditingModule(null); setSettingsInitialTab('system'); setShowSettings(true); }}
          />
        )}
      </div>
    </div>
  );
}
