'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { X, Save, Loader2, AlertTriangle, Bot, Sparkles, Check, Copy, Eye, Send, Trash2, User, RotateCcw, Cpu } from 'lucide-react';
import { AI_MODELS, THINKING_LEVELS } from '../types';
import { readSetting } from '../hooks/settings-manager';
import { tryUnwrapJson } from '../../../core/utils/json-normalize';
import { Tooltip } from './Tooltip';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center bg-[#1e1e1e] text-slate-400 text-sm">
      <Loader2 size={20} className="animate-spin mr-2" /> 에디터 로딩 중...
    </div>
  ),
});

// Monaco Diff Editor — 코드 모드 턴의 before/after 시각화
const DiffEditor = dynamic(() => import('@monaco-editor/react').then(m => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-[#1e1e1e] text-slate-400 text-sm">
      <Loader2 size={20} className="animate-spin mr-2" /> diff 로딩 중...
    </div>
  ),
});

// 슬래시 명령어 — 입력창에서 "/" 로 시작하면 드롭다운 표시, 선택 시 지시문 확장
type SlashCommand = { cmd: string; label: string; instruction: string; mode: 'explain' | 'code' };
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/explain', label: '코드 설명', instruction: '이 코드가 무엇을 하는지 단계별로 설명해줘. 핵심 함수·분기·사이드 이펙트 위주로.', mode: 'explain' },
  { cmd: '/fix',     label: '버그 수정', instruction: '이 코드에서 잠재적 버그·엣지 케이스를 찾아 수정한 전체 코드만 반환해줘.', mode: 'code' },
  { cmd: '/test',    label: '테스트 생성', instruction: '이 코드의 주요 함수에 대한 유닛 테스트를 생성해줘 (해당 언어의 표준 테스트 프레임워크 사용).', mode: 'code' },
  { cmd: '/doc',     label: '주석 추가', instruction: '각 함수·클래스에 간결한 한국어 주석/docstring 을 추가한 전체 코드를 반환해줘.', mode: 'code' },
  { cmd: '/refactor', label: '리팩토링', instruction: '이 코드를 가독성·성능·네이밍 관점에서 리팩토링한 전체 코드만 반환해줘.', mode: 'code' },
  { cmd: '/review',  label: '코드 리뷰', instruction: '이 코드를 전문가 관점에서 리뷰해줘. 개선점·리스크·좋은 점을 bullet 로 정리.', mode: 'explain' },
];

// 빈 상태에서 바로 클릭 가능한 프리셋 프롬프트
const PRESET_PROMPTS: Array<{ label: string; instruction: string }> = [
  { label: '🔍 코드 리뷰',    instruction: '이 코드를 전문가 관점에서 리뷰해줘. 개선점·리스크·좋은 점을 bullet 로 정리.' },
  { label: '🐛 버그 찾기',    instruction: '이 코드에서 잠재적 버그와 엣지 케이스를 찾아서 문제점을 설명해줘.' },
  { label: '⚡ 성능 최적화',  instruction: '이 코드의 성능을 개선할 방법을 제안해줘.' },
  { label: '🏷 타입 명시',    instruction: '모든 변수·함수에 명확한 타입 어노테이션을 추가한 전체 코드를 반환해줘.' },
  { label: '🛡 에러 처리',    instruction: '빠진 에러 처리·try-catch·입력 검증을 추가한 전체 코드를 반환해줘.' },
  { label: '📖 주석 추가',    instruction: '각 함수에 간결한 한국어 docstring/주석을 추가한 전체 코드를 반환해줘.' },
];

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    tsx: 'typescript', ts: 'typescript',
    jsx: 'javascript', js: 'javascript', mjs: 'javascript',
    py: 'python', php: 'php', rs: 'rust', sh: 'shell',
    css: 'css', json: 'json', md: 'markdown', html: 'html',
    toml: 'ini', yaml: 'yaml', yml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

