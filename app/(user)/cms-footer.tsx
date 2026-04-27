/**
 * CMS Footer — Phase 4. 사용자 페이지 하단 푸터.
 *
 * 토큰 적용: 배경 var(--cms-bg-card), 텍스트 var(--cms-text-muted).
 * sanitize 후 inline DOM — HTML 일부 허용 (<a>, <strong>, <em> 등).
 */
import DOMPurify from 'isomorphic-dompurify';
import type { FooterConfig } from '../../lib/cms-layout';

const FOOTER_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ['a', 'strong', 'em', 'b', 'i', 'br', 'span', 'div', 'p', 'small'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#)/i,
};

export function CmsFooter({ footer }: { footer: FooterConfig }) {
  if (!footer.text.trim()) return null;
  // 줄바꿈 → <br> 자동 변환 (사용자가 textarea 에 줄바꿈 박은 경우)
  const html = footer.text.replace(/\n/g, '<br>');
  const sanitized = DOMPurify.sanitize(html, FOOTER_SANITIZE_CONFIG);
  return (
    <footer
      style={{
        background: 'var(--cms-bg-card)',
        borderTop: '1px solid var(--cms-border)',
        color: 'var(--cms-text-muted)',
      }}
    >
      <div className="firebat-cms-content" style={{ paddingTop: '32px', paddingBottom: '32px' }}>
        <div
          className="text-[12px] sm:text-[13px] leading-relaxed"
          style={{ fontFamily: 'var(--cms-font-body)' }}
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      </div>
    </footer>
  );
}
