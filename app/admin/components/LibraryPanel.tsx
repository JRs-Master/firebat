'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { BookOpen, Plus, Trash2, ChevronRight, Loader2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { logger } from '../../../lib/util/logger';
import { apiPost } from '../../../lib/api-fetch';
import type { LibraryReferencePb } from '../../../lib/proto-gen/firebat_pb';
import { LibraryReferenceDetail } from './LibraryReferenceDetail';

type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

/**
 * LibraryPanel — Library 영역 (Phase 1, 2026-05-17).
 *
 * NotebookLM 같은 RAG 영역. 매 Reference = 자료 그룹 (예: "법률 자료 2026").
 * 진입 시 = Reference list. 매 Reference 클릭 → LibraryReferenceDetail 영역 (Source list + 업로드).
 */
export function LibraryPanel() {
  const [refs, setRefs] = useState<LibraryReferencePb[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [selectedRef, setSelectedRef] = useState<LibraryReferencePb | null>(null);
  const nameId = useId();
  const descId = useId();

  const loadRefs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiPost<LibraryApiResponse<LibraryReferencePb[]>>(
        '/api/library/list-references',
        { owner: 'admin' },
        { category: 'library' },
      );
      if (res.success && res.data) setRefs(res.data);
    } catch (e) {
      logger.debug('library', 'list_references 실패', { error: e });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRefs();
  }, [loadRefs]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    try {
      const res = await apiPost<LibraryApiResponse<string>>(
        '/api/library/create-reference',
        {
          name: newName.trim(),
          description: newDescription.trim(),
          owner: 'admin',
        },
        { category: 'library' },
      );
      if (res.success) {
        setNewName('');
        setNewDescription('');
        setCreating(false);
        await loadRefs();
      } else {
        await alertDialog({ title: '생성 실패', message: res.error ?? '오류가 발생했습니다.' });
      }
    } catch (e) {
      logger.debug('library', 'create_reference 실패', { error: e });
    }
  }, [newName, newDescription, loadRefs]);

  const handleDelete = useCallback(async (ref: LibraryReferencePb) => {
    const ok = await confirmDialog({
      title: 'Reference 삭제',
      message: `"${ref.name}" 및 모든 Source 가 삭제됩니다. 진행하시겠습니까?`,
      okLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiPost<LibraryApiResponse<void>>(
        '/api/library/delete-reference',
        { id: ref.id },
        { category: 'library' },
      );
      if (res.success) await loadRefs();
    } catch (e) {
      logger.debug('library', 'delete_reference 실패', { error: e });
    }
  }, [loadRefs]);

  // Reference 진입 = LibraryReferenceDetail 영역 (Source list + 업로드 UI)
  if (selectedRef) {
    return (
      <LibraryReferenceDetail
        reference={selectedRef}
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
              placeholder="예: 법률 자료 2026"
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
              placeholder="예: 민법전 + 대법원 판례"
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
                onClick={() => setSelectedRef(ref)}
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
                <Tooltip label="삭제">
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(ref); }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </Tooltip>
                <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
