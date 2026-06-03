/**
 * AI 가 굵게/이탤릭을 마크다운(`**x**`) 대신 raw HTML(`<strong>x</strong>`)로 보내는 경우 처리.
 *
 * 짝이 맞는 인라인 포맷 태그(strong/b/em/i)를 마크다운으로 변환한다. 이렇게 하면:
 *  - 이후 단계의 raw-HTML escape(admin escapeHtmlTagMentions / user escapeHtmlTags)가 이 태그를
 *    literal(회색 인라인코드 또는 `&lt;strong&gt;` 텍스트)로 죽이지 않는다 = 굵게 의도 보존.
 *  - 변환된 `**x**` 는 renderMarkdown / mdBoldFix 의 `<strong>` 주입으로 정상 굵게 렌더.
 *  - 짝이 안 맞는(dangling) 태그는 변환되지 않으므로 escape 단계가 literal 로 처리 = bold 번짐 방어 유지.
 *
 * 입력이 `**` 든 `<strong>` 든 같은 결과가 되도록 하는 게 목적(no-hardcoding). 코드펜스(```) 안의
 * 태그 예시는 건드리지 않는다.
 */
export function inlineFormatTagsToMarkdown(text: string): string {
  if (!text) return text;
  // 코드펜스 블록은 건너뛰고 바깥 텍스트만 변환 (HTML 태그 설명 예시 보존).
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p; // 코드펜스 원본 유지
      return p
        // <strong>x</strong> / <b>x</b> → **x** (속성·대소문자 허용, 짝 맞는 경우만)
        .replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) => {
          const v = inner.trim();
          return v ? `**${v}**` : '';
        })
        // <em>x</em> / <i>x</i> → *x*
        .replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner) => {
          const v = inner.trim();
          return v ? `*${v}*` : '';
        });
    })
    .join('');
}
