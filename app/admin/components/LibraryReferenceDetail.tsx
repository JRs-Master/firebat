'use client';

import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { ArrowLeft, Trash2, FileText, Globe, FileType, Loader2, Plus, Upload, Type, X } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { useTranslations } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { apiPost } from '../../../lib/api-fetch';
import type { LibraryReferencePb, LibrarySourcePb } from '../../../lib/proto-gen/firebat_pb';
import { LibrarySourceModal } from './LibrarySourceModal';
import type { LibraryHubContext } from './LibraryPanel';

type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

type UploadMode = 'file' | 'text';

const SUPPORTED_EXT: Record<string, string> = { pdf: 'pdf', txt: 'txt', md: 'md' };

function extOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * LibraryReferenceDetail — 매 Reference 안 Source list / 업로드 / 삭제 UI.
 *
 * 업로드 모드 2종:
 *  - 파일 (pdf / txt / md) — multipart → upload-and-extract endpoint → 서버 temp → UploadSource RPC
 *  - 직접 입력 (textarea) — source_type='text' + inline_text → uploadSource RPC 직접 호출
 *
 * hub mode (hubContext 박힌 경우) — admin /api/library/* 대신 익명 /api/hub/<slug>/library/* 호출.
 */
export function LibraryReferenceDetail({
  reference,
  hubContext,
  onBack,
}: {
  reference: LibraryReferencePb;
  hubContext?: LibraryHubContext;
  onBack: () => void;
}) {
  const t = useTranslations();
  const [sources, setSources] = useState<LibrarySourcePb[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [mode, setMode] = useState<UploadMode>('file');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [textName, setTextName] = useState('');
  const [textBody, setTextBody] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileBtnId = useId();
  const textNameId = useId();
  const textBodyId = useId();

  // hub / admin 분기 헬퍼 — admin 은 /api/library/{op}, hub 는 /api/hub/<slug>/library + body.op.
  const libraryFetch = useCallback(async <T,>(op: string, payload: Record<string, unknown>): Promise<LibraryApiResponse<T>> => {
    if (hubContext) {
      const res = await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/library`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Token': hubContext.apiToken,
          'X-Session-Id': hubContext.sessionId,
        },
        body: JSON.stringify({ op, ...payload }),
      });
      return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
    }
    return apiPost<LibraryApiResponse<T>>(`/api/library/${op}`, payload, { category: 'library' });
  }, [hubContext]);

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const res = await libraryFetch<LibrarySourcePb[]>(
        'list-sources',
        { referenceId: reference.id },
      );
      if (res.success && res.data) setSources(res.data);
    } catch (e) {
      logger.debug('library', 'list_sources 실패', { error: e });
    } finally {
      setLoading(false);
    }
  }, [reference.id, libraryFetch]);

  useEffect(() => { loadSources(); }, [loadSources]);

  const resetForm = useCallback(() => {
    setPickedFile(null);
    setTextName('');
    setTextBody('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleDelete = useCallback(async (src: LibrarySourcePb) => {
    const ok = await confirmDialog({
      title: 'Source 삭제',
      message: `"${src.name}" 을 삭제하시겠습니까?`,
      okLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await libraryFetch<void>('delete-source', { id: src.id });
      if (res.success) await loadSources();
    } catch (e) {
      logger.debug('library', 'delete_source 실패', { error: e });
    }
  }, [loadSources, libraryFetch]);

  const handleFilePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (!f) { setPickedFile(null); return; }
    const ext = extOf(f.name);
    if (!SUPPORTED_EXT[ext]) {
      alertDialog({ title: '지원되지 않는 형식', message: `PDF / TXT / MD 파일만 지원됩니다. (현재: ${ext || '확장자 없음'})` });
      if (fileInputRef.current) fileInputRef.current.value = '';
      setPickedFile(null);
      return;
    }
    setPickedFile(f);
  }, []);

  const submitFile = useCallback(async () => {
    if (!pickedFile) return;
    const ext = extOf(pickedFile.name);
    const sourceType = SUPPORTED_EXT[ext];
    if (!sourceType) return;

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', pickedFile);
      fd.append('referenceId', reference.id);
      fd.append('name', pickedFile.name);
      fd.append('sourceType', sourceType);
      const url = hubContext
        ? `/api/hub/${encodeURIComponent(hubContext.slug)}/library/upload`
        : '/api/library/upload-and-extract';
      const headers: Record<string, string> = {};
      if (hubContext) {
        headers['X-Api-Token'] = hubContext.apiToken;
        headers['X-Session-Id'] = hubContext.sessionId;
      }
      const res = await fetch(url, { method: 'POST', headers, body: fd });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        await alertDialog({ title: '업로드 실패', message: json?.error ?? `HTTP ${res.status}` });
        return;
      }
      resetForm();
      setUploadOpen(false);
      await loadSources();
    } catch (e) {
      logger.debug('library', 'upload_file 실패', { error: e });
      await alertDialog({ title: '업로드 실패', message: String(e) });
    } finally {
      setBusy(false);
    }
  }, [pickedFile, reference.id, resetForm, loadSources, hubContext]);

  const submitText = useCallback(async () => {
    if (!textName.trim() || !textBody.trim()) return;
    setBusy(true);
    try {
      const res = await libraryFetch<{ sourceId: string; chunkCount: number }>(
        'upload-text-source',
        {
          referenceId: reference.id,
          name: textName.trim(),
          inlineText: textBody,
        },
      );
      if (!res.success) {
        await alertDialog({ title: '저장 실패', message: res.error ?? 'UploadSource 실패' });
        return;
      }
      resetForm();
      setUploadOpen(false);
      await loadSources();
    } catch (e) {
      logger.debug('library', 'upload_text 실패', { error: e });
      await alertDialog({ title: '저장 실패', message: String(e) });
    } finally {
      setBusy(false);
    }
  }, [textName, textBody, reference.id, resetForm, loadSources, libraryFetch]);

  const typeIcon = (type: string) => {
    if (type === 'pdf' || type === 'txt' || type === 'md') return <FileText size={13} className="text-slate-500" />;
    if (type === 'url') return <Globe size={13} className="text-blue-500" />;
    return <FileType size={13} className="text-slate-500" />;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 헤더 — back + Reference 이름 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60 shrink-0">
        <button
          onClick={onBack}
          className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-bold text-slate-700 truncate">{reference.name}</div>
          {reference.description && (
            <div className="text-[10px] text-slate-400 truncate">{reference.description}</div>
          )}
        </div>
        <span className="text-[11px] font-medium text-slate-400">{sources.length} 개</span>
      </div>

      {/* Source 업로드 토글 + form */}
      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/40 shrink-0">
        {!uploadOpen ? (
          <button
            onClick={() => setUploadOpen(true)}
            className="flex items-center justify-center gap-1 w-full px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
          >
            <Plus size={13} /> Source 업로드
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {/* mode 탭 — 파일 / 직접 입력 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 text-[11px] font-bold">
                <button
                  onClick={() => setMode('file')}
                  className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                    mode === 'file' ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  <Upload size={11} /> 파일
                </button>
                <button
                  onClick={() => setMode('text')}
                  className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                    mode === 'text' ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  <Type size={11} /> 직접 입력
                </button>
              </div>
              <button
                onClick={() => { setUploadOpen(false); resetForm(); }}
                className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X size={13} />
              </button>
            </div>

            {mode === 'file' ? (
              <div className="flex flex-col gap-2">
                <input
                  ref={fileInputRef}
                  id={fileBtnId}
                  type="file"
                  accept=".pdf,.txt,.md"
                  onChange={handleFilePick}
                  className="text-[11px] text-slate-600 file:mr-2 file:px-2 file:py-1 file:text-[11px] file:font-bold file:border-0 file:bg-slate-200 file:text-slate-700 file:rounded hover:file:bg-slate-300"
                  name="libraryFile"
                />
                {pickedFile && (
                  <p className="text-[11px] text-slate-500">
                    선택됨: <span className="font-semibold">{pickedFile.name}</span> ({(pickedFile.size / 1024).toFixed(1)} KB)
                  </p>
                )}
                <p className="text-[10px] text-slate-400">PDF / TXT / MD 파일을 지원합니다.</p>
                <button
                  onClick={submitFile}
                  disabled={!pickedFile || busy}
                  className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300 flex items-center justify-center gap-1"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  {busy ? '업로드 중...' : '업로드 + 임베딩'}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={textNameId} className="text-[11px] font-bold text-slate-600">제목</label>
                  <input
                    id={textNameId}
                    type="text"
                    value={textName}
                    onChange={e => setTextName(e.target.value)}
                    placeholder="자료 제목"
                    className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    name="textName"
                    autoComplete="off"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={textBodyId} className="text-[11px] font-bold text-slate-600">내용</label>
                  <textarea
                    id={textBodyId}
                    value={textBody}
                    onChange={e => setTextBody(e.target.value)}
                    placeholder="자료 본문을 붙여넣어 주세요."
                    rows={6}
                    className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                    name="textBody"
                  />
                </div>
                <button
                  onClick={submitText}
                  disabled={!textName.trim() || !textBody.trim() || busy}
                  className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300 flex items-center justify-center gap-1"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  {busy ? '저장 중...' : '저장 + 임베딩'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Source 목록 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-slate-400" />
          </div>
        ) : sources.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic text-center py-8 px-3">
            Source 가 없습니다.<br />
            위 업로드 버튼으로 자료를 추가해 주세요.
          </p>
        ) : (
          <div className="flex flex-col">
            {sources.map(src => (
              <div
                key={src.id}
                onClick={() => setPreviewId(src.id)}
                className="group flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
              >
                {typeIcon(src.sourceType)}
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-semibold text-slate-700 truncate">
                    {src.name}
                  </div>
                  <div className="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
                    <span>{src.sourceType.toUpperCase()}</span>
                    <span>·</span>
                    <span>{Number(src.charCount).toLocaleString()} 글자</span>
                    <span>·</span>
                    <span>{Number(src.chunkCount)} chunks</span>
                  </div>
                </div>
                <Tooltip label={t('common.delete')}>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(src); }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>

      {previewId && (
        <LibrarySourceModal
          sourceId={previewId}
          hubContext={hubContext}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}
