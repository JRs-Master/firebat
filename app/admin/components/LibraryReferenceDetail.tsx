'use client';

import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { ArrowLeft, Trash2, FileText, Globe, FileType, Loader2, Plus, Upload, Type, X, Sparkles } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { useTranslations } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import type { LibraryReferencePb, LibrarySourcePb } from '../../../lib/proto-gen/firebat_pb';
import { LibrarySourceModal } from './LibrarySourceModal';
import type { LibraryHubContext } from './LibraryPanel';
import { RowActions, InteractiveRow } from './InteractiveRow';
import { AnchoredMenu } from './Menu';

type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

type UploadMode = 'file' | 'text';

const SUPPORTED_EXT: Record<string, string> = {
  pdf: 'pdf', txt: 'txt', md: 'md', csv: 'csv',
  docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xls: 'xls', ods: 'ods', odt: 'odt', odp: 'odp', hwpx: 'hwpx',
  png: 'png', jpg: 'jpg', jpeg: 'jpeg', webp: 'webp', gif: 'gif',
};
// 이미지 확장자 — 텍스트 레이어가 없어 Gemini vision 으로만 추출. 키 게이트 + 재추출 버튼 공용.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

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
 * hub mode (hubContext 전달된 경우) — admin /api/library/* 대신 익명 /api/hub/<slug>/library/* 호출.
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
  // 파싱 프로바이더 — none(로컬)/solar(Upstage Document Parse)/gemini(vision). 기본값 = 설정
  // (assistant 탭 libraryParseProvider), 업로드마다 개별 변경 가능. quality_boost = gemini 전용.
  const [parseProvider, setParseProvider] = useState<'none' | 'solar' | 'gemini'>('none');
  const [qualityBoost, setQualityBoost] = useState(false);
  // 프로바이더 키 게이트 (admin only) — gemini = 이미지·정밀, solar = Document Parse.
  const [geminiKeyAvailable, setGeminiKeyAvailable] = useState(false);
  const [upstageKeyAvailable, setUpstageKeyAvailable] = useState(false);
  const [reextractingId, setReextractingId] = useState<string | null>(null);
  // 재파싱 프로바이더 메뉴 (AnchoredMenu) — 열린 source id + 트리거 anchor.
  const [reparseMenuId, setReparseMenuId] = useState<string | null>(null);
  const reparseTriggerRef = useRef<HTMLButtonElement | null>(null);
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

  // 프로바이더 키 게이트 + 파싱 기본값 (admin only). hub 방문자는 파싱 옵션 미노출.
  useEffect(() => {
    if (hubContext) return;
    apiGet<{ keys?: Record<string, { hasKey?: boolean }> }>('/api/vault', { category: 'library' })
      .then(d => {
        setGeminiKeyAvailable(!!d?.keys?.gemini_api_key?.hasKey);
        setUpstageKeyAvailable(!!d?.keys?.upstage_api_key?.hasKey);
      })
      .catch(() => { setGeminiKeyAvailable(false); setUpstageKeyAvailable(false); });
    // 업로드 기본 프로바이더 = 설정 (assistant 탭). 실패 시 'none'(로컬) 유지.
    apiGet<{ libraryParseProvider?: string }>('/api/settings', { category: 'library' })
      .then(d => {
        const v = d?.libraryParseProvider;
        if (v === 'solar' || v === 'gemini' || v === 'none') setParseProvider(v);
      })
      .catch(() => {});
  }, [hubContext]);

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

  // 보관 원본으로 재파싱 — 같은 source id 유지, 청크 교체. 프로바이더 선택(none/solar/gemini).
  // 원본 파일 없으면 backend 가 "원본 파일이 서버에 없습니다 — 재업로드" 에러 반환 (옛 자료 / 삭제 케이스).
  const handleReextract = useCallback(async (src: LibrarySourcePb, provider: 'none' | 'solar' | 'gemini') => {
    const providerLabel = provider === 'solar' ? 'Solar (Upstage Document Parse)' : provider === 'gemini' ? 'Gemini (vision)' : '기본 (로컬 추출)';
    const ok = await confirmDialog({
      title: '재파싱',
      message: `"${src.name}" 을 보관된 원본으로 다시 파싱합니다 — ${providerLabel}. 기존 청크가 새로 교체됩니다.`,
      okLabel: '재파싱',
    });
    if (!ok) return;
    setReextractingId(src.id);
    try {
      const res = await libraryFetch<{ chunkCount: number }>(
        'reextract-source',
        { sourceId: src.id, parseProvider: provider, precise: provider === 'gemini', qualityBoost: false },
      );
      if (res.success) {
        await loadSources();
      } else {
        await alertDialog({ title: '재파싱 실패', message: res.error ?? '오류가 발생했습니다.', danger: true });
      }
    } catch (e) {
      await alertDialog({ title: '재파싱 실패', message: String(e), danger: true });
    } finally {
      setReextractingId(null);
    }
  }, [loadSources, libraryFetch]);

  const acceptFile = useCallback((f: File | null) => {
    if (!f) { setPickedFile(null); return; }
    const ext = extOf(f.name);
    if (!SUPPORTED_EXT[ext]) {
      alertDialog({ title: '지원되지 않는 형식', message: `지원: PDF · 문서(docx/pptx/xlsx/xls/ods/odt/odp) · 한글(hwpx) · 텍스트(txt/md/csv) · 이미지(png/jpg/webp/gif). (현재: ${ext || '확장자 없음'})`, danger: true });
      if (fileInputRef.current) fileInputRef.current.value = '';
      setPickedFile(null);
      return;
    }
    setPickedFile(f);
  }, []);
  const handleFilePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0] ?? null);
  }, [acceptFile]);
  // 파일 선택 — File System Access API(데스크톱 Chromium)면 "이미지/한글/문서…" 카테고리 그룹 다이얼로그,
  // 미지원(모바일·Firefox·Safari) 또는 타입 오류면 native input(accept) 폴백.
  const openFilePicker = useCallback(async () => {
    const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<Array<{ getFile: () => Promise<File> }>> };
    if (typeof w.showOpenFilePicker === 'function') {
      try {
        const [handle] = await w.showOpenFilePicker({
          multiple: false,
          excludeAcceptAllOption: false,
          types: [
            { description: '이미지 파일', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'] } },
            { description: 'PDF 파일', accept: { 'application/pdf': ['.pdf'] } },
            { description: '문서 파일', accept: { 'application/vnd.openxmlformats-officedocument': ['.docx', '.pptx', '.xlsx', '.xls', '.ods', '.odt', '.odp'] } },
            { description: '한글 파일', accept: { 'application/x-hwp': ['.hwpx'] } },
            { description: '텍스트 파일', accept: { 'text/plain': ['.txt', '.md', '.csv'] } },
          ],
        });
        if (handle) acceptFile(await handle.getFile());
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // 사용자 취소
        // 타입 오류 등 — 아래 native 폴백으로
      }
    }
    fileInputRef.current?.click();
  }, [acceptFile]);

  const submitFile = useCallback(async () => {
    if (!pickedFile) return;
    const ext = extOf(pickedFile.name);
    const sourceType = SUPPORTED_EXT[ext];
    if (!sourceType) return;
    // 이미지 — 텍스트 레이어가 없어 Gemini vision 으로만 추출. 키 없으면 차단.
    const isImage = IMAGE_EXTS.includes(sourceType);
    if (isImage && !geminiKeyAvailable) {
      await alertDialog({ title: '추출 불가', message: '이미지 추출은 Gemini 키가 필요합니다. 설정 > 시크릿 탭에서 등록해 주세요.', danger: true });
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', pickedFile);
      fd.append('referenceId', reference.id);
      fd.append('name', pickedFile.name);
      fd.append('sourceType', sourceType);
      // 파싱 프로바이더 — 이미지는 vision 고정(프로바이더 무관), 그 외 파일은 선택값 명시.
      // quality_boost = gemini(Pro) 전용.
      if (!hubContext && !isImage) {
        fd.append('parseProvider', parseProvider);
        if (parseProvider === 'gemini' && qualityBoost) fd.append('qualityBoost', 'true');
      } else if (isImage) {
        if (qualityBoost) fd.append('qualityBoost', 'true');
      }
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
        await alertDialog({ title: '업로드 실패', message: json?.error ?? `HTTP ${res.status}`, danger: true });
        return;
      }
      resetForm();
      setUploadOpen(false);
      await loadSources();
      if (json?.data?.deduped) {
        await alertDialog({ title: '중복 자료', message: '동일한 파일이 이미 등록되어 있어 새로 추가하지 않았습니다.' });
      }
    } catch (e) {
      logger.debug('library', 'upload_file 실패', { error: e });
      await alertDialog({ title: '업로드 실패', message: String(e), danger: true });
    } finally {
      setBusy(false);
    }
  }, [pickedFile, reference.id, resetForm, loadSources, hubContext, parseProvider, qualityBoost, geminiKeyAvailable]);

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
        await alertDialog({ title: '저장 실패', message: res.error ?? 'UploadSource 실패', danger: true });
        return;
      }
      resetForm();
      setUploadOpen(false);
      await loadSources();
    } catch (e) {
      logger.debug('library', 'upload_text 실패', { error: e });
      await alertDialog({ title: '저장 실패', message: String(e), danger: true });
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
                <button
                  type="button"
                  onClick={openFilePicker}
                  className="self-start text-[11px] font-bold px-2.5 py-1.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300 transition-colors"
                >
                  {pickedFile ? '다른 파일 선택' : '파일 선택'}
                </button>
                <input
                  ref={fileInputRef}
                  id={fileBtnId}
                  type="file"
                  accept=".pdf,.txt,.md,.csv,.docx,.pptx,.xlsx,.xls,.ods,.odt,.odp,.hwpx,.png,.jpg,.jpeg,.webp,.gif"
                  onChange={handleFilePick}
                  className="hidden"
                  name="libraryFile"
                />
                {pickedFile && (
                  <p className="text-[11px] text-slate-500">
                    선택됨: <span className="font-semibold">{pickedFile.name}</span> ({(pickedFile.size / 1024).toFixed(1)} KB)
                  </p>
                )}
                <p className="text-[10px] text-slate-400">PDF · 문서(docx/pptx/xlsx/ods/odt/odp) · 한글(hwpx) · 텍스트(txt/md/csv) · 이미지(png/jpg/webp)를 지원합니다.</p>
                {/* 이미지 — 텍스트 레이어가 없어 Gemini 비전으로만 추출. 키 필요 안내. */}
                {pickedFile && IMAGE_EXTS.includes(extOf(pickedFile.name)) && (
                  <div className="p-2 rounded-lg bg-indigo-50/50 border border-indigo-100">
                    {geminiKeyAvailable ? (
                      <p className="text-[10px] text-slate-600">이미지는 Gemini 비전으로 텍스트·수식을 추출합니다.</p>
                    ) : (
                      <p className="text-[10px] text-amber-600">이미지 추출은 Gemini(Google AI Studio) 키가 필요합니다. 설정 → 시크릿에서 등록해 주세요.</p>
                    )}
                  </div>
                )}
                {/* 파싱 프로바이더 — 이미지 외 파일. 기본값 = 설정(assistant 탭), 업로드마다 개별 선택. */}
                {!hubContext && pickedFile && !IMAGE_EXTS.includes(extOf(pickedFile.name)) && (
                  <div className="flex flex-col gap-1 p-2 rounded-lg bg-indigo-50/50 border border-indigo-100">
                    <span className="text-[11px] font-bold text-slate-700">파싱 방식</span>
                    <select
                      value={parseProvider}
                      onChange={e => setParseProvider(e.target.value as 'none' | 'solar' | 'gemini')}
                      className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      name="parseProvider"
                    >
                      <option value="none">기본 (로컬 추출 — 빠르고 무료)</option>
                      <option value="solar" disabled={!upstageKeyAvailable}>
                        Solar (Upstage Document Parse — 표·레이아웃·스캔 문서){!upstageKeyAvailable ? ' — Upstage 키 필요' : ''}
                      </option>
                      <option value="gemini" disabled={!geminiKeyAvailable || extOf(pickedFile.name) !== 'pdf'}>
                        Gemini (vision — 수식·도형, PDF 전용){!geminiKeyAvailable ? ' — Gemini 키 필요' : ''}
                      </option>
                    </select>
                    {parseProvider === 'gemini' && geminiKeyAvailable && (
                      <label className="flex items-center gap-2 text-[11px] cursor-pointer text-slate-700 pl-1">
                        <input type="checkbox" id="lib-quality-boost" name="qualityBoost" checked={qualityBoost} onChange={e => setQualityBoost(e.target.checked)} />
                        <span>품질 향상 (Gemini Pro — 빽빽한 수식에 더 강함, 비용 ↑)</span>
                      </label>
                    )}
                  </div>
                )}
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
          <RowActions>
            <div className="flex flex-col">
              {sources.map(src => (
                <InteractiveRow
                  key={src.id}
                  id={String(src.id)}
                  kind="enter"
                  onActivate={() => setPreviewId(src.id)}
                  rowClassName="px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 transition-colors"
                  className="flex items-center gap-2"
                  actions={
                    <>
                      {/* 재파싱 메뉴 — 파일 기반 source(원본 보관분)만. 프로바이더 선택(기본/Solar/Gemini). */}
                      {!hubContext && src.sourceType !== 'text' && src.sourceType !== 'url' && (
                        <Tooltip label="재파싱">
                          <button
                            ref={reparseMenuId === src.id ? reparseTriggerRef : undefined}
                            onClick={() => setReparseMenuId(prev => (prev === src.id ? null : src.id))}
                            disabled={reextractingId === src.id}
                            className="p-1 text-slate-400 hover:text-indigo-600 transition-all disabled:opacity-50"
                          >
                            {reextractingId === src.id ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                          </button>
                        </Tooltip>
                      )}
                      {reparseMenuId === src.id && (
                        <AnchoredMenu anchorRef={reparseTriggerRef} onClose={() => setReparseMenuId(null)}>
                          {!IMAGE_EXTS.includes(src.sourceType) && (
                            <button
                              onClick={() => { setReparseMenuId(null); handleReextract(src, 'none'); }}
                              className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
                            >
                              기본 (로컬 추출)
                            </button>
                          )}
                          <button
                            onClick={() => { setReparseMenuId(null); handleReextract(src, 'solar'); }}
                            disabled={!upstageKeyAvailable}
                            className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
                          >
                            Solar (Upstage Document Parse){!upstageKeyAvailable ? ' — 키 필요' : ''}
                          </button>
                          {(src.sourceType === 'pdf' || IMAGE_EXTS.includes(src.sourceType)) && (
                            <button
                              onClick={() => { setReparseMenuId(null); handleReextract(src, 'gemini'); }}
                              disabled={!geminiKeyAvailable}
                              className="w-full text-left px-3 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
                            >
                              Gemini (vision){!geminiKeyAvailable ? ' — 키 필요' : ''}
                            </button>
                          )}
                        </AnchoredMenu>
                      )}
                      <Tooltip label={t('common.delete')}>
                        <button
                          onClick={() => handleDelete(src)}
                          className="p-1 text-slate-400 hover:text-red-600 transition-all"
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tooltip>
                    </>
                  }
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
                </InteractiveRow>
              ))}
            </div>
          </RowActions>
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
