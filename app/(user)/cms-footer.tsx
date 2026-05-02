/**
 * CMS Footer — Phase 4 + 4 컬럼 widget 확장.
 *
 * 토큰 적용: 배경 var(--cms-bg-card), 텍스트 var(--cms-text-muted).
 * sanitize 후 inline DOM — HTML 일부 허용 (<a>, <strong>, <em>, <ul> 등).
 *
 * 레이아웃: 4 컬럼 (모바일 1열 / 태블릿 2열 / 데스크톱 4열) → 메인 텍스트 (저작권 등).
 * 컬럼 모두 비어있으면 메인 텍스트만 단독 표시 (이전 호환).
 */
import DOMPurify from 'isomorphic-dompurify';
import type { FooterConfig } from '../../lib/cms-layout';

const FOOTER_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['a', 'strong', 'em', 'b', 'i', 'br', 'span', 'div', 'p', 'small', 'ul', 'ol', 'li', 'h4'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#)/i,
};

function sanitizeWithBreaks(raw: string): string {
  if (!raw) return '';
  const html = raw.replace(/\n/g, '<br>');
  return DOMPurify.sanitize(html, FOOTER_SANITIZE_CONFIG);
}

export function CmsFooter({ footer }: { footer: FooterConfig }) {
  const cols = (footer.columns ?? []).filter((c) => c.heading.trim() || c.content.trim());
  const hasText = footer.text.trim().length > 0;
  if (cols.length === 0 && !hasText) return null;

  const sanitizedText = hasText ? sanitizeWithBreaks(footer.text) : '';

  return (
    <footer
      style={{
        background: 'var(--cms-bg-card)',
        borderTop: '1px solid var(--cms-border)',
        color: 'var(--cms-text-muted)',
      }}
    >
      <div className="firebat-cms-content" style={{ paddingTop: '40px', paddingBottom: '32px' }}>
        {cols.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8 mb-8">
            {cols.map((col, i) => (
              <div key={i}>
                {col.heading.trim() && (
                  <h4
                    className="text-[13px] font-bold uppercase tracking-wider mb-3 m-0"
                    style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
                  >
                    {col.heading.trim()}
                  </h4>
                )}
                {col.content.trim() && (
                  <div
                    className="text-[12px] sm:text-[13px] leading-relaxed"
                    style={{ fontFamily: 'var(--cms-font-body)' }}
                    dangerouslySetInnerHTML={{ __html: sanitizeWithBreaks(col.content) }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {hasText && (
          <div
            className={`text-[12px] sm:text-[13px] leading-relaxed ${cols.length > 0 ? 'pt-6 border-t' : ''}`}
            style={{
              fontFamily: 'var(--cms-font-body)',
              ...(cols.length > 0 ? { borderColor: 'var(--cms-border)' } : {}),
            }}
            dangerouslySetInnerHTML={{ __html: sanitizedText }}
          />
        )}
      </div>
    </footer>
  );
}
