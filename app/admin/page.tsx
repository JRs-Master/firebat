'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Send, Cpu, AlertTriangle, Blocks, Ghost, ExternalLink, X, Check, Circle, Copy, CheckCheck, ImagePlus, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Sidebar } from './components/Sidebar';
import { FileEditor } from './components/FileEditor';
import { SettingsModal } from './components/SettingsModal';
import { SystemModuleSettings } from './components/SystemModuleSettings';
import { SecretInput } from './components/ChatWidgets';
import { useChat } from './hooks/useChat';
import { Message, StepStatus } from './types';

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
  table: (props: any) => <div className="overflow-x-auto mb-2"><table className="w-full text-[13px] border-collapse" {...props} /></div>,
  th: (props: any) => <th className="border border-slate-200 bg-slate-50 px-3 py-1.5 text-left font-bold text-slate-700" {...props} />,
  td: (props: any) => <td className="border border-slate-200 px-3 py-1.5 text-slate-600" {...props} />,
  hr: () => <hr className="border-slate-200 my-3" />,
};

function cleanMarkdown(text: string): string {
  // **text** → <strong>text</strong> 변환 (CommonMark 파서가 한국어+따옴표 조합에서 볼드 인식 실패 방지)
  let cleaned = text.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>');
  // 남은 고아 ** 제거
  cleaned = cleaned.replace(/\*\*/g, '');
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

// ─── Thinking 블록 — 버블 상단에 항상 표시 ──────────────────────────────────
function ThinkingBlock({ statusText, thinkingText, isActive }: { statusText?: string; thinkingText?: string; isActive?: boolean }) {
  if (!isActive && !thinkingText) return null;
  const label = (() => {
    if (isActive) {
      if (statusText) return statusText;
      if (thinkingText) {
        const lines = thinkingText.split('\n').filter(l => l.trim());
        const last = lines.length > 0 ? lines[lines.length - 1].trim() : '';
        return '생각 중... ' + (last.length > 50 ? last.slice(-50) + '…' : last);
      }
      return '생각 중...';
    }
    return thinkingText === '답변 완료' ? '답변 완료' : '답변 중...';
  })();
  return (
    <div className="flex items-center gap-2 text-slate-400 text-[12px] sm:text-[13px]">
      {isActive ? <div className="animate-spin shrink-0"><Cpu size={13} /></div> : <Cpu size={13} className="shrink-0" />}
      <span className="truncate">{label}</span>
    </div>
  );
}

// ─── 복사 버튼 ─────────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded text-slate-300 hover:text-slate-500 transition-colors"
      title="복사"
    >
      {copied ? <CheckCheck size={14} className="text-emerald-500" /> : <Copy size={14} />}
    </button>
  );
}

