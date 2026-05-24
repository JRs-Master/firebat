'use client';

import { useState, useMemo } from 'react';
import { BookOpen } from 'lucide-react';
import { LibrarySourceModal } from './LibrarySourceModal';
import type { LibrarySourceHit } from '../types';

/**
 * SourceTags — Library Phase 1 단계 8.4 (2026-05-17).
 *
 * AI 답변에 RetrievalEngine 이 매칭한 Library hit 들을 뱃지로 노출. 답변 본문에는
 * 출처 표기 하지 않고 (system prompt 룰), 이 뱃지가 단일 source.
 *
 * - 매 source 별 dedup (chunkIndex 여러 개여도 sourceId 별 한 뱃지)
 * - 클릭 → LibrarySourceModal (full_text + page 별)
 * - ActionTags 와 같은 줄 (msg.executedActions 옆 또는 아래) 표시
 */
export function SourceTags({ hits }: { hits: LibrarySourceHit[] }) {
  const [previewId, setPreviewId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byId = new Map<string, { hit: LibrarySourceHit; count: number; bestScore: number }>();
    for (const h of hits) {
      const ex = byId.get(h.sourceId);
      if (ex) {
        ex.count += 1;
        if (h.score > ex.bestScore) ex.bestScore = h.score;
      } else {
        byId.set(h.sourceId, { hit: h, count: 1, bestScore: h.score });
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.bestScore - a.bestScore);
  }, [hits]);

  if (groups.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {groups.map(({ hit, count }) => (
          <button
            key={hit.sourceId}
            onClick={() => setPreviewId(hit.sourceId)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-50 border border-indigo-100 text-indigo-700 hover:bg-indigo-100 transition-colors"
            title={`${hit.referenceName} — ${count} chunks`}
          >
            <BookOpen size={10} className="text-indigo-400" />
            {hit.sourceName}
            {count > 1 && <span className="text-indigo-400 ml-0.5">×{count}</span>}
          </button>
        ))}
      </div>
      {previewId && (
        <LibrarySourceModal sourceId={previewId} onClose={() => setPreviewId(null)} />
      )}
    </>
  );
}
