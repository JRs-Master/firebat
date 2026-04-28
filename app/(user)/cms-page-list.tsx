/**
 * CmsPageList — 페이지 list 렌더 (variant 별 layout).
 *
 * 홈·projectRoot·tag 페이지에서 공유 사용. Phase 4 Step 4 — variant 3 변형 (Phase 5 에서
 * featured image 인프라 후 magazine·card 추가 예정).
 *
 * variant:
 *  - list (기본): 세로 list, 제목 + 메타 + 프로젝트 라벨
 *  - grid: 격자 카드 (2-3열, 모바일 1열)
 *  - compact: 매우 압축 (제목 + 날짜만, 1줄 truncate)
 */
import type { PageListItem } from '../../core/ports';

export type PageCardVariant = 'list' | 'grid' | 'compact';

function formatDate(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function CmsPageList({ pages, emptyMessage, variant = 'list' }: {
  pages: PageListItem[];
  emptyMessage?: string;
  variant?: PageCardVariant;
}) {
  if (pages.length === 0) {
    return (
      <div className="text-center py-12" style={{ color: 'var(--cms-text-muted)' }}>
        {emptyMessage ?? '아직 발행된 페이지가 없습니다.'}
      </div>
    );
  }

  if (variant === 'grid') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 list-none p-0 m-0">
        {pages.map((p) => (
          <a
            key={p.slug}
            href={`/${p.slug}`}
            className="no-underline block border p-5 transition-shadow hover:shadow-md"
            style={{
              background: 'var(--cms-bg-card)',
              borderColor: 'var(--cms-border)',
              borderRadius: 'var(--cms-radius)',
              color: 'var(--cms-text)',
            }}
          >
            <div className="flex items-center gap-2 text-[11px] mb-2" style={{ color: 'var(--cms-text-muted)' }}>
              {p.project && <span className="font-bold">{p.project}</span>}
              {p.project && p.updatedAt && <span>·</span>}
              {p.updatedAt && <time dateTime={p.updatedAt}>{formatDate(p.updatedAt)}</time>}
            </div>
            <h3
              className="text-base sm:text-lg font-bold leading-snug m-0"
              style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
            >
              {p.title}
            </h3>
          </a>
        ))}
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <ul className="flex flex-col list-none p-0 m-0 divide-y" style={{ borderColor: 'var(--cms-border)' }}>
        {pages.map((p) => (
          <li key={p.slug}>
            <a
              href={`/${p.slug}`}
              className="no-underline flex items-center justify-between gap-3 py-2.5 hover:opacity-80 transition-opacity"
              style={{ color: 'var(--cms-text)' }}
            >
              <span
                className="text-sm font-medium truncate"
                style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
              >
                {p.title}
              </span>
              {p.updatedAt && (
                <time
                  dateTime={p.updatedAt}
                  className="text-[11px] shrink-0 tabular-nums"
                  style={{ color: 'var(--cms-text-muted)' }}
                >
                  {formatDate(p.updatedAt)}
                </time>
              )}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  // list (default)
  return (
    <ul className="flex flex-col gap-4 list-none p-0 m-0">
      {pages.map((p) => (
        <li
          key={p.slug}
          className="border p-4 transition-shadow hover:shadow-sm"
          style={{
            background: 'var(--cms-bg-card)',
            borderColor: 'var(--cms-border)',
            borderRadius: 'var(--cms-radius)',
          }}
        >
          <a
            href={`/${p.slug}`}
            className="no-underline block"
            style={{ color: 'var(--cms-text)' }}
          >
            <div className="flex items-center gap-2 text-[11px] mb-1" style={{ color: 'var(--cms-text-muted)' }}>
              {p.project && <span className="font-bold">{p.project}</span>}
              {p.project && p.updatedAt && <span>·</span>}
              {p.updatedAt && <time dateTime={p.updatedAt}>{formatDate(p.updatedAt)}</time>}
            </div>
            <h3
              className="text-base sm:text-lg font-bold leading-snug m-0"
              style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
            >
              {p.title}
            </h3>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 페이지네이션 — 단순 prev/next + 현재 페이지 표시. ?page=N query param 으로 동작. */
export function CmsPagination({ basePath, currentPage, totalPages }: {
  basePath: string;
  currentPage: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  const buildHref = (page: number) => `${basePath}?page=${page}`;
  return (
    <nav className="flex items-center justify-center gap-2 mt-8" aria-label="Pagination">
      {currentPage > 1 ? (
        <a
          href={buildHref(currentPage - 1)}
          className="px-3 py-1.5 text-sm font-medium border rounded no-underline hover:opacity-80 transition-opacity"
          style={{ background: 'var(--cms-bg-card)', borderColor: 'var(--cms-border)', color: 'var(--cms-text)' }}
        >
          ← 이전
        </a>
      ) : (
        <span
          className="px-3 py-1.5 text-sm font-medium border rounded opacity-40"
          style={{ background: 'var(--cms-bg-card)', borderColor: 'var(--cms-border)', color: 'var(--cms-text-muted)' }}
        >
          ← 이전
        </span>
      )}
      <span className="px-3 py-1.5 text-sm font-bold" style={{ color: 'var(--cms-text)' }}>
        {currentPage} / {totalPages}
      </span>
      {currentPage < totalPages ? (
        <a
          href={buildHref(currentPage + 1)}
          className="px-3 py-1.5 text-sm font-medium border rounded no-underline hover:opacity-80 transition-opacity"
          style={{ background: 'var(--cms-bg-card)', borderColor: 'var(--cms-border)', color: 'var(--cms-text)' }}
        >
          다음 →
        </a>
      ) : (
        <span
          className="px-3 py-1.5 text-sm font-medium border rounded opacity-40"
          style={{ background: 'var(--cms-bg-card)', borderColor: 'var(--cms-border)', color: 'var(--cms-text-muted)' }}
        >
          다음 →
        </span>
      )}
    </nav>
  );
}
