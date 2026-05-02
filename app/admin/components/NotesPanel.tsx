'use client';

/**
 * NotesPanel — sysmod_notes 어드민 UI.
 *
 * 사이드바 노트 탭. list/read/write/delete sysmod 호출 (`/api/module/run`).
 * 데이터: data/notes/*.md (markdown + frontmatter).
 */
import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Trash2, X, NotebookText } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';

interface Note {
  slug: string;
  title: string;
  tags?: string[];
  contentPreview?: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
}

async function callNotes(action: string, data: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/module/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: 'notes', data: { action, ...data } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'sysmod_notes 실패');
  return json.data;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

export function NotesPanel() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Note>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);

  const fetchNotes = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const result = q.trim()
        ? await callNotes('search', { query: q.trim(), limit: 100 })
        : await callNotes('list', { limit: 100 });
      setNotes((result?.items ?? []) as Note[]);
    } catch (err: any) {
      console.error('[NotesPanel] fetch fail', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotes('');
  }, [fetchNotes]);

  useEffect(() => {
    const t = setTimeout(() => fetchNotes(query), 250);
    return () => clearTimeout(t);
  }, [query, fetchNotes]);

  const handleExpand = async (slug: string) => {
    if (expandedSlug === slug) {
      setExpandedSlug(null);
      return;
    }
    setExpandedSlug(slug);
    if (!details[slug]) {
      try {
        const result = await callNotes('read', { slug });
        if (result?.note) setDetails(prev => ({ ...prev, [slug]: result.note }));
      } catch { /* ignore */ }
    }
  };

  const handleDelete = async (note: Note) => {
    const ok = await confirmDialog({
      title: '노트 삭제',
      message: `"${note.title || note.slug}" 노트를 삭제합니다. 복구 불가.`,
      okLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    try {
      await callNotes('delete', { slug: note.slug });
      setNotes(prev => prev.filter(n => n.slug !== note.slug));
      setDetails(prev => {
        const next = { ...prev };
        delete next[note.slug];
        return next;
      });
    } catch (err: any) {
      alert(`삭제 실패: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 헤더 — 검색 + 추가 */}
      <div className="px-2 py-2 border-b border-slate-200/80 flex items-center gap-1">
        <div className="flex-1 relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="노트 검색"
            className="w-full pl-6 pr-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <Tooltip label="노트 추가">
          <button
            onClick={() => { setEditing(null); setShowCreate(true); }}
            className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-md"
          >
            <Plus size={13} />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && notes.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400">로드 중...</p>
        ) : notes.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400 italic">
            {query ? '매칭 없음' : '노트 없음. + 버튼으로 추가'}
          </p>
        ) : (
          <ul className="list-none p-0 m-0">
            {notes.map(n => {
              const isExpanded = expandedSlug === n.slug;
              const detail = details[n.slug];
              return (
                <li key={n.slug} className="border-b border-slate-100">
                  <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-slate-50">
                    <button
                      onClick={() => handleExpand(n.slug)}
                      className="flex-1 text-left flex items-start gap-2 cursor-pointer bg-transparent border-0 p-0 min-w-0"
                    >
                      <NotebookText size={11} className="mt-0.5 shrink-0 text-slate-400" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-slate-700 truncate">{n.title || n.slug}</div>
                        {n.contentPreview && !isExpanded && (
                          <div className="text-[10px] text-slate-500 truncate mt-0.5">{n.contentPreview}</div>
                        )}
                        {n.tags && n.tags.length > 0 && (
                          <div className="flex flex-wrap gap-0.5 mt-0.5">
                            {n.tags.slice(0, 3).map((t, i) => (
                              <span key={i} className="text-[9px] px-1 rounded bg-slate-100 text-slate-500">#{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </button>
                    <Tooltip label="편집">
                      <button
                        onClick={() => { setEditing(detail || n); setShowCreate(true); }}
                        className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip label="삭제">
                      <button
                        onClick={() => handleDelete(n)}
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={10} />
                      </button>
                    </Tooltip>
                  </div>
                  {isExpanded && detail && (
                    <div className="px-3 py-2 bg-slate-50/50 border-t border-slate-100">
                      <div className="text-[10px] text-slate-500 mb-1.5">
                        {detail.createdAt && <span>생성: {formatDate(detail.createdAt)}</span>}
                        {detail.updatedAt && detail.createdAt !== detail.updatedAt && (
                          <span> · 수정: {formatDate(detail.updatedAt)}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono leading-relaxed">
                        {detail.content || '(빈 본문)'}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showCreate && (
        <NoteModal
          existing={editing}
          onClose={() => { setShowCreate(false); setEditing(null); }}
          onSaved={() => {
            setShowCreate(false);
            setEditing(null);
            // 캐시 무효화
            setDetails({});
            fetchNotes(query);
          }}
        />
      )}
    </div>
  );
}

function NoteModal({ existing, onClose, onSaved }: { existing: Note | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [content, setContent] = useState(existing?.content ?? '');
  const [tagsRaw, setTagsRaw] = useState((existing?.tags ?? []).join(', '));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!title.trim() && !content.trim()) {
      setError('제목 또는 본문 필수');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const tags = tagsRaw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
      await callNotes('write', {
        slug: existing?.slug,
        title: title.trim(),
        content,
        tags: tags.length > 0 ? tags : undefined,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || '저장 실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-800">{existing ? '노트 편집' : '노트 추가'}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded"><X size={14} /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">제목</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="노트 제목"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">본문 (markdown OK)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              placeholder="# 제목&#10;본문..."
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono resize-none"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">태그 (콤마 분리)</label>
            <input
              type="text"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="아이디어, todo, 매매"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <button onClick={onClose} className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded">취소</button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1 text-xs font-bold bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-40"
          >
            {existing ? '저장' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}