// ─── 액션 태그 (에러 시 빨간색 + 클릭 펼침) ──────────────────────────────────
function ActionTags({ actions, steps }: { actions: string[]; steps?: StepStatus[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {actions.map((action, i) => {
          const step = steps?.find(s => s.type === action && s.status === 'error');
          const isError = !!step;
          return (
            <div
              key={i}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-bold tracking-tight shadow-sm ${isError ? 'bg-red-50 border border-red-100 text-red-700 cursor-pointer hover:bg-red-100' : 'bg-indigo-50 border border-indigo-100 text-indigo-700'} transition-colors`}
              onClick={isError ? () => setOpenIdx(openIdx === i ? null : i) : undefined}
            >
              {isError ? <AlertTriangle size={14} className="text-red-500" /> : <Blocks size={14} className="text-indigo-500" />}
              {action}
            </div>
          );
        })}
      </div>
      {openIdx !== null && (() => {
        const action = actions[openIdx];
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
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-100 text-red-700 rounded-md text-[13px] font-bold tracking-tight shadow-sm cursor-pointer hover:bg-red-100 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <AlertTriangle size={14} className="text-red-500 shrink-0" />
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
function MessageBubble({ msg, loading, onConfirm, onReject, onSuggestion }: {
  msg: Message;
  loading: boolean;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  onSuggestion?: (text: string) => void;
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
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex flex-col gap-3 w-full bg-white px-4 py-3 sm:p-6 rounded-3xl rounded-tl-sm shadow-sm border border-slate-100">
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

              {msg.content && (
                <div className="text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1">
                  {renderMarkdown(msg.content)}
                </div>
              )}

              {/* 실행 완료된 액션 태그 — 에러 시 빨간색 + 클릭 펼침 */}
              {msg.executedActions && msg.executedActions.length > 0 && !msg.plan && (
                <ActionTags actions={msg.executedActions} steps={msg.steps} />
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

              {/* 인라인 HTML 렌더링 (차트/그래프 등) */}
              {msg.data && (() => {
                const dataObj = msg.data as any;
                const raw = dataObj?.htmlItems ?? (Array.isArray(dataObj) ? dataObj : [dataObj]);
                const htmlItems = raw.filter((d: any) => d && 'htmlContent' in d);
                return htmlItems.length > 0 ? (
                  <div className="space-y-3 mt-2">
                    {htmlItems.map((h: any, i: number) => {
                      const src = h.htmlContent as string;
                      const isFullDoc = src.trim().toLowerCase().startsWith('<!doctype') || src.trim().toLowerCase().startsWith('<html');
                      const srcdoc = isFullDoc ? src : `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:8px;overflow-x:hidden;max-width:100vw}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1e293b}canvas,svg,img,table,div{max-width:100%!important;height:auto}</style>
</head><body>${src}</body></html>`;
                      return (
                        <iframe
                          key={i}
                          srcDoc={srcdoc}
                          sandbox="allow-scripts"
                          className="w-full border border-slate-200 rounded-xl bg-white block"
                          style={{ height: h.htmlHeight || '400px', maxWidth: '100%' }}
                          title="Inline HTML"
                        />
                      );
                    })}
                  </div>
                ) : null;
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
            </div>
          )}
        </div>
        {/* 복사 버튼 — 버블 바깥 우측 하단 */}
        {msg.content && !msg.isThinking && (
          <div className="flex justify-end pr-1">
            <CopyButton text={msg.content} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
export default function AdminConsole() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'secrets' | 'mcp' | 'capabilities' | 'system' | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [aiModel, setAiModel] = useState('gemini-3-flash-preview');
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
  } = useChat(aiModel, fetchFileTree);

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

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) handleImageSelect(file);
        break;
      }
    }
  }, [handleImageSelect]);

  // 초기화
  useEffect(() => {
    const role = document.cookie.split(';').find(c => c.trim().startsWith('firebat_role='))?.split('=')[1];
    setIsDemo(role === 'demo');
    const savedModel = localStorage.getItem('firebat_model') || 'gemini-3-flash-preview';
    setAiModel(savedModel);
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
        <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 md:px-12 pt-4 md:pt-16 scrolltext">
          <div className="w-full md:w-[70%] max-w-6xl mx-auto space-y-10">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                loading={loading}
                onConfirm={handleConfirmPlan}
                onReject={handleRejectPlan}
                onSuggestion={(text) => handleSubmit(text, true)}
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
                  className="w-full min-h-[56px] sm:min-h-[90px] max-h-[250px] px-4 sm:px-5 pt-3 sm:pt-4 pb-1 bg-transparent outline-none resize-none text-[16px] leading-relaxed text-slate-800 disabled:opacity-50"
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
                    onClick={() => handleSubmit()}
                    disabled={!input.trim() || loading}
                    className="bg-slate-900 hover:bg-black disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed text-white h-8 w-8 sm:h-10 sm:w-10 rounded-lg sm:rounded-xl transition-all flex items-center justify-center shadow-md active:scale-[0.98]"
                  >
                    {loading
                      ? <div className="animate-spin text-white"><Cpu size={14} /></div>
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
