'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Trash2, FileText, Globe, FileType, Loader2, Plus } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';
import { logger } from '../../../lib/util/logger';
import { listSources, deleteSource } from '../../../lib/api-gen/library';
import type { LibraryReferencePb, LibrarySourcePb } from '../../../lib/proto-gen/firebat_pb';

/**
 * LibraryReferenceDetail — 매 Reference 안 Source list / 업로드 / 삭제 UI.
 *
 * Phase 1 단계 8.1 영역 = Source list / 삭제 영역만 박음. 업로드 영역 (8.2 / 8.3) = 다음 commit.
 */
export function LibraryReferenceDetail({
  reference,
  onBack,
}: {
  reference: LibraryReferencePb;
  onBack: () => void;
}) {
  const [sources, setSources] = useState<LibrarySourcePb[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listSources({ referenceId: reference.id });
      if (res.ok && res.data) setSources(res.data);
    } catch (e) {
      logger.debug('library', 'list_sources 실패', { error: e });
    } finally {
      setLoading(false);
    }
  }, [reference.id]);

  useEffect(() => { loadSources(); }, [loadSources]);

  const handleDelete = useCallback(async (src: LibrarySourcePb) => {
    const ok = await confirmDialog({
      title: 'Source 삭제',
      message: `"${src.name}" 을 삭제하시겠습니까?`,
      okLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await deleteSource({ id: src.id });
      if (res.ok) await loadSources();
    } catch (e) {
      logger.debug('library', 'delete_source 실패', { error: e });
    }
  }, [loadSources]);

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

      {/* Source 영역 업로드 button — 8.2 / 8.3 영역 다음 commit 박음 */}
      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/40 shrink-0">
        <button
          disabled
          className="flex items-center justify-center gap-1 w-full px-3 py-1.5 text-[12px] font-bold text-slate-400 bg-slate-100 rounded transition-colors cursor-not-allowed"
        >
          <Plus size={13} /> Source 업로드 (Phase 1 단계 8.2 영역 진행 중)
        </button>
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
            업로드 영역 박힌 시점에 자료 영역 추가 가능합니다.
          </p>
        ) : (
          <div className="flex flex-col">
            {sources.map(src => (
              <div
                key={src.id}
                className="group flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 transition-colors"
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
                <Tooltip label="삭제">
                  <button
                    onClick={() => handleDelete(src)}
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
    </div>
  );
}
