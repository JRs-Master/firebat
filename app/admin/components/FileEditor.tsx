'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { X, Save, Loader2, AlertTriangle, Bot, Sparkles, ChevronDown, Check, Copy, Eye } from 'lucide-react';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center bg-[#1e1e1e] text-slate-400 text-sm">
      <Loader2 size={20} className="animate-spin mr-2" /> 에디터 로딩 중...
    </div>
  ),
});

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
  onClose: () => void;
  onSaved?: () => void;
}

export function FileEditor({ filePath, pageSlug, onClose, onSaved }: FileEditorProps) {
  const isPageMode = !!pageSlug;
  const [content, setContent]   = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // PageSpec 전용
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // AI 패널 상태
  const [aiOpen, setAiOpen]             = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiResult, setAiResult]         = useState<string | null>(null);
  const [aiError, setAiError]           = useState<string | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<string>('전체 파일');
  const [copied, setCopied]             = useState(false);

  const editorRef  = useRef<any>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);

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
          const text = isPageMode ? JSON.stringify(data.spec, null, 2) : data.content;
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
    setAiResult(null);
    setAiError(null);
    setAiInstruction('');
    setTimeout(() => aiInputRef.current?.focus(), 50);
  }, [updateSelectionInfo]);

  // AI 요청
  const handleAiSubmit = useCallback(async () => {
    if (!aiInstruction.trim() || aiLoading) return;
    setAiLoading(true);
    setAiResult(null);
    setAiError(null);

    const editor   = editorRef.current;
    const sel      = editor?.getSelection();
    const hasSelection = sel && !sel.isEmpty();
    const selectedCode = hasSelection
      ? editor.getModel()?.getValueInRange(sel)
      : undefined;

    let config: any = { provider: 'gemini', model: 'gemini-3-flash-preview' };
    try {
      const stored = localStorage.getItem('firebat_llm_config');
      if (stored) config = JSON.parse(stored);
    } catch {}

    try {
      const res  = await fetch('/api/ai/code-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: content, language: lang, instruction: aiInstruction, selectedCode, config }),
      });
      const data = await res.json();
      if (data.success) setAiResult(data.suggestion);
      else setAiError(data.error);
    } catch (e: any) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  }, [aiInstruction, aiLoading, content, lang]);

  // 결과 적용
  const applyResult = useCallback(() => {
    if (!aiResult || !editorRef.current) return;
    const editor = editorRef.current;
    const sel    = editor.getSelection();
    const model  = editor.getModel();

    if (sel && !sel.isEmpty()) {
      model.pushEditOperations([], [{ range: sel, text: aiResult }], () => null);
    } else {
      const fullRange = model.getFullModelRange();
      model.pushEditOperations([], [{ range: fullRange, text: aiResult }], () => null);
    }
    setContent(model.getValue());
    setAiOpen(false);
    setAiResult(null);
    setAiInstruction('');
  }, [aiResult]);

  // 결과 복사
  const copyResult = useCallback(() => {
    if (!aiResult) return;
    navigator.clipboard.writeText(aiResult).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [aiResult]);

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
            <button
              onClick={openAiPanel}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-bold transition-colors ${
                aiOpen
                  ? 'bg-violet-600 text-white'
                  : 'bg-[#2d2d2d] text-violet-400 hover:bg-violet-600/20 border border-violet-700/40'
              }`}
              title="AI 어시스트 (Ctrl+K)"
            >
              <Bot size={13} /> AI
            </button>

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
            <div className="w-80 bg-[#252526] overflow-y-auto p-4 space-y-4 flex-shrink-0">
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
        </div>

        {/* AI 패널 */}
        {aiOpen && (
          <div className="border-t border-violet-800/60 bg-[#1a1a2e] flex-shrink-0">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-violet-800/40">
              <Bot size={13} className="text-violet-400" />
              <span className="text-[12px] font-bold text-violet-300">
                AI {isPageMode ? 'PageSpec' : '코드'} 어시스트
              </span>
              <span className="text-[11px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-full ml-1">
                {selectionInfo}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setAiOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-300 rounded transition-colors"
              >
                <ChevronDown size={14} />
              </button>
            </div>

            {!aiResult && (
              <div className="flex items-end gap-2 px-4 py-3">
                <textarea
                  ref={aiInputRef}
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAiSubmit(); }
                  }}
                  placeholder={isPageMode ? 'PageSpec을 어떻게 수정할까요? (Enter로 실행)' : '무엇을 수정할까요? (Enter로 실행, Shift+Enter 줄바꿈)'}
                  rows={2}
                  className="flex-1 bg-[#252540] border border-violet-700/40 rounded-lg px-3 py-2 text-[13px] text-slate-200 placeholder-slate-500 resize-none focus:outline-none focus:border-violet-500 transition-colors font-mono"
                />
                <button
                  onClick={handleAiSubmit}
                  disabled={!aiInstruction.trim() || aiLoading}
                  className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white text-[12px] font-bold rounded-lg transition-colors shrink-0 h-[58px]"
                >
                  {aiLoading
                    ? <><Loader2 size={13} className="animate-spin" /> 생성 중</>
                    : <><Sparkles size={13} /> 생성</>}
                </button>
              </div>
            )}

            {aiError && (
              <div className="mx-4 mb-3 flex items-center gap-1.5 text-red-400 text-[12px] bg-red-950/40 px-3 py-2 rounded-lg border border-red-800/50">
                <AlertTriangle size={13} /> {aiError}
                <button onClick={() => setAiError(null)} className="ml-auto text-slate-500 hover:text-slate-300"><X size={12} /></button>
              </div>
            )}

            {aiResult && (
              <div className="px-4 pb-3 space-y-2">
                <div className="relative bg-[#0d1117] rounded-lg border border-slate-700/60 max-h-40 overflow-y-auto">
                  <pre className="p-3 text-[12px] text-slate-300 font-mono whitespace-pre-wrap break-all">
                    {aiResult.slice(0, 800)}{aiResult.length > 800 ? '\n...' : ''}
                  </pre>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={applyResult}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-[12px] font-bold rounded-lg transition-colors"
                  >
                    <Check size={12} /> 적용
                  </button>
                  <button
                    onClick={copyResult}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[12px] font-bold rounded-lg transition-colors"
                  >
                    {copied ? <><Check size={12} /> 복사됨</> : <><Copy size={12} /> 복사</>}
                  </button>
                  <button
                    onClick={() => { setAiResult(null); setAiInstruction(''); setTimeout(() => aiInputRef.current?.focus(), 50); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 text-[12px] rounded-lg transition-colors"
                  >
                    다시 작성
                  </button>
                  <span className="text-[11px] text-slate-600 ml-auto">
                    {selectionInfo !== '전체 파일' ? '선택 영역을 교체합니다' : '파일 전체를 교체합니다'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 하단 상태바 */}
        <div className="flex items-center gap-4 px-4 py-1.5 bg-[#007acc] text-white text-[11px] font-mono flex-shrink-0">
          <span className="uppercase font-bold tracking-wider">{lang}</span>
          <span className="opacity-70">UTF-8</span>
          <span className="opacity-60">Ctrl+K: AI 어시스트</span>
          {isDirty && <span className="ml-auto opacity-90">● 수정됨</span>}
        </div>
      </div>
    </div>
  );
}
