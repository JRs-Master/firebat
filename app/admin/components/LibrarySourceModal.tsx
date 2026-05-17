'use client';

import { useEffect, useState, useMemo } from 'react';
import { X, Loader2, FileText, Globe, FileType } from 'lucide-react';
import { apiPost } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';
import type { LibrarySourcePb } from '../../../lib/proto-gen/firebat_pb';

type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

/**
 * LibrarySourceModal — 매 Source 의 full_text 원본 표시.
 *
 * PDF 영역은 extractor 가 `\x0c` (form feed) 로 page boundary 박은 상태.
 * 모달이 \x0c 으로 split 하여 page 별 섹션 + 페이지 번호 영역 표시.
 *
 * URL / TXT / MD / text 영역은 page 0 단일 섹션.
 */
export function LibrarySourceModal({
  sourceId,
  onClose,
}: {
  sourceId: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState<LibrarySourcePb | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiPost<LibraryApiResponse<{ source?: LibrarySourcePb }>>(
          '/api/library/get-source',
          { id: sourceId },
          { category: 'library' },
        );
        if (!alive) return;
        if (!res.success) {
          setError(res.error ?? 'Source 조회 실패');
          return;
        }
        setSource(res.data?.source ?? null);
      } catch (e) {
        if (!alive) return;
        logger.debug('library', 'get_source 실패', { error: e });
        setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [sourceId]);

  const pages = useMemo<string[]>(() => {
    if (!source) return [];
    if (source.sourceType === 'pdf' && source.fullText.includes('\x0c')) {
      return source.fullText.split('\x0c');
    }
    return [source.fullText];
  }, [source]);

  const typeIcon = source ? (
    source.sourceType === 'pdf' || source.sourceType === 'txt' || source.sourceType === 'md'
      ? <FileText size={14} className="text-slate-500" />
      : source.sourceType === 'url'
        ? <Globe size={14} className="text-blue-500" />
        : <FileType size={14} className="text-slate-500" />
  ) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
          {typeIcon}
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-slate-700 truncate">
              {source?.name ?? '불러오는 중...'}
            </div>
            {source && (
              <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                <span>{source.sourceType.toUpperCase()}</span>
                <span>·</span>
                <span>{Number(source.charCount).toLocaleString()} 글자</span>
                <span>·</span>
                <span>{Number(source.chunkCount)} chunks</span>
                {source.sourceType === 'pdf' && pages.length > 1 && (
                  <>
                    <span>·</span>
                    <span>{pages.length} pages</span>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 본문 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-slate-400" />
            </div>
          ) : error ? (
            <p className="text-[12px] text-red-600 text-center py-12">{error}</p>
          ) : !source ? (
            <p className="text-[12px] text-slate-400 italic text-center py-12">Source 가 없습니다.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {pages.map((pageText, idx) => (
                <div key={idx} className="flex flex-col gap-1">
                  {pages.length > 1 && (
                    <div className="text-[10px] font-bold text-slate-400 sticky top-0 bg-white py-0.5">
                      Page {idx + 1}
                    </div>
                  )}
                  <pre className="text-[12px] text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                    {pageText.trim() || <span className="text-slate-300 italic">(빈 페이지)</span>}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
