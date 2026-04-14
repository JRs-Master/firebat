'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Send, Cpu, AlertTriangle, Blocks, Bot, ExternalLink, X, Check, Loader2, Circle } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { FileEditor } from './components/FileEditor';
import { SettingsModal } from './components/SettingsModal';
import { SystemModuleSettings } from './components/SystemModuleSettings';
import { SecretInput } from './components/ChatWidgets';
import { useChat } from './hooks/useChat';
import { Message } from './types';

// ─── 간이 마크다운 렌더러 ────────────────────────────────────────────────────
function renderMarkdown(text: string) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { elements.push(<br key={key++} />); continue; }

    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) { elements.push(<h3 key={key++} className="text-[15px] font-bold text-slate-800 mt-3 mb-1">{inlineMd(h3[1])}</h3>); continue; }
    const h2 = trimmed.match(/^##\s+(.+)/);
    if (h2) { elements.push(<h2 key={key++} className="text-[16px] font-bold text-slate-800 mt-4 mb-1">{inlineMd(h2[1])}</h2>); continue; }

    const li = trimmed.match(/^[-*]\s+(.+)/);
    if (li) { elements.push(<div key={key++} className="flex gap-2 ml-1"><span className="text-slate-400 shrink-0">•</span><span>{inlineMd(li[1])}</span></div>); continue; }

    elements.push(<p key={key++}>{inlineMd(trimmed)}</p>);
  }
  return <>{elements}</>;
}

function inlineMd(text: string): React.ReactNode {
  const result: React.ReactNode[] = [];
  const regex = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s)<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) result.push(<span key={last}>{text.slice(last, m.index)}</span>);
    if (m[1] && m[2]) {
      result.push(<a key={m.index} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800">{m[1]}</a>);
    } else if (m[3]) {
      result.push(<strong key={m.index} className="font-bold text-slate-900">{m[3]}</strong>);
    } else if (m[4]) {
      result.push(<a key={m.index} href={m[4]} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800">{m[4]}</a>);
    }
    last = regex.lastIndex;
  }
  if (last < text.length) result.push(<span key={last}>{text.slice(last)}</span>);
  return <>{result}</>;
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

// ─── 플래닝 단계 문구 순환 ──────────────────────────────────────────────────
const THINKING_PHASES = [
  '명령을 분석하는 중...',
  '실행 전략을 구상하는 중...',
  '필요한 도구를 선택하는 중...',
  '실행 계획을 수립하는 중...',
];

function ThinkingText({ statusText }: { statusText?: string }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (statusText) return; // statusText가 있으면 순환 안 함
    const timer = setInterval(() => {
      setPhase(p => (p + 1) % THINKING_PHASES.length);
    }, 2500);
    return () => clearInterval(timer);
  }, [statusText]);

  return <span className="transition-opacity duration-300">{statusText || THINKING_PHASES[phase]}</span>;
}

