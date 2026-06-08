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
function SuggestionButtons({ suggestions, loading, onSuggestion }: {
  suggestions: (string | { type: 'input'; label: string; placeholder?: string } | { type: 'toggle'; label: string; options: string[]; defaults?: string[] } | { type: 'plan-confirm'; planId: string; label: string } | { type: 'plan-revise'; planId: string; label: string; placeholder?: string })[];
  loading: boolean;
  onSuggestion?: (text: string, meta?: { planExecuteId?: string; planReviseId?: string }) => void;
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

  // suggestions 변경 시 기본값 세팅 — toggle defaults + input 빈 칸 1개
  useEffect(() => {
    const tInit: Record<number, Set<string>> = {};
    const iInit: Record<number, string[]> = {};
    suggestions.forEach((item, i) => {
      if (typeof item === 'string') return;
      if (item.type === 'toggle') tInit[i] = new Set(item.defaults ?? item.options);
      if (item.type === 'input' || item.type === 'plan-revise') iInit[i] = [''];
    });
    setToggleValues(tInit);
    setInputValues(iInit);
    setCustomInput('');
  }, [suggestions]);

  const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  const toggleOption = (idx: number, opt: string) => {
    setToggleValues(prev => {
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

  return (
    // PC: max-w-md(448px) 로 capped + sm:ml-auto 로 우측 정렬. 모바일: w-full 로 부모 너비 꽉 채움.
    // w-full 없이 max-w-md 만 두면 content 자연 너비로 줄어드는 문제 — 두 클래스 조합 필수.
    <div className="border border-slate-200 rounded-2xl overflow-hidden bg-slate-50/50 w-full max-w-md sm:ml-auto">
      {suggestions.map((item, i) => {
        if (typeof item === 'string') {
          // 단일 버튼 — 즉시 전송
          return (
            <button key={i} onClick={() => onSuggestion?.(item)} disabled={loading}
              className="w-full px-4 py-3 text-left text-[13px] font-medium text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50 border-b border-slate-200 last:border-b-0">
              {item}
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
                {item.options.map(opt => (
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
        <div className="flex items-start gap-1.5 px-3 py-2.5 border-t border-slate-200 bg-slate-100/40">
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
        <div className="flex items-center justify-end gap-2 px-3 py-2.5 bg-slate-100/60 border-t border-slate-200">
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
type BuildSessionView = { id?: string; step?: string; tier?: string; status?: string; createdAt?: number };
/** 빌드 카드 1개에 담을 것 — 세션 최신 state + 직전 저장 페이지 미리보기 URL(carry-forward). */
type BuildCardData = { state: BuildSessionView; previewUrl?: string };

function MessageBubble({ msg, loading, onSuggestion, onConsumeSuggestions, onApprovePending, onRejectPending, onApprovePendingAction, shareContext, hubContext, buildCard }: {
  msg: Message;
  loading: boolean;
  onSuggestion?: (text: string, meta?: { planExecuteId?: string; planReviseId?: string }) => void;
  onConsumeSuggestions?: (msgId: string) => void;
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
                  onSuggestion={(text, meta) => {
                    onConsumeSuggestions?.(msg.id);
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
                    {/* Project Builder — 빌드 중이면 만들어진 페이지를 라이브 프리뷰 (큰 화면 = 아티팩트 드로어) */}
                    {!buildCard && urls.length > 0 && !Array.isArray(msg.data) && (msg.data as any)?.buildSession && (
                      <BuildPreview url={urls[0].openUrl} />
                    )}
                    {/* MCP 결과는 AI가 reply에서 자연어로 요약 — raw JSON 표시 안 함 */}
                    {/* 실행 결과 JSON은 표시하지 않음 — AI가 reply에서 자연어로 요약 */}
                  </>
                );
              })()}

              {/* Project Builder — 빌드 단계 stepper. 부모가 세션(buildSession.id) 단위로 그룹핑해 anchor(첫 등장)
                  메시지에만 최신 state 를 buildCard 로 전달 → 백엔드 멀티턴이어도 카드 1개가 첫 자리에서 1→2→3 진행. */}
              {buildCard && (() => {
                const bs = buildCard.state;
                const previewUrl = buildCard.previewUrl;
                const STEPS = [
                  { key: 'requirements', label: t('build.step_requirements') },
                  { key: 'design', label: t('build.step_design') },
                  { key: 'implement', label: t('build.step_implement') },
                  { key: 'iterate', label: t('build.step_iterate') },
                ].filter(s => !(bs.tier === 'T1' && s.key === 'design')); // T1(단순 페이지)은 설계 단계 skip
                const expired = !!bs.createdAt && Date.now() - bs.createdAt > 30 * 24 * 60 * 60 * 1000;
                const done = bs.status === 'completed';
                const curIdx = STEPS.findIndex(s => s.key === bs.step);
                const curLabel = curIdx >= 0 ? STEPS[curIdx]?.label : undefined;
                // A-lite: suggest 칩도 이 카드 안에 (별도 렌더는 buildCard 시 suppress). past-runat 은 즉시/시간변경 버튼과 중복 회피.
                const chips = !!msg.suggestions && msg.suggestions.length > 0
                  && !msg.pendingActions?.some(p => p.status === 'past-runat');
                return (
                  <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl bg-slate-50 border border-slate-200 mt-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                      <span>🔨 {t('build.in_progress')}{bs.tier ? ` · ${bs.tier}` : ''}</span>
                      {done && <span className="text-emerald-600">✓ {t('build.done')}</span>}
                      {expired && <span className="text-slate-400">⏰ {t('build.expired')}</span>}
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {STEPS.map((s, i) => (
                        <div key={s.key} className="flex items-center gap-1">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                            done || i < curIdx ? 'bg-emerald-100 text-emerald-700'
                            : i === curIdx ? 'bg-blue-600 text-white font-bold'
                            : 'bg-slate-100 text-slate-400'
                          }`}>{i + 1}. {s.label}</span>
                          {i < STEPS.length - 1 && <span className="text-slate-300 text-[10px]">→</span>}
                        </div>
                      ))}
                    </div>
                    {!done && curLabel && (
                      <div className="text-[12px] text-slate-600">{t('build.now_step', { step: curLabel })}</div>
                    )}
                    {previewUrl && <BuildPreview url={previewUrl} />}
                    {chips && (
                      <div className="pt-1.5 border-t border-slate-200/70">
                        <SuggestionButtons
                          suggestions={msg.suggestions!}
                          loading={loading}
                          onSuggestion={(text, meta) => { onConsumeSuggestions?.(msg.id); onSuggestion?.(text, meta); }}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}

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
                        <span className="inline-flex items-center px-3 py-1.5 text-[12px] font-bold text-emerald-600">✓ {p.name === 'schedule_task' ? t('plan.scheduled') : t('plan.executed')}</span>
                      ) : p.status === 'rejected' ? (
                        <span className="inline-flex items-center px-3 py-1.5 text-[12px] font-medium text-slate-400">{t('plan.cancelled')}</span>
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
                            className="flex items-center gap-1 px-2 py-1.5 bg-white hover:bg-slate-50 text-slate-400 text-[12px] font-bold rounded-lg border border-slate-200 transition-colors"
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : isExpired ? null : (
                        <>
                          <button
                            onClick={() => onApprovePending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold rounded-lg transition-colors shadow-sm"
                          >
                            <Check size={13} /> {t('plan.approve')}
                          </button>
                          <button
                            onClick={() => onRejectPending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-500 text-[12px] font-bold rounded-lg border border-slate-200 transition-colors"
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
function BuildPreview({ url }: { url: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="mt-2 rounded-xl border border-slate-200 overflow-hidden bg-white">
        <div className="px-3 py-1.5 text-[11px] font-bold text-slate-500 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
          <span>🔨 라이브 프리뷰</span>
          <button type="button" onClick={() => setExpanded(true)} className="ml-auto text-blue-600 hover:underline">큰 화면 ⛶</button>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">새 탭 ↗</a>
        </div>
        <iframe src={url} className="w-full h-[420px] border-0 bg-white" title="빌드 라이브 프리뷰" />
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex" onClick={() => setExpanded(false)}>
          <div className="ml-auto h-full w-full sm:w-[60%] bg-white flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-2.5 flex items-center gap-2 border-b border-slate-200 bg-slate-50 shrink-0">
              <span className="text-[13px] font-bold text-slate-600">🔨 빌드 아티팩트</span>
              <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto text-[12px] text-blue-600 hover:underline">새 탭 ↗</a>
              <button type="button" onClick={() => setExpanded(false)} className="text-[12px] font-bold text-slate-500 hover:text-slate-700">닫기 ✕</button>
            </div>
            <iframe src={url} className="flex-1 w-full border-0 bg-white" title="빌드 아티팩트" />
          </div>
        </div>
      )}
    </>
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
    handleApprovePending, handleRejectPending, handleStop, consumeSuggestions,
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

      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* PC 상단 그라디언트 */}
        <div className="hidden md:block absolute top-0 left-0 w-full h-12 bg-gradient-to-b from-slate-50 to-transparent z-10 pointer-events-none" />

        {/* 메시지 목록 */}
        <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 md:px-12 pt-4 md:pt-16 scrolltext">
          <div className="w-full md:w-[70%] max-w-6xl mx-auto space-y-10">
            {(() => {
              // Project Builder — 빌드 카드 통합: 같은 세션(buildSession.id)은 백엔드 멀티턴이어도 프론트엔 카드
              // 1개만. 세션별 첫 등장 메시지(anchor)에 최신 state 를 몰아줘 "한 자리에서 진행"처럼 보이게.
              const buildCardByMsg = new Map<string, BuildCardData>();
              {
                // 세션(buildSession.id)당 최신(마지막) 빌드 메시지에 카드 1개 — suggest 칩이 거기 있어 한 카드로
                // 묶이고 사용자 시선(하단)에 옴. 이전 턴 stepper/칩/프리뷰는 suppress → 화면엔 카드 1개(스택 X).
                // previewUrl 은 carry-forward(최신 메시지에 url 없어도 직전 저장 페이지 미리보기 유지).
                const lastOf = new Map<string, { msgId: string; state: BuildSessionView; previewUrl?: string }>();
                for (const m of messages) {
                  if (Array.isArray(m.data)) continue;
                  const d = m.data as { buildSession?: BuildSessionView; openUrl?: string } | undefined;
                  const bsv = d?.buildSession;
                  if (!bsv?.id) continue;
                  const prev = lastOf.get(bsv.id);
                  lastOf.set(bsv.id, { msgId: m.id, state: bsv, previewUrl: d?.openUrl ?? prev?.previewUrl });
                }
                for (const { msgId, state, previewUrl } of lastOf.values()) {
                  buildCardByMsg.set(msgId, { state, previewUrl });
                }
              }
              return messages.map((msg, idx) => {
              // 버튼 클릭 흔적 user 메시지 (✓ 실행, ✕ 취소, ⚙ 수정 등) — 과거 SEND_USER 경로로 저장된 잔재.
              // SEND_SUGGESTION 도입 이후 신규 대화에선 생성되지 않지만, 기존 대화 로드 시 잔존 — 렌더에서 숨김.
              if (isSuggestionClickUserMessage(msg)) return null;
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
                  onConsumeSuggestions={consumeSuggestions}
                  onApprovePending={handleApprovePending}
                  onApprovePendingAction={(msgId, planId, action, newRunAt) => handleApprovePending(msgId, planId, action, newRunAt)}
                  onRejectPending={handleRejectPending}
                  shareContext={shareContext}
                  hubContext={hubChatContext}
                  buildCard={buildCardByMsg.get(msg.id)}
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
        <div className="absolute bottom-0 w-full bg-gradient-to-t from-slate-50 via-slate-50 to-transparent pt-8 sm:pt-16 pb-3 sm:pb-8 px-4 md:px-12 pointer-events-none z-10">
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