interface FileEditorProps {
  /** 파일 경로 (파일 모드) */
  filePath?: string;
  /** 페이지 slug (PageSpec 모드) */
  pageSlug?: string;
  /** 어드민 채팅과 동일한 User AI 모델 (미지정 시 서버 기본값) */
  aiModel?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function FileEditor({ filePath, pageSlug, aiModel, onClose, onSaved }: FileEditorProps) {
  const isPageMode = !!pageSlug;
  const [content, setContent]   = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // PageSpec 전용
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // AI 사이드바 상태 — VSCode Copilot Chat 스타일 우측 사이드바
  const [aiOpen, setAiOpen]             = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiError, setAiError]           = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<string>('전체 파일');
  const [copiedIdx, setCopiedIdx]       = useState<number | null>(null);

  // 대화 히스토리 (localStorage 영속, 파일·페이지별 분리)
  type ChatTurn = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    mode?: 'explain' | 'code';
    /** 이 턴이 assistant 고 코드 모드일 때 에디터 적용 가능 여부 */
    applied?: boolean;
  };
  const chatStorageKey = isPageMode ? `firebat_editor_chat_page_${pageSlug}` : `firebat_editor_chat_file_${filePath}`;
  const [chat, setChat] = useState<ChatTurn[]>([]);

  // 대화 복원 — 파일 로드 시 해당 파일의 대화 기록 가져옴
  useEffect(() => {
    try {
      const raw = localStorage.getItem(chatStorageKey);
      if (raw) setChat(JSON.parse(raw));
      else setChat([]);
    } catch { setChat([]); }
  }, [chatStorageKey]);

  // 대화 저장 — 변경 시마다 debounced 없이 즉시 (파일당 최대 수십 턴이라 부담 없음)
  useEffect(() => {
    try {
      if (chat.length > 0) localStorage.setItem(chatStorageKey, JSON.stringify(chat));
    } catch {}
  }, [chat, chatStorageKey]);

  const clearChat = useCallback(() => {
    setChat([]);
    try { localStorage.removeItem(chatStorageKey); } catch {}
  }, [chatStorageKey]);

  // 세션 로컬 override — null 이면 어드민 기본값(aiModel prop) 사용
  const [localModel, setLocalModel]       = useState<string | null>(null);
  const [localThinking, setLocalThinking] = useState<string | null>(null);
  const [slashOpen, setSlashOpen]         = useState<'root' | 'model' | 'thinking' | null>(null);

  // Diff 프리뷰 모달 — 코드 모드 턴의 before/after 시각화
  const [diffTurnId, setDiffTurnId] = useState<string | null>(null);

  const editorRef   = useRef<any>(null);
  const aiInputRef  = useRef<HTMLTextAreaElement>(null);
  const chatEndRef  = useRef<HTMLDivElement>(null);

  // 새 턴 추가 시 스크롤 하단 고정
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.length, aiLoading]);

  const isDirty  = content !== original;
  const lang     = isPageMode ? 'json' : detectLanguage(filePath!);
  const fileName = isPageMode ? pageSlug! : (filePath!.split('/').pop() ?? filePath!);

  // 파일/페이지 로드
  useEffect(() => {
    setLoading(true);
    setError(null);

    const url = isPageMode
      ? `/api/pages/${encodeURIComponent(pageSlug!)}`
      : `/api/fs/file?path=${encodeURIComponent(filePath!)}`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          let text: string;
          if (isPageMode) {
            // PageSpec 손상 자동 복구 — tryUnwrapJson 이 깊이 3까지 재파싱 시도.
            // 완전 손상이면 raw 문자열 display + 경고 (블랭크 방지, AI 로 고칠 수 있게).
            const spec = tryUnwrapJson<Record<string, unknown>>(data.spec);
            if (spec) {
              text = JSON.stringify(spec, null, 2);
            } else {
              text = typeof data.spec === 'string' ? data.spec : JSON.stringify(data.spec, null, 2);
              setError('PageSpec JSON 손상 — 수동 편집 또는 AI 로 복구하세요');
            }
          } else {
            text = data.content;
          }
          setContent(text);
          setOriginal(text);
        } else {
          setError(data.error || '불러올 수 없습니다.');
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filePath, pageSlug, isPageMode]);

  // JSON 유효성 실시간 검증 (PageSpec 모드)
  useEffect(() => {
    if (!isPageMode) { setJsonError(null); return; }
    try {
      JSON.parse(content);
      setJsonError(null);
    } catch (e: any) {
      setJsonError(e.message);
    }
  }, [content, isPageMode]);

  // 저장
  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    if (isPageMode && jsonError) return;

    setSaving(true);
    setError(null);
    try {
      if (isPageMode) {
        const parsed = JSON.parse(content);
        const res = await fetch('/api/pages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: pageSlug, spec: parsed }),
        });
        const data = await res.json();
        if (data.success) { setOriginal(content); onSaved?.(); }
        else setError(data.error || '저장 실패');
      } else {
        const res = await fetch('/api/fs/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content }),
        });
        const data = await res.json();
        if (data.success) { setOriginal(content); onSaved?.(); }
        else setError(data.error);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [filePath, pageSlug, content, isDirty, saving, isPageMode, jsonError, onSaved]);

  // 선택 영역 정보 갱신
  const updateSelectionInfo = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) {
      const start = sel.startLineNumber;
      const end   = sel.endLineNumber;
      setSelectionInfo(start === end ? `${start}줄 선택` : `${start}–${end}줄 선택`);
    } else {
      setSelectionInfo('전체 파일');
    }
  }, []);

  // AI 패널 열기
  const openAiPanel = useCallback(() => {
    updateSelectionInfo();
    setAiOpen(true);
    setAiError(null);
    setTimeout(() => aiInputRef.current?.focus(), 50);
  }, [updateSelectionInfo]);

  // AI 요청 — 대화 히스토리에 turn 누적. override 지정 시 입력창 값 대신 사용 (프리셋/슬래시용)
  const handleAiSubmit = useCallback(async (override?: string) => {
    const raw = (override ?? aiInstruction).trim();
    if (!raw || aiLoading) return;
    // 지시문 기반 모드 추정 — 백엔드 codeAssist 와 동일 키워드 목록
    const explainKeywords = ['알려줘', '알려달', '설명', '분석', '검토', '리뷰', '뭐가 문제', '왜', '어떻게', '파악', '평가', 'explain', 'review', 'analyze', 'analyse', 'describe'];
    const lowered = raw.toLowerCase();
    const mode: 'explain' | 'code' = explainKeywords.some(k => raw.includes(k) || lowered.includes(k.toLowerCase())) ? 'explain' : 'code';

    const turnId = Date.now().toString();
    const userTurn: ChatTurn = { id: `u-${turnId}`, role: 'user', content: raw };
    setChat(prev => [...prev, userTurn]);
    const sentInstruction = raw;
    setAiInstruction('');
    setAiLoading(true);
    setAiError(null);

    const editor   = editorRef.current;
    const sel      = editor?.getSelection();
    const hasSelection = sel && !sel.isEmpty();
    const selectedCode = hasSelection
      ? editor.getModel()?.getValueInRange(sel)
      : undefined;

    // 모델 우선순위: 로컬 override → prop(어드민 채팅과 통일) → SettingsManager 폴백 → 서버 기본
    let model: string | undefined = localModel ?? aiModel;
    if (!model) {
      const stored = readSetting('firebat_model');
      if (stored) model = stored;
    }
    const config: { model?: string; thinkingLevel?: string } = {};
    if (model) config.model = model;
    if (localThinking) config.thinkingLevel = localThinking;

    try {
      const res  = await fetch('/api/ai/code-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: content, language: lang, instruction: sentInstruction, selectedCode, config }),
      });
      const data = await res.json();
      if (data.success) {
        const assistantTurn: ChatTurn = {
          id: `a-${turnId}`,
          role: 'assistant',
          content: data.suggestion,
          mode,
          applied: false,
        };
        setChat(prev => [...prev, assistantTurn]);
      } else {
        setAiError(data.error || '응답 실패');
      }
    } catch (e: any) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  }, [aiInstruction, aiLoading, content, lang, aiModel, localModel, localThinking]);

  // 특정 턴의 코드 제안을 에디터에 적용
  const applyTurn = useCallback((turnId: string) => {
    const turn = chat.find(t => t.id === turnId);
    if (!turn || turn.mode !== 'code' || !editorRef.current) return;
    const editor = editorRef.current;
    const model  = editor.getModel();
    const fullRange = model.getFullModelRange();
    model.pushEditOperations([], [{ range: fullRange, text: turn.content }], () => null);
    setContent(model.getValue());
    setChat(prev => prev.map(t => t.id === turnId ? { ...t, applied: true } : t));
  }, [chat]);

  // 특정 턴 복사
  const copyTurn = useCallback((turnId: string, idx: number) => {
    const turn = chat.find(t => t.id === turnId);
    if (!turn) return;
    navigator.clipboard.writeText(turn.content).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  }, [chat]);

  // 키보드 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openAiPanel(); }
      if (e.key === 'Escape') {
        if (aiOpen) { setAiOpen(false); return; }
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, openAiPanel, aiOpen, onClose]);

  // 닫기 전 확인
  const handleClose = () => {
    if (isDirty && !confirm('저장하지 않은 변경사항이 있습니다. 닫으시겠습니까?')) return;
    onClose();
  };

  // PageSpec 프리뷰 데이터
  const previewData = isPageMode ? (() => {
    try {
      const spec = JSON.parse(content);
      return {
        slug: spec.slug ?? pageSlug,
        title: spec.head?.title ?? pageSlug,
        description: spec.head?.description ?? '',
        project: spec.project ?? '없음',
        componentCount: spec.body?.length ?? 0,
        components: (spec.body ?? []).map((a: any, i: number) => `${i + 1}. ${a.type} ${a.props?.text || a.props?.content || a.props?.bindModule || ''}`),
      };
    } catch {
      return null;
    }
  })() : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-5xl h-[85vh] bg-[#1e1e1e] rounded-2xl shadow-2xl border border-slate-700 flex flex-col overflow-hidden">

        {/* 헤더 */}
        <div className="flex items-center gap-3 px-4 py-3 bg-[#252526] border-b border-slate-700 flex-shrink-0">
          {isPageMode ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] font-extrabold tracking-widest text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">
                PageSpec
              </span>
              <span className="text-[13px] font-semibold text-slate-200 truncate">{pageSlug}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-3 py-1.5 rounded-md border border-slate-600">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isDirty ? 'bg-amber-400' : 'bg-green-500'}`} />
              <span className="text-slate-200 text-[13px] font-mono">{fileName}</span>
            </div>
          )}

          {!isPageMode && (
            <span className="text-slate-500 text-[11px] font-mono truncate flex-1">{filePath}</span>
          )}
          {isPageMode && <div className="flex-1" />}

          {isDirty && !isPageMode && (
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
          )}

          {error && (
            <div className="flex items-center gap-1.5 text-red-400 text-[12px] bg-red-950/50 px-3 py-1.5 rounded-md border border-red-800">
              <AlertTriangle size={13} /> {error}
            </div>
          )}

          {/* JSON 오류 (PageSpec) */}
          {isPageMode && jsonError && (
            <span className="flex items-center gap-1 text-xs text-red-400 shrink-0">
              <AlertTriangle size={12} /> JSON 오류
            </span>
          )}

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* AI 버튼 */}
            <Tooltip label="AI 어시스트 (Ctrl+K)">
              <button
                onClick={openAiPanel}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-bold transition-colors ${
                  aiOpen
                    ? 'bg-violet-600 text-white'
                    : 'bg-[#2d2d2d] text-violet-400 hover:bg-violet-600/20 border border-violet-700/40'
                }`}
              >
                <Bot size={13} /> AI
              </button>
            </Tooltip>

            {/* PageSpec 미리보기 */}
            {isPageMode && (
              <button
                onClick={() => setPreviewOpen(!previewOpen)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  previewOpen ? 'bg-blue-600 text-white' : 'bg-[#2d2d2d] text-slate-300 hover:bg-slate-600 border border-slate-600'
                }`}
              >
                <Eye size={13} /> 미리보기
              </button>
            )}

            <span className="text-[11px] text-slate-500 font-mono">Ctrl+S</span>
            <button
              onClick={handleSave}
              disabled={!isDirty || saving || loading || (isPageMode && !!jsonError)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 text-white text-[13px] font-bold rounded-lg transition-colors"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              저장
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 본문 */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* 에디터 */}
          <div className={`flex-1 overflow-hidden ${isPageMode && previewOpen ? 'border-r border-slate-700/50' : ''}`}>
            {loading ? (
              <div className="flex-1 flex items-center justify-center h-full bg-[#1e1e1e] text-slate-400">
                <Loader2 size={20} className="animate-spin mr-2" /> 로딩 중...
              </div>
            ) : (
              <MonacoEditor
                height="100%"
                language={lang}
                theme="vs-dark"
                value={content}
                onChange={(v) => setContent(v ?? '')}
                onMount={(editor) => { editorRef.current = editor; }}
                options={{
                  fontSize: 14,
                  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  renderLineHighlight: 'all',
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  padding: { top: 16, bottom: 16 },
                  tabSize: 2,
                  ...(isPageMode ? {
                    formatOnPaste: true,
                    automaticLayout: true,
                    folding: true,
                    bracketPairColorization: { enabled: true },
                  } : {}),
                }}
              />
            )}
          </div>

          {/* PageSpec 미리보기 패널 */}
          {isPageMode && previewOpen && previewData && (
            <div className="w-72 bg-[#252526] overflow-y-auto p-4 space-y-4 flex-shrink-0 border-r border-slate-700/50">
              <h3 className="text-xs font-extrabold tracking-widest text-slate-400">구조 미리보기</h3>

              <div className="space-y-2">
                {[
                  ['SLUG', previewData.slug],
                  ['TITLE', previewData.title],
                  ['PROJECT', previewData.project],
                  ['DESC', previewData.description || '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-slate-500 w-16 shrink-0">{label}</span>
                    <span className="text-sm text-slate-200 truncate">{value}</span>
                  </div>
                ))}
              </div>

              <div className="border-t border-slate-700/50 pt-3">
                <div className="text-[10px] font-bold text-slate-500 mb-2">
                  BODY ({previewData.componentCount}개 Component)
                </div>
                <div className="space-y-1">
                  {previewData.components.map((comp: string, i: number) => (
                    <div key={i} className="text-xs text-slate-300 bg-slate-800/50 px-2.5 py-1.5 rounded font-mono truncate">
                      {comp}
                    </div>
                  ))}
                  {previewData.componentCount === 0 && (
                    <div className="text-xs text-slate-500 italic">body가 비어있습니다</div>
                  )}
                </div>
              </div>

              {jsonError && (
                <div className="border-t border-red-700/30 pt-3">
                  <div className="text-[10px] font-bold text-red-400 mb-1">JSON 오류 상세</div>
                  <div className="text-xs text-red-300 bg-red-900/20 p-2 rounded font-mono break-all">
                    {jsonError}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AI 사이드바 (우측) — VSCode Copilot Chat 스타일 */}
          {aiOpen && (
            <aside className="w-[380px] flex-shrink-0 bg-[#1a1a2e] border-l border-violet-800/60 flex flex-col min-h-0">
              {/* 사이드바 헤더 */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-violet-800/40 flex-shrink-0">
                <Bot size={14} className="text-violet-400" />
                <span className="text-[12px] font-bold text-violet-300">AI 어시스트</span>
                <span className="text-[10px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-full">{selectionInfo}</span>
                <div className="flex-1" />
                {chat.length > 0 && (
                  <Tooltip label="대화 삭제">
                    <button
                      onClick={clearChat}
                      className="p-1 text-slate-500 hover:text-red-400 rounded transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                )}
                <Tooltip label="사이드바 닫기">
                  <button
                    onClick={() => setAiOpen(false)}
                    className="p-1 text-slate-500 hover:text-slate-300 rounded transition-colors"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              </div>

              {/* 모델·thinking override 배지 (기본값과 다를 때만) */}
              {(localModel || localThinking) && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-900/30 border-b border-amber-700/40 text-[11px]">
                  <Cpu size={11} className="text-amber-400" />
                  <span className="text-amber-300">
                    {localModel && <><b>{AI_MODELS.find(m => m.value === localModel)?.label || localModel}</b></>}
                    {localModel && localThinking && ' · '}
                    {localThinking && <>thinking: <b>{localThinking}</b></>}
                  </span>
                  <Tooltip label="어드민 설정으로 복원">
                    <button
                      onClick={() => { setLocalModel(null); setLocalThinking(null); }}
                      className="ml-auto flex items-center gap-1 text-amber-400 hover:text-amber-200"
                    >
                      <RotateCcw size={10} /> 기본값
                    </button>
                  </Tooltip>
                </div>
              )}

              {/* 대화 히스토리 */}
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
                {chat.length === 0 && !aiLoading && (
                  <div className="space-y-3 py-2">
                    <div className="text-center text-slate-500 text-[12px]">
                      <Sparkles size={18} className="mx-auto mb-1.5 text-violet-500/50" />
                      빠르게 시작하기
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {PRESET_PROMPTS.map(preset => (
                        <button
                          key={preset.label}
                          onClick={() => handleAiSubmit(preset.instruction)}
                          className="text-left bg-slate-800/40 hover:bg-violet-600/20 border border-slate-700/60 hover:border-violet-600/50 rounded-lg px-2.5 py-2 text-[11.5px] text-slate-300 hover:text-violet-200 transition-colors"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <div className="text-center text-[10.5px] text-slate-600 pt-2 border-t border-slate-800/60">
                      <code className="text-violet-400/70">/</code> 로 슬래시 명령어 · <code className="text-violet-400/70">/model</code> · <code className="text-violet-400/70">/thinking</code>
                    </div>
                  </div>
                )}
                {chat.map((turn, idx) => (
                  <div key={turn.id} className={turn.role === 'user' ? 'flex justify-end' : 'flex gap-2'}>
                    {turn.role === 'assistant' && (
                      <div className="w-6 h-6 rounded-full bg-violet-600/30 text-violet-300 flex items-center justify-center shrink-0 mt-0.5">
                        <Bot size={13} />
                      </div>
                    )}
                    <div className={`max-w-[85%] ${turn.role === 'user' ? '' : 'flex-1 min-w-0'}`}>
                      {turn.role === 'user' ? (
                        <div className="bg-violet-600/30 border border-violet-600/40 rounded-lg px-3 py-2 text-[12.5px] text-slate-100 whitespace-pre-wrap break-words">
                          {turn.content}
                        </div>
                      ) : (
                        <>
                          <div className={`rounded-lg border border-slate-700/60 ${turn.mode === 'explain' ? 'bg-slate-800/40' : 'bg-[#0d1117]'}`}>
                            <pre className={`p-2.5 text-[12px] text-slate-200 whitespace-pre-wrap break-words leading-relaxed max-h-80 overflow-y-auto ${turn.mode === 'explain' ? '' : 'font-mono'}`}>
                              {turn.content}
                            </pre>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            {turn.mode === 'code' && (
                              <Tooltip label="적용 전 변경점 미리보기">
                                <button
                                  onClick={() => setDiffTurnId(turn.id)}
                                  className="flex items-center gap-1 px-2 py-1 bg-blue-600/80 hover:bg-blue-600 text-white text-[11px] font-bold rounded transition-colors"
                                >
                                  <Eye size={11} /> Diff
                                </button>
                              </Tooltip>
                            )}
                            {turn.mode === 'code' && !turn.applied && (
                              <button
                                onClick={() => applyTurn(turn.id)}
                                className="flex items-center gap-1 px-2 py-1 bg-green-600 hover:bg-green-700 text-white text-[11px] font-bold rounded transition-colors"
                              >
                                <Check size={11} /> 적용
                              </button>
                            )}
                            {turn.mode === 'code' && turn.applied && (
                              <span className="flex items-center gap-1 px-2 py-1 bg-green-900/30 text-green-400 text-[11px] font-bold rounded">
                                <Check size={11} /> 적용됨
                              </span>
                            )}
                            <Tooltip label="복사">
                              <button
                                onClick={() => copyTurn(turn.id, idx)}
                                className="flex items-center gap-1 px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[11px] rounded transition-colors"
                              >
                                {copiedIdx === idx ? <Check size={11} /> : <Copy size={11} />}
                              </button>
                            </Tooltip>
                            <span className="text-[10px] text-slate-600 ml-auto">
                              {turn.mode === 'explain' ? '리뷰' : '코드 제안'}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    {turn.role === 'user' && (
                      <div className="w-6 h-6 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center shrink-0 mt-0.5 ml-2">
                        <User size={12} />
                      </div>
                    )}
                  </div>
                ))}
                {aiLoading && (
                  <div className="flex gap-2">
                    <div className="w-6 h-6 rounded-full bg-violet-600/30 text-violet-300 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot size={13} />
                    </div>
                    <div className="flex-1 bg-slate-800/40 border border-slate-700/60 rounded-lg px-3 py-2 text-[12px] text-slate-400 flex items-center gap-2">
                      <Loader2 size={12} className="animate-spin" /> 생성 중...
                    </div>
                  </div>
                )}
                {aiError && (
                  <div className="flex items-center gap-1.5 text-red-400 text-[12px] bg-red-950/40 px-3 py-2 rounded-lg border border-red-800/50">
                    <AlertTriangle size={13} /> {aiError}
                    <button onClick={() => setAiError(null)} className="ml-auto text-slate-500 hover:text-slate-300"><X size={12} /></button>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* 슬래시 명령어 드롭다운 */}
              {slashOpen && (
                <div className="mx-2 mb-1 bg-[#252540] border border-violet-700/40 rounded-lg overflow-hidden shadow-xl">
                  {slashOpen === 'root' && (
                    <>
                      {SLASH_COMMANDS.filter(c => c.cmd.startsWith(aiInstruction) || aiInstruction === '/').map(c => (
                        <button
                          key={c.cmd}
                          onClick={() => { setAiInstruction(''); setSlashOpen(null); handleAiSubmit(c.instruction); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-violet-600/30 transition-colors"
                        >
                          <code className="text-violet-400 font-bold">{c.cmd}</code>
                          <span className="text-slate-300">{c.label}</span>
                          <span className="ml-auto text-[10px] text-slate-500">{c.mode === 'explain' ? '리뷰' : '코드'}</span>
                        </button>
                      ))}
                      <div className="border-t border-slate-700/60" />
                      <button
                        onClick={() => { setAiInstruction(''); setSlashOpen('model'); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-violet-600/30 transition-colors"
                      >
                        <code className="text-violet-400 font-bold">/model</code>
                        <span className="text-slate-300">모델 변경</span>
                      </button>
                      <button
                        onClick={() => { setAiInstruction(''); setSlashOpen('thinking'); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-violet-600/30 transition-colors"
                      >
                        <code className="text-violet-400 font-bold">/thinking</code>
                        <span className="text-slate-300">추론 강도 변경</span>
                      </button>
                      <button
                        onClick={() => { setLocalModel(null); setLocalThinking(null); setAiInstruction(''); setSlashOpen(null); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-amber-600/30 transition-colors border-t border-slate-700/60"
                      >
                        <code className="text-amber-400 font-bold">/reset</code>
                        <span className="text-slate-300">기본값(어드민 설정)으로 복원</span>
                      </button>
                    </>
                  )}
                  {slashOpen === 'model' && (
                    <div className="max-h-64 overflow-y-auto">
                      <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-700/60 sticky top-0 bg-[#252540]">모델 선택</div>
                      {AI_MODELS.map(m => (
                        <button
                          key={m.value}
                          onClick={() => { setLocalModel(m.value); setAiInstruction(''); setSlashOpen(null); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] hover:bg-violet-600/30 transition-colors"
                        >
                          {(localModel ?? aiModel) === m.value && <Check size={11} className="text-violet-400" />}
                          <span className="text-slate-200">{m.label}</span>
                          <code className="ml-auto text-[10px] text-slate-500">{m.value}</code>
                        </button>
                      ))}
                    </div>
                  )}
                  {slashOpen === 'thinking' && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-700/60">추론 강도</div>
                      {THINKING_LEVELS.map(l => (
                        <button
                          key={l.value}
                          onClick={() => { setLocalThinking(l.value); setAiInstruction(''); setSlashOpen(null); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] hover:bg-violet-600/30 transition-colors"
                        >
                          {localThinking === l.value && <Check size={11} className="text-violet-400" />}
                          <span className="text-slate-200">{l.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 입력창 (사이드바 하단) */}
              <div className="border-t border-violet-800/40 p-2 flex-shrink-0">
                <div className="flex items-end gap-2">
                  <textarea
                    ref={aiInputRef}
                    value={aiInstruction}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAiInstruction(v);
                      // "/" 만 입력됐거나 /로 시작하면 슬래시 메뉴 오픈
                      if (v === '/' || (v.startsWith('/') && !v.includes(' '))) {
                        setSlashOpen('root');
                      } else {
                        setSlashOpen(null);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && slashOpen) { e.preventDefault(); setSlashOpen(null); return; }
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setSlashOpen(null); handleAiSubmit(); }
                    }}
                    placeholder={isPageMode ? '"헤더 색 바꿔줘" 또는 "/" 로 명령어' : '수정할 내용 또는 "/" 로 명령어 (Enter 전송)'}
                    rows={2}
                    disabled={aiLoading}
                    className="flex-1 bg-[#252540] border border-violet-700/40 rounded-lg px-2.5 py-2 text-[12.5px] text-slate-200 placeholder-slate-500 resize-none focus:outline-none focus:border-violet-500 transition-colors disabled:opacity-50"
                  />
                  <Tooltip label="전송 (Enter)">
                    <button
                      onClick={() => handleAiSubmit()}
                      disabled={!aiInstruction.trim() || aiLoading}
                      className="flex items-center justify-center w-10 h-10 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors shrink-0"
                    >
                      {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    </button>
                  </Tooltip>
                </div>
              </div>
            </aside>
          )}
        </div>

        {/* 하단 상태바 */}
        <div className="flex items-center gap-4 px-4 py-1.5 bg-[#007acc] text-white text-[11px] font-mono flex-shrink-0">
          <span className="uppercase font-bold tracking-wider">{lang}</span>
          <span className="opacity-70">UTF-8</span>
          <span className="opacity-60">Ctrl+K: AI 어시스트</span>
          {isDirty && <span className="ml-auto opacity-90">● 수정됨</span>}
        </div>

        {/* Monaco Diff 모달 — 코드 모드 턴의 before/after 시각화 */}
        {diffTurnId && (() => {
          const turn = chat.find(t => t.id === diffTurnId);
          if (!turn) return null;
          return (
            <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={() => setDiffTurnId(null)}>
              <div className="bg-[#1e1e1e] rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 bg-[#252526]">
                  <Eye size={14} className="text-blue-400" />
                  <span className="text-[13px] font-bold text-slate-200">변경점 미리보기</span>
                  <span className="text-[11px] text-slate-500">
                    <span className="text-red-400">← 원본</span> · <span className="text-green-400">AI 제안 →</span>
                  </span>
                  <div className="flex-1" />
                  {!turn.applied && (
                    <button
                      onClick={() => { applyTurn(turn.id); setDiffTurnId(null); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-[12px] font-bold rounded-lg transition-colors"
                    >
                      <Check size={12} /> 적용하고 닫기
                    </button>
                  )}
                  <button
                    onClick={() => setDiffTurnId(null)}
                    className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <DiffEditor
                    height="100%"
                    language={lang}
                    theme="vs-dark"
                    original={content}
                    modified={turn.content}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
