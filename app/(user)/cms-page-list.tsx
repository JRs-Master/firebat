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

function formatDate(s?: string, timeZone: string = 'Asia/Seoul'): string {
  if (!s) return '';
  // sqlite CURRENT_TIMESTAMP 는 'YYYY-MM-DD HH:MM:SS' UTC 형식 — JS Date 가 안전 parse 하도록 ISO + Z 변환.
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone });
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

/**
 * 페이지 번호 목록 계산 — 일반 로직.
 * - totalPages ≤ 7: 전부 표시
 * - currentPage 근처 + 양 끝 + ellipsis ('…') 로 압축. 중복 ellipsis 제거.
 * 반환: 배열 (number = 페이지, '…' = ellipsis 자리표시)
 */
function buildPageList(currentPage: number, totalPages: number): (number | '…')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const SIBLINGS = 1; // currentPage 양쪽으로 N개씩
  const result: (number | '…')[] = [];
  const start = Math.max(2, currentPage - SIBLINGS);
  const end = Math.min(totalPages - 1, currentPage + SIBLINGS);
  result.push(1);
  if (start > 2) result.push('…');
  for (let p = start; p <= end; p++) result.push(p);
  if (end < totalPages - 1) result.push('…');
  result.push(totalPages);
  return result;
}

/** 페이지네이션 — prev/next + numbered (smart truncation). ?page=N query param 으로 동작. */
export function CmsPagination({ basePath, currentPage, totalPages }: {
  basePath: string;
  currentPage: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  // basePath 에 이미 ? 가 있으면 & 로 연결, 없으면 ? 로 시작 — `/search?q=foo` 같은 케이스 자연 처리.
  const sep = basePath.includes('?') ? '&' : '?';
  const buildHref = (page: number) => `${basePath}${sep}page=${page}`;
  const pages = buildPageList(currentPage, totalPages);

  const baseBtn = 'px-3 py-1.5 text-sm font-medium border rounded no-underline transition-opacity';
  const activeStyle = { background: 'var(--cms-primary)', borderColor: 'var(--cms-primary)', color: '#fff' };
  const idleStyle = { background: 'var(--cms-bg-card)', borderColor: 'var(--cms-border)', color: 'var(--cms-text)' };
  const disabledStyle = { background: 'var(--cms-bg-card)', borderColor: 'var(--cms-border)', color: 'var(--cms-text-muted)' };

  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5 mt-8" aria-label="Pagination">
      {currentPage > 1 ? (
        <a href={buildHref(currentPage - 1)} className={`${baseBtn} hover:opacity-80`} style={idleStyle}>
          ← 이전
        </a>
      ) : (
        <span className={`${baseBtn} opacity-40`} style={disabledStyle} aria-disabled="true">
          ← 이전
        </span>
      )}

      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-2 py-1.5 text-sm" style={{ color: 'var(--cms-text-muted)' }} aria-hidden="true">
            …
          </span>
        ) : p === currentPage ? (
          <span
            key={p}
            className={`${baseBtn} font-bold tabular-nums`}
            style={activeStyle}
            aria-current="page"
          >
            {p}
          </span>
        ) : (
          <a
            key={p}
            href={buildHref(p)}
            className={`${baseBtn} hover:opacity-80 tabular-nums`}
            style={idleStyle}
            aria-label={`${p} 페이지`}
          >
            {p}
          </a>
        )
      )}

      {currentPage < totalPages ? (
        <a href={buildHref(currentPage + 1)} className={`${baseBtn} hover:opacity-80`} style={idleStyle}>
          다음 →
        </a>
      ) : (
        <span className={`${baseBtn} opacity-40`} style={disabledStyle} aria-disabled="true">
          다음 →
        </span>
      )}
    </nav>
  );
}