// ─── 메시지 버블 ─────────────────────────────────────────────────────────────
function MessageBubble({ msg, loading, onConfirm, onReject, onSuggestion }: {
  msg: Message;
  loading: boolean;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  onSuggestion?: (text: string) => void;
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex w-full gap-4 items-start justify-end">
        <div className="flex flex-col gap-2 max-w-[75%]">
          <div className="bg-slate-800 text-white px-6 py-4 rounded-3xl rounded-tr-sm shadow-md text-[15.5px] leading-relaxed break-words border border-slate-700 w-fit self-end">
            {msg.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full gap-2 sm:gap-4 items-start">
      <div className="hidden sm:flex w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-50 to-blue-100 border border-blue-200 items-center justify-center shadow-sm shrink-0">
        <Bot size={22} className="text-blue-600" />
      </div>
      <div className="flex flex-col gap-2 flex-1 min-w-0">
        <div className="flex flex-col gap-3 w-full bg-white p-6 rounded-3xl rounded-tl-sm shadow-sm border border-slate-100">
          {msg.isThinking ? (
            <div className="flex items-center gap-3 text-slate-600 font-medium bg-slate-50 border border-slate-200 px-4 py-3 sm:px-6 sm:py-5 rounded-2xl shadow-inner text-[13px] sm:text-[15px]">
              <div className="animate-spin text-blue-600 shrink-0"><Cpu size={18} /></div>
              <ThinkingText statusText={msg.statusText} />
            </div>
          ) : (
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
                <div className="text-slate-800 text-[15px] leading-relaxed border-l-4 border-slate-200 pl-4 py-1 space-y-1">
                  {renderMarkdown(msg.content)}
                </div>
              )}

              {/* 실행 완료된 액션 태그 */}
              {msg.executedActions && msg.executedActions.length > 0 && !msg.plan && (
                <div className="flex flex-wrap gap-2">
                  {msg.executedActions.map((action, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 border border-indigo-100 text-indigo-700 rounded-md text-[13px] font-bold tracking-tight shadow-sm">
                      <Blocks size={14} className="text-indigo-500" />
                      {action}
                    </div>
                  ))}
                </div>
              )}

              {/* 에러 */}
              {msg.error && (
                <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-800 px-5 py-4 rounded-xl shadow-sm text-sm overflow-hidden">
                  <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-500" />
                  <div className="font-mono leading-relaxed break-all min-w-0">{msg.error}</div>
                </div>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
export default function AdminConsole() {
  const [showSettings, setShowSettings] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [aiModel, setAiModel] = useState('gemini-3-flash-preview');
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editingModule, setEditingModule] = useState<string | null>(null);

  const fetchFileTree = useCallback(async () => {}, []);

  const {
    messages, input, setInput, loading,
    conversations, activeConvId, chatEndRef,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit, handleConfirmPlan, handleRejectPlan,
  } = useChat(aiModel, fetchFileTree);

  // 초기화
  useEffect(() => {
    const role = document.cookie.split(';').find(c => c.trim().startsWith('firebat_role='))?.split('=')[1];
    setIsDemo(role === 'demo');
    const savedModel = localStorage.getItem('firebat_model') || 'gemini-3-flash-preview';
    setAiModel(savedModel);
  }, []);

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
      />

      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        <div className="absolute top-0 left-0 w-full h-12 bg-gradient-to-b from-slate-50 to-transparent z-10 pointer-events-none" />

        {/* 메시지 목록 */}
        <div className="flex-1 overflow-y-auto px-4 md:px-12 pt-16 scrolltext">
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
            <div className="h-64 shrink-0 pointer-events-none" />
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* 입력창 */}
        <div className="absolute bottom-0 w-full bg-gradient-to-t from-slate-50 via-slate-50 to-transparent pt-8 sm:pt-16 pb-3 sm:pb-8 px-4 md:px-12 pointer-events-none z-10">
          <div className="w-full md:w-[70%] max-w-6xl mx-auto relative pointer-events-auto flex flex-col">
            <div className="flex w-full gap-4">
              <div className="w-11 shrink-0 opacity-0 pointer-events-none hidden md:block" />
              <div className="flex-1 min-w-0 flex flex-col bg-white border border-slate-300 rounded-2xl shadow-xl focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-100/50 transition-all overflow-hidden">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={loading}
                  className="w-full min-h-[90px] max-h-[250px] p-5 bg-transparent outline-none resize-none text-[16px] leading-relaxed text-slate-800 disabled:opacity-50"
                  placeholder={loading ? '명령 집행 중...' : '무엇을 도와드릴까요?'}
                />
                <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50/80">
                  <div className="flex items-center gap-2 text-[12px] text-slate-500 font-medium tracking-tight">
                    <kbd className="font-sans px-1.5 py-0.5 bg-white border border-slate-300 shadow-sm rounded text-slate-600">Shift</kbd>
                    <span>+</span>
                    <kbd className="font-sans px-1.5 py-0.5 bg-white border border-slate-300 shadow-sm rounded text-slate-600">Enter</kbd>
                    <span className="ml-1 opacity-70">줄바꿈</span>
                  </div>
                  <button
                    onClick={() => handleSubmit()}
                    disabled={!input.trim() || loading}
                    className="bg-slate-900 hover:bg-black disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed text-white h-10 w-12 rounded-xl transition-all flex items-center justify-center shadow-md active:scale-[0.98]"
                  >
                    {loading ? <div className="animate-spin text-white"><Cpu size={16} /></div> : <Send size={18} />}
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
            onClose={() => setShowSettings(false)}
            onSave={() => setShowSettings(false)}
            onOpenModuleSettings={(name) => { setShowSettings(false); setEditingModule(name); }}
          />
        )}

        {/* 시스템 모듈 설정 모달 */}
        {editingModule && (
          <SystemModuleSettings
            moduleName={editingModule}
            onClose={() => setEditingModule(null)}
          />
        )}
      </div>
    </div>
  );
}
