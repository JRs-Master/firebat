'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { BookOpen, Plus, Trash2, ChevronRight, Loader2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { useTranslations } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { rowActionsClass } from '../utils/row-actions';
import { useRowActions } from '../hooks/useRowActions';
import { apiPost } from '../../../lib/api-fetch';
import type { LibraryReferencePb } from '../../../lib/proto-gen/firebat_pb';
import { LibraryReferenceDetail } from './LibraryReferenceDetail';

type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

export type LibraryHubContext = { slug: string; apiToken: string; sessionId: string };

/**
 * LibraryPanel — Library 영역 (Phase 1, 2026-05-17).
 *
 * NotebookLM 같은 RAG. 매 Reference = 자료 그룹 (사용자가 자유 분류).
 * 진입 시 = Reference list. 매 Reference 클릭 → LibraryReferenceDetail (Source list + 업로드).
 *
 * hub mode (hubContext prop 전달된 경우) — admin /api/library/[op] 대신
 * 익명 /api/hub/<slug>/library 호출. owner 자동 hub-scoped (방문자 자료 격리).
 */
export function LibraryPanel({ hubContext }: { hubContext?: LibraryHubContext } = {}) {
  const t = useTranslations();
  const rows = useRowActions();
  const [refs, setRefs] = useState<LibraryReferencePb[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [selectedRef, setSelectedRef] = useState<LibraryReferencePb | null>(null);
  const nameId = useId();
  const descId = useId();

  // hub mode 면 익명 endpoint, 아니면 admin endpoint. owner 영역은 hub 가 자동 주입.
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

  const loadRefs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await libraryFetch<LibraryReferencePb[]>(
        'list-references',
        { owner: 'admin' }, // hub mode 면 backend 가 hub-scoped owner 덮어씀
      );
      if (res.success && res.data) setRefs(res.data);
    } catch (e) {
      logger.debug('library', 'list_references 실패', { error: e });
    } finally {
      setLoading(false);
    }
  }, [libraryFetch]);

  useEffect(() => {
    loadRefs();
  }, [loadRefs]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    try {
      const res = await libraryFetch<string>(
        'create-reference',
        {
          name: newName.trim(),
          description: newDescription.trim(),
          owner: 'admin',
        },
      );
      if (res.success) {
        setNewName('');
        setNewDescription('');
        setCreating(false);
        await loadRefs();
      } else {
        await alertDialog({ title: '생성 실패', message: res.error ?? '오류가 발생했습니다.', danger: true });
      }
    } catch (e) {
      logger.debug('library', 'create_reference 실패', { error: e });
    }
  }, [newName, newDescription, loadRefs, libraryFetch]);

  const handleDelete = useCallback(async (ref: LibraryReferencePb) => {
    const ok = await confirmDialog({
      title: 'Reference 삭제',
      message: `"${ref.name}" 및 모든 Source 가 삭제됩니다. 진행하시겠습니까?`,
      okLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await libraryFetch<void>('delete-reference', { id: ref.id });
      if (res.success) await loadRefs();
    } catch (e) {
      logger.debug('library', 'delete_reference 실패', { error: e });
    }
  }, [loadRefs, libraryFetch]);

  // Reference 진입 = LibraryReferenceDetail (Source list + 업로드 UI)
  if (selectedRef) {
    return (
      <LibraryReferenceDetail
        reference={selectedRef}
        hubContext={hubContext}
        onBack={() => { setSelectedRef(null); loadRefs(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50/60 shrink-0">
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-700">
          <BookOpen size={13} className="text-indigo-500" />
          Library
          <span className="text-[11px] font-medium text-slate-400">({refs.length})</span>
        </div>
        <button
          onClick={() => setCreating(c => !c)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
        >
          <Plus size={11} /> {creating ? '취소' : '새 Reference'}
        </button>
      </div>

      {/* 새 Reference 생성 form */}
      {creating && (
        <div className="px-3 py-3 border-b border-slate-100 bg-blue-50/40 flex flex-col gap-2 shrink-0">
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-[11px] font-bold text-slate-600">이름</label>
            <input
              id={nameId}
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="자료 그룹 이름"
              className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              name="newRefName"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={descId} className="text-[11px] font-bold text-slate-600">설명 (옵션)</label>
            <input
              id={descId}
              type="text"
              value={newDescription}
              onChange={e => setNewDescription(e.target.value)}
              placeholder="이 그룹의 자료 설명 (선택)"
              className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              name="newRefDesc"
              autoComplete="off"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={!newName.trim()}
            className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300"
          >
            생성
          </button>
        </div>
      )}

      {/* Reference 목록 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-slate-400" />
          </div>
        ) : refs.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic text-center py-8 px-3">
            Reference 가 없습니다.<br />
            "새 Reference" 버튼으로 자료 그룹을 만들어주세요.
          </p>
        ) : (
          <div className="flex flex-col">
            {refs.map(ref => (
              <div
                key={ref.id}
                className="group flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                onClick={() => rows.handleRowClick(String(ref.id), rows.hoverNone ? undefined : () => setSelectedRef(ref))}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-slate-700 truncate">
                    {ref.name}
                  </div>
                  {ref.description && (
                    <div className="text-[11px] text-slate-400 truncate mt-0.5">
                      {ref.description}
                    </div>
                  )}
                </div>
                <span className={rowActionsClass(rows.isActive(String(ref.id)))}>
                  <Tooltip label={t('common.delete')}>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(ref); }}
                      className="p-1 text-slate-400 hover:text-red-600 transition-all"
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                </span>
                {/* > = 명시적 진입(상세) 버튼. 본문 탭은 액션 노출만 (모바일). */}
                <button
                  onClick={e => { e.stopPropagation(); setSelectedRef(ref); }}
                  className="p-1 text-slate-300 hover:text-slate-600 transition-colors shrink-0"
                  aria-label={t('common.open')}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
