/**
 * CMS Footer — Phase C widget 빌더 + legacy 4 컬럼 자동 derive.
 *
 * widgets 박혀있으면 widget catalog 기반 grid 렌더 (각 col 의 widget 배열).
 * Legacy 컬럼 (heading+content) 도 composeLayout 가 widgets 로 자동 derive — 단일 path.
 *
 * 레이아웃: 4 col grid (모바일 1열 / 태블릿 2열 / 데스크톱 4열) + 메인 텍스트 (저작권) row.
 * 모든 col 비고 텍스트도 비면 미렌더.
 */
import DOMPurify from 'isomorphic-dompurify';
import type { FooterConfig } from '../../lib/cms-layout';
import { CmsWidget } from './cms-widget-renderer';

const FOOTER_TEXT_SANITIZE = {
  ALLOWED_TAGS: ['a', 'strong', 'em', 'b', 'i', 'br', 'span', 'small'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#)/i,
};

export function CmsFooter({ footer }: { footer: FooterConfig }) {
  const widgets = footer.widgets ?? [];
  const nonEmptyCols = widgets.filter((col) => col && col.length > 0);
  const hasText = footer.text.trim().length > 0;
  if (nonEmptyCols.length === 0 && !hasText) return null;

  const sanitizedText = hasText
    ? DOMPurify.sanitize(footer.text.replace(/\n/g, '<br>'), FOOTER_TEXT_SANITIZE)
    : '';

  return (
    <footer
      style={{
        background: 'var(--cms-bg-card)',
        borderTop: '1px solid var(--cms-border)',
        color: 'var(--cms-text-muted)',
      }}
    >
      <div className="firebat-cms-content" style={{ paddingTop: '40px', paddingBottom: '32px' }}>
        {nonEmptyCols.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8 mb-8">
            {nonEmptyCols.map((col, i) => (
              <div key={i} className="flex flex-col gap-4">
                {col.map((slot, j) => (
                  <CmsWidget key={j} slot={slot} area="footer" />
                ))}
              </div>
            ))}
          </div>
        )}
        {hasText && (
          <div
            className={`text-[12px] sm:text-[13px] leading-relaxed ${nonEmptyCols.length > 0 ? 'pt-6 border-t' : ''}`}
            style={{
              fontFamily: 'var(--cms-font-body)',
              ...(nonEmptyCols.length > 0 ? { borderColor: 'var(--cms-border)' } : {}),
            }}
            dangerouslySetInnerHTML={{ __html: sanitizedText }}
          />
        )}
      </div>
    </footer>
  );
}
