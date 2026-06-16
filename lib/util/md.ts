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
/**
 * `==강조==` / `==색:강조==` → `<mark class="fbhl-색">` (형광펜). **escape 단계 뒤에** 호출해야 주입한
 * `<mark>` 가 literal 로 안 죽고 rehypeRaw 가 native 렌더(globals.css `.fbhl-*` 마커 질감 스타일).
 * 색: yellow(기본)/green/pink/orange/sky/purple. `blue` = `sky` 별칭. 채팅·발행·공유 공통.
 * 여는 `==` 뒤·닫는 `==` 앞 공백 금지 + 한 줄 안(`[^\n=]`)으로 매칭해 오탐(수식·구분선 등) 줄임.
 */
export function highlightMarksToHtml(s: string): string {
  if (!s || !s.includes('==')) return s;
  return s.replace(/==(?!\s)([^\n=]+?)(?<!\s)==/g, (_m, inner: string) => {
    const cm = inner.match(/^(yellow|green|pink|orange|sky|blue|purple):([\s\S]+)$/);
    let color = cm ? cm[1] : 'yellow';
    if (color === 'blue') color = 'sky';
    return `<mark class="fbhl-${color}">${cm ? cm[2] : inner}</mark>`;
  });
}

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

/**
 * `$$...$$` / `$...$` 수식(LaTeX) 영역을 placeholder 로 잠시 치환해, 다른 텍스트 변환(HTML escape /
 * `**bold**` 주입 / 개행·탭 정규화)이 LaTeX 명령(`\times`·`\theta`·`\neq` 등 — 백슬래시 t/n 으로
 * 시작)을 망가뜨리지 않게 보호한다. 변환을 마친 뒤 `restore` 로 원래 `$...$` 를 되돌리면
 * remark-math 가 정상 파싱한다. placeholder `@@FBMATH<n>@@` 는 어떤 마크다운/HTML 변환에도 안 걸리고
 * 본문에 나올 일 없는 토큰이다.
 *
 * 인라인 `$...$` 는 여는 `$` 뒤 공백 금지 + 닫는 `$` 앞 공백 금지(KaTeX 관례)로 매칭해 통화 표기
 * 같은 오탐을 줄인다. display `$$...$$` 우선.
 */
export function maskMath(s: string): { masked: string; restore: (t: string) => string } {
  const identity = (t: string) => t;
  if (!s) return { masked: s, restore: identity };
  const store: string[] = [];
  const masked = s.replace(/\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]*?(?<!\s)\$/g, (m) => {
    store.push(m);
    return '@@FBMATH' + (store.length - 1) + '@@';
  });
  if (store.length === 0) return { masked: s, restore: identity };
  const restore = (t: string) =>
    t.replace(/@@FBMATH(\d+)@@/g, (_x, i) => store[Number(i)] ?? '');
  return { masked, restore };
}
