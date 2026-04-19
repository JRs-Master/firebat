'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Send, Cpu, AlertTriangle, Blocks, Ghost, ExternalLink, X, Check, Circle, Copy, CheckCheck, ImagePlus, Plus, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Sidebar } from './components/Sidebar';
import { FileEditor } from './components/FileEditor';
import { SettingsModal } from './components/SettingsModal';
import { SystemModuleSettings } from './components/SystemModuleSettings';
import { SecretInput } from './components/ChatWidgets';
import StockChart from './chat-components/StockChart';
import { ComponentRenderer } from '../(user)/[slug]/components';
import { useChat } from './hooks/useChat';
import { Message, StepStatus, GEMINI_MODELS } from './types';

// ─── 마크다운 커스텀 컴포넌트 ───────────────────────────────────────────────
const mdComponents = {
  h1: (props: any) => <h1 className="text-[18px] font-bold text-slate-800 mt-5 mb-2" {...props} />,
  h2: (props: any) => <h2 className="text-[16px] font-bold text-slate-800 mt-4 mb-1.5" {...props} />,
  h3: (props: any) => <h3 className="text-[15px] font-bold text-slate-800 mt-3 mb-1" {...props} />,
  h4: (props: any) => <h4 className="text-[14px] font-bold text-slate-700 mt-2 mb-1" {...props} />,
  p: (props: any) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props: any) => <ul className="list-disc list-outside ml-5 mb-2 space-y-1" {...props} />,
  ol: (props: any) => <ol className="list-decimal list-outside ml-5 mb-2 space-y-1" {...props} />,
  li: (props: any) => <li className="pl-0.5" {...props} />,
  strong: (props: any) => <strong className="font-bold text-slate-900" {...props} />,
  a: (props: any) => <a className="text-blue-600 hover:text-blue-800 underline" target="_blank" rel="noopener noreferrer" {...props} />,
  code: ({ inline, className, children, ...props }: any) => {
    const text = String(children).replace(/\n$/, '');
    const TOOL_NAMES = new Set(['render_html','execute','write_file','read_file','save_page','delete_page','delete_file','list_dir','list_pages','get_page','schedule_task','cancel_task','run_task','request_secret','suggest','mcp_call','network_request','list_cron_jobs','list_files']);
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
  table: (props: any) => (
    <div className="overflow-auto mb-2 rounded-xl border border-slate-200 max-h-[70vh]">
      <table className="min-w-full text-[13px] border-separate border-spacing-0" {...props} />
    </div>
  ),
  th: (props: any) => <th className="bg-slate-50 px-3 py-1.5 text-left font-bold text-slate-700 sticky top-0 z-10 border-b border-slate-200 min-w-[120px]" {...props} />,
  td: (props: any) => <td className="px-3 py-1.5 text-slate-600 border-b border-slate-100 min-w-[120px] align-top break-words" {...props} />,
  hr: () => <hr className="border-slate-200 my-3" />,
};

function cleanMarkdown(text: string): string {
  // **text** → <strong>text</strong> 변환 (CommonMark 파서가 한국어+따옴표 조합에서 볼드 인식 실패 방지)
  let cleaned = text.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>');
  // 남은 고아 ** 제거
  cleaned = cleaned.replace(/\*\*/g, '');
  // AI가 render_* 를 코드블록에 출력한 경우 제거 (렌더링 안 되고 길게 늘어지는 환각 텍스트)
  // 지원 패턴:
  //   1. "type":"render_xxx" 형태
  //   2. render_xxx(...) 함수 호출 형태
  //   3. // 로 시작하는 주석이 있는 json 블록 (AI가 데이터를 나열하며 narrative 주석 붙이는 환각 패턴)
  //   4. OHLCV/차트용 props 덤프 (symbol + data 배열 + open/high/low/close)
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?["']type["']\s*:\s*["']render_[a-z_]+["'][\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?render_[a-z_]+\s*\([\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```json\s*\n\s*\/\/[^\n]*\n[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?["']symbol["']\s*:[\s\S]*?["']data["']\s*:\s*\[[\s\S]*?["'](open|close|high|low)["'][\s\S]*?```/g, '');
  return cleaned;
}

function renderMarkdown(text: string) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={mdComponents}>{cleanMarkdown(text)}</ReactMarkdown>;
}

