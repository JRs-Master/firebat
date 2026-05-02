/**
 * 시각 Breadcrumb — slug 계층을 빵부스러기로 표시.
 *
 * JSON-LD BreadcrumbList 와 동일 경로 (홈 > seg1 > seg1/seg2 > ... > 현재 페이지).
 * 마지막 세그먼트는 현재 페이지 제목, 클릭 불가 (aria-current="page").
 * 콘텐츠 페이지(project 박힌)에서 <main> 본문 시작 직전 표시.
 */

export function CmsBreadcrumb({ slug, title }: { slug: string; title?: string }) {
  const segments = slug.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // 누적 경로 — 'a/b/c' → ['a', 'a/b', 'a/b/c']
  const items: Array<{ label: string; href: string | null }> = [
    { label: '홈', href: '/' },
  ];
  let acc = '';
  segments.forEach((seg, i) => {
    acc += (acc ? '/' : '') + seg;
    const isLast = i === segments.length - 1;
    items.push({
      label: isLast ? (title ?? seg) : seg,
      href: isLast ? null : `/${acc}`,
    });
  });

  return (
    <nav
      className="flex flex-wrap items-center gap-1.5 mb-4 text-xs"
      style={{ color: 'var(--cms-text-muted)' }}
      aria-label="Breadcrumb"
    >
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">›</span>}
          {item.href ? (
            <a
              href={item.href}
              className="no-underline hover:opacity-80 transition-opacity truncate max-w-[160px] sm:max-w-[240px]"
              style={{ color: 'var(--cms-text-muted)' }}
            >
              {item.label}
            </a>
          ) : (
            <span
              className="font-medium truncate max-w-[200px] sm:max-w-[320px]"
              style={{ color: 'var(--cms-text)' }}
              aria-current="page"
            >
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
