/**
 * Related Posts — head.keywords 매칭 기반 관련 글 추천.
 *
 * Core.findRelatedPages 가 score (공유 keyword 개수) + updatedAt 정렬 후 top N 반환.
 * 콘텐츠 페이지(project 설정된 + keywords 1+ 개) 본문 끝에 표시. 결과 0건이면 미렌더.
 * 카드 변형: list 패턴 (제목 + 메타 + 프로젝트 라벨).
 */
import { getCore } from '../../lib/singleton';
import { getServerTranslations, normalizeLang } from '../../lib/i18n-server';

function formatDate(s: string | undefined, timeZone: string, lang: 'ko' | 'en'): string {
  if (!s) return '';
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const locale = lang === 'en' ? 'en-US' : 'ko-KR';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone });
}

export async function CmsRelatedPosts({ slug, limit, siteLang }: { slug: string; limit: number; siteLang?: string }) {
  const related = await getCore().findRelatedPages(slug, limit);
  if (related.length === 0) return null;
  const lang = normalizeLang(siteLang);
  const t = getServerTranslations(siteLang);

  return (
    <section
      className="mt-12 pt-8 border-t"
      style={{ borderColor: 'var(--cms-border)' }}
      aria-labelledby="related-posts-heading"
    >
      <h2
        id="related-posts-heading"
        className="text-xl sm:text-2xl font-bold tracking-tight m-0 mb-5"
        style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
      >
        {t('page.related_posts')}
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 list-none p-0 m-0">
        {related.map((p) => (
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
                {p.updatedAt && <time dateTime={p.updatedAt}>{formatDate(p.updatedAt, 'Asia/Seoul', lang)}</time>}
              </div>
              <h3
                className="text-[15px] sm:text-base font-bold leading-snug m-0"
                style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
              >
                {p.title}
              </h3>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