// ─── 선택지 버튼 (텍스트 버튼 + 인라인 입력 + 토글 다중 선택) ─────────────────
function SuggestionButtons({ suggestions, loading, onSuggestion }: {
  suggestions: (string | { type: 'input'; label: string; placeholder?: string } | { type: 'toggle'; label: string; options: string[]; defaults?: string[] })[];
  loading: boolean;
  onSuggestion?: (text: string) => void;
}) {
  const [openInput, setOpenInput] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [toggleSelections, setToggleSelections] = useState<Record<number, Set<string>>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // 토글 기본값 초기화
  useEffect(() => {
    const init: Record<number, Set<string>> = {};
    suggestions.forEach((item, i) => {
      if (typeof item !== 'string' && item.type === 'toggle') {
        init[i] = new Set(item.defaults ?? item.options);
      }
    });
    setToggleSelections(init);
  }, [suggestions]);

  useEffect(() => {
    if (openInput !== null) inputRef.current?.focus();
  }, [openInput]);

  const handleInputSubmit = () => {
    if (!inputValue.trim()) return;
    onSuggestion?.(inputValue.trim());
    setOpenInput(null);
    setInputValue('');
  };

  const toggleOption = (idx: number, option: string) => {
    setToggleSelections(prev => {
      const set = new Set(prev[idx] ?? []);
      if (set.has(option)) set.delete(option);
      else set.add(option);
      return { ...prev, [idx]: set };
    });
  };

  const handleToggleSubmit = (idx: number, label: string) => {
    const selected = Array.from(toggleSelections[idx] ?? []);
    if (selected.length === 0) return;
    onSuggestion?.(`${label}: ${selected.join(', ')}`);
  };

  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden bg-slate-50/50 max-w-md">
      {suggestions.map((item, i) => {
        if (typeof item === 'string') {
          return (
            <button key={i} onClick={() => onSuggestion?.(item)} disabled={loading}
              className="w-full px-4 py-3 text-left text-[13px] font-medium text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50 border-b border-slate-200 last:border-b-0">
              {item}
            </button>
          );
        }
        if (item.type === 'input') {
          if (openInput === i) {
            return (
              <div key={i} className="flex items-center gap-1.5 px-3 py-2.5 border-b border-slate-200 last:border-b-0">
                <input ref={inputRef} value={inputValue} onChange={e => setInputValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleInputSubmit()}
                  placeholder={item.placeholder || '입력하세요'}
                  className="flex-1 px-3 py-1.5 border border-blue-300 rounded-lg text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white" />
                <button onClick={handleInputSubmit} disabled={!inputValue.trim()}
                  className="p-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:opacity-50">
                  <Send size={14} />
                </button>
                <button onClick={() => { setOpenInput(null); setInputValue(''); }}
                  className="p-1.5 text-slate-400 hover:text-slate-600">
                  <X size={14} />
                </button>
              </div>
            );
          }
          return (
            <button key={i} onClick={() => setOpenInput(i)} disabled={loading}
              className="w-full px-4 py-3 text-left text-[13px] font-medium text-slate-400 hover:bg-slate-100 transition-colors disabled:opacity-50 border-b border-slate-200 last:border-b-0">
              {item.label}
            </button>
          );
        }
        if (item.type === 'toggle') {
          const selected = toggleSelections[i] ?? new Set();
          return (
            <div key={i} className="flex flex-col px-4 py-3 border-b border-slate-200 last:border-b-0">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{item.label}</span>
              <div className="flex flex-col gap-1 mt-2">
                {item.options.map(opt => (
                  <button key={opt} onClick={() => toggleOption(i, opt)} disabled={loading}
                    className={`w-full px-4 py-2.5 text-left text-[13px] font-medium rounded-xl transition-colors border ${
                      selected.has(opt)
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'bg-white text-slate-500 border-slate-100 hover:bg-slate-50'
                    } disabled:opacity-50`}>
                    {opt}
                  </button>
                ))}
              </div>
              <button onClick={() => handleToggleSubmit(i, item.label)} disabled={loading || selected.size === 0}
                className="self-end mt-2.5 px-4 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-[12px] font-medium rounded-full transition-colors disabled:opacity-40">
                선택 완료 ({selected.size}개)
              </button>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ─── 자동 높이 iframe — 내부 콘텐츠에 맞춰 높이 자동 확장 ──────────────────
function AutoResizeIframe({ src, initialHeight }: { src: string; initialHeight?: string }) {
  const idRef = useRef('ifr-' + Math.random().toString(36).slice(2, 10));
  const [height, setHeight] = useState(initialHeight || '200px');

  // srcdoc 은 src 가 실제로 바뀔 때만 재계산 — 답변 애니메이션 중 부모 리렌더 때마다
  // 새 srcdoc 문자열을 생성해서 iframe 이 리로드되던 문제 (leaflet 지도 깜빡임 등) 방지
  const srcdoc = useMemo(() => {
    const isFullDoc = src.trim().toLowerCase().startsWith('<!doctype') || src.trim().toLowerCase().startsWith('<html');
    const baseStyle = `<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" /><style>html,body{overflow:hidden !important;font-family:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;color:#1e293b;background:#ffffff;-webkit-font-smoothing:antialiased;}body{font-size:14px;line-height:1.6;}h1,h2,h3,h4,h5,h6{font-weight:700;color:#0f172a;letter-spacing:-0.01em;}h1{font-size:20px;}h2{font-size:17px;}h3{font-size:15px;}table{font-size:13px;}canvas,svg{font-family:inherit !important;}</style>`;
    const autoScript = `<script>(function(){var id=${JSON.stringify(idRef.current)};var peak=0;function measure(){var b=document.body;if(!b)return 0;return Math.max(b.scrollHeight,b.offsetHeight,Math.ceil(b.getBoundingClientRect().height));}function send(){var h=measure();if(h<=peak)return;peak=h;parent.postMessage({type:'iframe-resize',id:id,height:h},'*');}function attach(){if(!document.body)return;if(window.ResizeObserver)new ResizeObserver(send).observe(document.body);send();}if(document.body)attach();else document.addEventListener('DOMContentLoaded',attach);window.addEventListener('load',send);[100,500,1500,3000].forEach(function(t){setTimeout(send,t);});})();<\/script><script>(function(){var last=null;function toMouse(e){if(!e.touches||e.touches.length!==1)return;var t=e.touches[0];var tg=document.elementFromPoint(t.clientX,t.clientY);if(!tg)return;tg.dispatchEvent(new MouseEvent('mousemove',{clientX:t.clientX,clientY:t.clientY,bubbles:true,cancelable:true,view:window}));last=tg;}document.addEventListener('touchstart',toMouse,{passive:true});document.addEventListener('touchmove',toMouse,{passive:true});document.addEventListener('touchend',function(){if(last){last.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));last=null;}},{passive:true});})();<\/script>`;
    return isFullDoc
      ? src.replace(/<\/head>/i, baseStyle + '</head>').replace(/<\/body>/i, autoScript + '</body>')
      : `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${baseStyle}<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:4px;max-width:100vw}img,table{max-width:100%!important;height:auto}canvas{max-width:100%}</style></head><body>${src}${autoScript}</body></html>`;
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

// ─── Thinking 블록 — 버블 상단에 항상 표시 ──────────────────────────────────
function ThinkingBlock({ statusText, thinkingText, isActive }: { statusText?: string; thinkingText?: string; isActive?: boolean }) {
  if (!isActive && !thinkingText) return null;
  if (thinkingText === '답변 완료') {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-[12px] sm:text-[13px]">
        <Cpu size={13} className="shrink-0" />
        <span>답변 완료</span>
      </div>
    );
  }
  if (statusText) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-[12px] sm:text-[13px]">
        <div className="animate-spin shrink-0"><Cpu size={13} /></div>
        <span className="truncate">{statusText}</span>
      </div>
    );
  }
  if (thinkingText) {
    const lines = thinkingText.split('\n').filter(l => l.trim());
    const last = lines.length > 0 ? lines[lines.length - 1].trim() : '';
    const content = last.length > 50 ? last.slice(-50) + '…' : last;
    return (
      <div className="flex items-center gap-2 text-slate-400 text-[12px] sm:text-[13px]">
        <div className="animate-spin shrink-0"><Cpu size={13} /></div>
        <span className="truncate">생각 중... {content}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-slate-400 text-[12px] sm:text-[13px]">
      <div className="animate-spin shrink-0"><Cpu size={13} /></div>
      <span>생각 중...</span>
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const showOk = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
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
    <button
      onClick={handleCopy}
      className="p-1 rounded text-slate-300 hover:text-slate-500 transition-colors"
      title={copied ? '복사됨' : '복사'}
    >
      {copied ? <CheckCheck size={14} className="text-emerald-500" /> : <Copy size={14} />}
    </button>
  );
}

// ─── 액션 태그 (에러 시 빨간색 + 클릭 펼침) ──────────────────────────────────
function ActionTags({ actions, steps }: { actions: string[]; steps?: StepStatus[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // 같은 도구 중복은 하나로 합치고 호출 횟수를 xN으로 표시
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const a of actions) {
    if (!counts.has(a)) order.push(a);
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {order.map((action, i) => {
          const step = steps?.find(s => s.type === action && s.status === 'error');
          const isError = !!step;
          const n = counts.get(action) || 1;
          return (
            <div
              key={i}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${isError ? 'bg-red-50 border border-red-100 text-red-600 cursor-pointer hover:bg-red-100' : 'bg-slate-50 border border-slate-200 text-slate-500'} transition-colors`}
              onClick={isError ? () => setOpenIdx(openIdx === i ? null : i) : undefined}
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
        return step?.error ? (
          <div className="px-3 py-2 bg-red-50/50 border border-red-100 rounded-md text-[12px] font-mono text-red-600 leading-relaxed break-all">
            {step.error}
          </div>
        ) : null;
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
function MessageBubble({ msg, loading, onConfirm, onReject, onSuggestion, onApprovePending, onRejectPending, onApprovePendingAction }: {
  msg: Message;
  loading: boolean;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  onSuggestion?: (text: string) => void;
  onApprovePending?: (msgId: string, planId: string) => void;
  onRejectPending?: (msgId: string, planId: string) => void;
  onApprovePendingAction?: (msgId: string, planId: string, action: 'now' | 'reschedule', newRunAt?: string) => void;
}) {
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
          <div className="bg-slate-800 text-white px-4 py-3 sm:px-6 sm:py-4 rounded-3xl rounded-tr-sm shadow-md text-[14px] sm:text-[15.5px] leading-relaxed break-words border border-slate-700 w-fit">
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
          {/* thinking — 버블 상단에 항상 표시 */}
          {(msg.isThinking || msg.thinkingText) && (
            <ThinkingBlock statusText={msg.statusText} thinkingText={msg.thinkingText} isActive={msg.isThinking && !msg.streaming} />
          )}
          {(!msg.isThinking || msg.streaming || msg.content) && (
            <div className="flex flex-col gap-5">
              {/* 확인 필요한 액션만 Plan 박스 표시 */}
              {msg.planPending && msg.plan && msg.plan.actions.length > 0 && (
                <div className="flex flex-col gap-3 bg-slate-50 border border-slate-200 rounded-2xl p-5">
                  <div className="flex flex-col gap-2">
                    {msg.plan.actions.map((action, i) => (
                      <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-white border border-slate-100 text-slate-500">
                        <Circle size={14} className="text-slate-300" />
                        <span className="flex-1">{action.description || action.type}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3 mt-2">
                    <button
                      onClick={() => onConfirm(msg.id)}
                      disabled={loading}
                      className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-[13px] font-bold rounded-xl transition-colors shadow-sm"
                    >
                      <Check size={16} /> 실행
                    </button>
                    <button
                      onClick={() => onReject(msg.id)}
                      disabled={loading}
                      className="flex items-center gap-2 px-5 py-2.5 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-50 text-slate-600 text-[13px] font-bold rounded-xl transition-colors"
                    >
                      <X size={16} /> 취소
                    </button>
                  </div>
                </div>
              )}

              {/* 인라인 블록 렌더링 — text/html 순서 보존 (Claude 스타일) */}
              {msg.data?.blocks && Array.isArray(msg.data.blocks) && msg.data.blocks.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {msg.data.blocks.map((b: any, i: number) => {
                    if (b.type === 'text') return <div key={i} className="text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1">{renderMarkdown(b.text)}</div>;
                    if (b.type === 'html') return <AutoResizeIframe key={i} src={b.htmlContent as string} initialHeight={b.htmlHeight} />;
                    if (b.type === 'component') return <ComponentRenderer key={i} components={[{ type: b.name, props: b.props || {} }]} />;
                    return null;
                  })}
                </div>
              ) : (
                <>
                  {msg.content && (
                    <div className="text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1">
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
                          <AutoResizeIframe key={i} src={h.htmlContent as string} initialHeight={h.htmlHeight} />
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

              {/* 선택지 버튼 */}
              {msg.suggestions && msg.suggestions.length > 0 && (
                <SuggestionButtons suggestions={msg.suggestions} loading={loading} onSuggestion={onSuggestion} />
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
                    {/* MCP 결과는 AI가 reply에서 자연어로 요약 — raw JSON 표시 안 함 */}
                    {/* 실행 결과 JSON은 표시하지 않음 — AI가 reply에서 자연어로 요약 */}
                  </>
                );
              })()}

              {/* Pending Actions — 승인 버튼 (액션 필요, 눈에 띄게 위쪽) */}
              {msg.pendingActions && msg.pendingActions.length > 0 && (
                <div className="flex flex-col gap-2">
                  {msg.pendingActions.map(p => (
                    <div key={p.planId} className={`flex flex-col gap-1 px-3 py-2.5 rounded-xl ${p.status === 'past-runat' || p.status === 'error' ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'}`}>
                      {p.status === 'past-runat' && (
                        <div className="text-[11px] font-bold text-red-600">
                          ⏱ 예약 시각이 이미 지났습니다 ({p.originalRunAt ? new Date(p.originalRunAt).toLocaleString('ko-KR') : '-'}). 즉시 보낼지 시간을 변경할지 선택하세요.
                        </div>
                      )}
                      {p.status === 'error' && p.errorMessage && (
                        <div className="text-[11px] font-bold text-red-600 break-all">⚠ 실행 실패: {p.errorMessage}</div>
                      )}
                      <div className="flex items-center gap-2">
                      <AlertTriangle size={15} className={`shrink-0 ${p.status === 'past-runat' ? 'text-red-500' : 'text-amber-600'}`} />
                      <span className="flex-1 text-[13px] font-medium text-slate-700 truncate">{p.summary}</span>
                      {p.status === 'approved' ? (
                        <span className="text-[12px] font-bold text-emerald-600 px-2">✓ 실행됨</span>
                      ) : p.status === 'rejected' ? (
                        <span className="text-[12px] font-medium text-slate-400 px-2">취소됨</span>
                      ) : p.status === 'error' ? null : p.status === 'past-runat' ? (
                        <>
                          <button
                            onClick={() => onApprovePendingAction?.(msg.id, p.planId, 'now')}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold rounded-lg transition-colors shadow-sm"
                          >
                            즉시 보내기
                          </button>
                          <button
                            onClick={() => {
                              const cur = new Date(Date.now() + 5 * 60_000);
                              const yyyy = cur.getFullYear(), mm = String(cur.getMonth() + 1).padStart(2, '0'), dd = String(cur.getDate()).padStart(2, '0');
                              const hh = String(cur.getHours()).padStart(2, '0'), mi = String(cur.getMinutes()).padStart(2, '0');
                              const suggested = `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
                              const input = window.prompt('새 예약 시각 (YYYY-MM-DDTHH:mm)', suggested);
                              if (!input) return;
                              // 초·타임존 보정 — 입력값은 사용자 로컬 시각 가정
                              const iso = input.length === 16 ? input + ':00' : input;
                              onApprovePendingAction?.(msg.id, p.planId, 'reschedule', iso);
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-bold rounded-lg border border-slate-300 transition-colors"
                          >
                            시간 변경
                          </button>
                          <button
                            onClick={() => onRejectPending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-2 py-1.5 bg-white hover:bg-slate-50 text-slate-400 text-[12px] font-bold rounded-lg border border-slate-200 transition-colors"
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => onApprovePending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold rounded-lg transition-colors shadow-sm"
                          >
                            <Check size={13} /> 승인
                          </button>
                          <button
                            onClick={() => onRejectPending?.(msg.id, p.planId)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-500 text-[12px] font-bold rounded-lg border border-slate-200 transition-colors"
                          >
                            <X size={13} /> 거부
                          </button>
                        </>
                      )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 실행 완료된 액션 태그 — 최하단, 미니멀 */}
              {msg.executedActions && msg.executedActions.length > 0 && !msg.plan && (
                <ActionTags actions={msg.executedActions} steps={msg.steps} />
              )}
            </div>
          )}
        </div>
        {/* 복사 버튼 — 버블 바깥 우측 하단 */}
        {(msg.content || (msg.data?.blocks && msg.data.blocks.length > 0)) && !msg.isThinking && (() => {
          // 전체 텍스트 수집: blocks 있으면 blocks의 text만 합침, 없으면 content
          let full = '';
          if (msg.data?.blocks && Array.isArray(msg.data.blocks)) {
            full = msg.data.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n\n');
          }
          if (!full && msg.content) full = msg.content;
          return full ? (
            <div className="flex justify-end pr-1">
              <CopyButton text={full} />
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
export default function AdminConsole() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'secrets' | 'mcp' | 'capabilities' | 'system' | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [aiModel, setAiModel] = useState('gpt-5.4-mini');
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editingModule, setEditingModule] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  const fetchFileTree = useCallback(async () => {}, []);

  const {
    messages, input, setInput, loading,
    attachedImage, setAttachedImage,
    conversations, activeConvId, chatEndRef, chatContainerRef, handleScroll,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit, handleConfirmPlan, handleRejectPlan,
    handleApprovePending, handleRejectPending, handleStop,
  } = useChat(aiModel, fetchFileTree, isDemo);

  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleImageSelect = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) return; // 10MB 제한
    const reader = new FileReader();
    reader.onload = () => setAttachedImage(reader.result as string);
    reader.readAsDataURL(file);
  }, [setAttachedImage]);

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

  // 초기화
  useEffect(() => {
    const role = document.cookie.split(';').find(c => c.trim().startsWith('firebat_role='))?.split('=')[1];
    setIsDemo(role === 'demo');
    // 서버(Vault)에서 모델 로드 — 실패 시 localStorage 폴백
    (async () => {
      const isValid = (m: string) => GEMINI_MODELS.some(x => x.value === m);
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success && data.aiModel && isValid(data.aiModel)) {
          setAiModel(data.aiModel);
          return;
        }
      } catch {}
      const savedModel = localStorage.getItem('firebat_model');
      setAiModel(savedModel && isValid(savedModel) ? savedModel : 'gpt-5.4-mini');
    })();
  }, []);

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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  return (
    <div className="flex w-full h-full bg-slate-50 overflow-hidden">
      <Sidebar
        onRefreshTree={fetchFileTree}
        conversations={conversations}
        activeConvId={activeConvId}
        onSelectConv={handleSelectConv}
        onNewConv={handleNewConv}
        onDeleteConv={handleDeleteConv}
        isDemo={isDemo}
        onOpenSettings={() => setShowSettings(true)}
        onEditFile={(filePath) => setEditingFile(filePath)}
        onOpenModuleSettings={(name) => setEditingModule(name)}
        mobileOpen={mobileMenuOpen}
        onMobileOpenChange={setMobileMenuOpen}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* PC 상단 그라디언트 */}
        <div className="hidden md:block absolute top-0 left-0 w-full h-12 bg-gradient-to-b from-slate-50 to-transparent z-10 pointer-events-none" />

        {/* 메시지 목록 */}
        <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 md:px-12 pt-4 md:pt-16 scrolltext">
          <div className="w-full md:w-[70%] max-w-6xl mx-auto space-y-10">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                loading={loading}
                onConfirm={handleConfirmPlan}
                onReject={handleRejectPlan}
                onSuggestion={(text) => handleSubmit(text, true)}
                onApprovePending={handleApprovePending}
                onApprovePendingAction={(msgId, planId, action, newRunAt) => handleApprovePending(msgId, planId, action, newRunAt)}
                onRejectPending={handleRejectPending}
              />
            ))}
            <div className="h-48 sm:h-64 shrink-0 pointer-events-none" />
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
                {/* 이미지 미리보기 */}
                {attachedImage && (
                  <div className="px-4 pt-3 pb-1">
                    <div className="relative inline-block">
                      <img src={attachedImage} alt="첨부" className="max-h-[120px] max-w-[200px] rounded-xl border border-slate-200 object-cover" />
                      <button
                        onClick={() => setAttachedImage(null)}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-slate-800 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                )}
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  disabled={loading}
                  style={{ touchAction: 'pan-y', overscrollBehavior: 'contain', WebkitUserSelect: 'text', WebkitOverflowScrolling: 'touch' }}
                  className="w-full min-h-[56px] sm:min-h-[90px] max-h-[250px] px-4 sm:px-5 pt-3 sm:pt-4 pb-1 bg-transparent outline-none resize-none text-[16px] leading-relaxed text-slate-800 disabled:opacity-50 select-text overflow-y-auto"
                  placeholder={loading ? '명령 집행 중...' : '무엇을 도와드릴까요?'}
                />
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageSelect(f); e.target.value = ''; }}
                />
                <div className="flex items-center justify-between px-2 sm:px-3 py-2">
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
                            이미지 첨부
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    onClick={() => loading ? handleStop() : handleSubmit()}
                    disabled={!loading && !input.trim()}
                    title={loading ? '생성 중지' : '전송'}
                    className="bg-slate-800 hover:bg-slate-900 border border-slate-700 text-white disabled:bg-slate-300 disabled:text-slate-500 disabled:border-slate-300 disabled:cursor-not-allowed h-8 w-8 sm:h-10 sm:w-10 rounded-lg sm:rounded-xl transition-all flex items-center justify-center shadow-md active:scale-[0.98]"
                  >
                    {loading
                      ? <><Square size={12} fill="currentColor" className="sm:hidden" /><Square size={16} fill="currentColor" className="hidden sm:block" /></>
                      : <><Send size={14} className="sm:hidden" /><Send size={18} className="hidden sm:block" /></>
                    }
                  </button>
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

        {/* 파일 에디터 모달 */}
        {editingFile && (
          <FileEditor
            filePath={editingFile}
            onClose={() => setEditingFile(null)}
            onSaved={() => fetchFileTree()}
          />
        )}

        {/* 설정 모달 */}
        {showSettings && (
          <SettingsModal
            isDemo={isDemo}
            aiModel={aiModel}
            onAiModelChange={setAiModel}
            onClose={() => { setShowSettings(false); setSettingsInitialTab(undefined); }}
            onSave={() => { setShowSettings(false); setSettingsInitialTab(undefined); }}
            onOpenModuleSettings={(name) => { setShowSettings(false); setEditingModule(name); }}
            initialTab={settingsInitialTab}
          />
        )}

        {/* 시스템 모듈 설정 모달 */}
        {editingModule && (
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
