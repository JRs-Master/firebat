'use client';

/**
 * CmsSearchModal — 모달 popup 라이브 검색.
 *
 * 헤더 검색 아이콘 클릭 시 페이지 이동 대신 모달 띄움. 입력 → 250ms debounce → /api/search.
 * 결과 list 즉시 표시. ESC / backdrop / 닫기 버튼으로 close.
 *
 * 결과 클릭 시 모달 close + 페이지 navigation. 모든 페이지 검색 (private 제외, password 포함).
 */
import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchResult {
  slug: string;
  title: string;
  project?: string;
  visibility?: string;
  updatedAt?: string;
  excerpt?: string;
}

export function SearchTrigger({ className, ariaLabel, children }: { className?: string; ariaLabel?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel ?? '검색'}
        title={ariaLabel ?? '검색'}
        className={className}
      >
        {children}
      </button>
      {open && <SearchModal onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ESC 닫기 + body scroll lock + autoFocus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      abortRef.current?.abort();
    };
  }, [onClose]);

  // Debounced 라이브 검색
  const fetchResults = useCallback(async (q: string, signal: AbortSignal) => {
    if (q.length < 2) {
      setResults([]);
      setTooShort(q.length === 1);
      return;
    }
    setTooShort(false);
    setLoading(true);
    try {
      const url = new URL('/api/search', window.location.origin);
      url.searchParams.set('q', q);
      url.searchParams.set('limit', '20');
      const res = await fetch(url.toString(), { signal });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) setResults((data.results ?? []) as SearchResult[]);
    } catch (err: any) {
      if (err?.name !== 'AbortError') setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const t = setTimeout(() => fetchResults(query.trim(), ac.signal), 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [query, fetchResults]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className="fixed inset-0"
        style={{ background: 'rgba(0, 0, 0, 0.45)', zIndex: 60 }}
      />
      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="사이트 검색"
        className="fixed left-1/2 top-[10%] -translate-x-1/2 w-full max-w-2xl px-4"
        style={{ zIndex: 61 }}
      >
        <div
          className="rounded-xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden"
          style={{ background: 'var(--cms-bg)', border: '1px solid var(--cms-border)' }}
        >
          {/* Input row */}
          <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--cms-border)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--cms-text-muted)' }}>
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="검색어 입력..."
              className="flex-1 bg-transparent border-0 outline-none text-base"
              style={{ color: 'var(--cms-text)' }}
            />
            {loading && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin" style={{ color: 'var(--cms-text-muted)' }} aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              title="닫기 (ESC)"
              className="ml-1 p-1 rounded hover:bg-slate-100 transition-colors"
              style={{ color: 'var(--cms-text-muted)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto">
            {tooShort && (
              <p className="px-4 py-6 text-sm text-center" style={{ color: 'var(--cms-text-muted)' }}>2자 이상 입력해 주세요</p>
            )}
            {!tooShort && query.trim().length >= 2 && results.length === 0 && !loading && (
              <p className="px-4 py-6 text-sm text-center" style={{ color: 'var(--cms-text-muted)' }}>매칭 없음</p>
            )}
            {!tooShort && query.trim().length === 0 && (
              <p className="px-4 py-6 text-sm text-center" style={{ color: 'var(--cms-text-muted)' }}>제목·본문·프로젝트 검색</p>
            )}
            {results.length > 0 && (
              <ul className="list-none p-0 m-0">
                {results.map((r) => (
                  <li key={r.slug}>
                    <a
                      href={`/${r.slug}`}
                      onClick={onClose}
                      className="no-underline block px-4 py-2.5 hover:bg-slate-50 transition-colors border-b"
                      style={{ borderColor: 'var(--cms-border)', color: 'var(--cms-text)' }}
                    >
                      <div className="flex items-center gap-2 text-[11px] mb-0.5" style={{ color: 'var(--cms-text-muted)' }}>
                        {r.project && <span className="font-bold">{r.project}</span>}
                        {r.project && r.updatedAt && <span>·</span>}
                        {r.updatedAt && <time dateTime={r.updatedAt}>{r.updatedAt.slice(0, 10)}</time>}
                        {r.visibility === 'password' && (
                          <span className="px-1 rounded bg-amber-100 text-amber-700 text-[10px] font-bold">🔒</span>
                        )}
                      </div>
                      <div className="text-sm font-bold leading-snug" style={{ color: 'var(--cms-text)' }}>
                        {r.title}
                      </div>
                      {r.excerpt && (
                        <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--cms-text-muted)' }}>
                          {r.excerpt}
                        </div>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Footer hint */}
          {results.length > 0 && (
            <div className="px-4 py-2 border-t text-[11px]" style={{ borderColor: 'var(--cms-border)', color: 'var(--cms-text-muted)' }}>
              {results.length}건 · ESC 로 닫기
            </div>
          )}
        </div>
      </div>
    </>
  );
}
