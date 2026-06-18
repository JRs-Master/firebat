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
 * 색 지정 형태 2가지 모두 수용: `sky:텍스트`(색이름:콜론) / `color:sky 텍스트`(CSS식, AI 가 자주 씀).
 * ⚠️ 콜론 없는 `sky 텍스트`(공백)는 안 받음 — "green tea" 같은 정상 텍스트를 색으로 오인하는 것 방지.
 * 여는 `==` 뒤·닫는 `==` 앞 공백 금지 + 한 줄 안(`[^\n=]`)으로 매칭해 오탐(수식·구분선 등) 줄임.
 */
// 용어 칩 — `[[term]]` / `[[color:term]]` / `[[term^주석]]` / `[[color:term^주석]]`.
// 형광펜(마커칠)과 별개 = 테두리 pill 로 "이 용어/조각"을 콕 집고, `^` 뒤는 루비(위 주석).
// indigo 는 sysmod/도구명 전용색이라 팔레트에서 제외(시각 구분). 별칭 green→emerald 등.
const FBCHIP_COLOR: Record<string, string> = {
  slate: 'slate', gray: 'slate', grey: 'slate', blue: 'blue', sky: 'sky',
  emerald: 'emerald', green: 'emerald', rose: 'rose', red: 'rose', pink: 'rose',
  amber: 'amber', orange: 'amber', yellow: 'amber', cyan: 'cyan', teal: 'cyan',
};
export function chipMarksToHtml(s: string): string {
  if (!s || !s.includes('[[')) return s;
  return s.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
    let term = inner;
    let annotation = '';
    const caret = inner.indexOf('^');
    if (caret >= 0) { term = inner.slice(0, caret); annotation = inner.slice(caret + 1).trim(); }
    let color = 'slate';
    const cm = term.match(/^([a-zA-Z]+)\s*:\s*([\s\S]+)$/);
    if (cm && FBCHIP_COLOR[cm[1].toLowerCase()]) { color = FBCHIP_COLOR[cm[1].toLowerCase()]; term = cm[2]; }
    term = term.trim();
    if (!term) return _m; // 빈 칩 = 원문 유지(오탐 방지)
    const body = annotation ? `<ruby>${term}<rt>${annotation}</rt></ruby>` : term;
    return `<span class="fbchip fbchip-${color}">${body}</span>`;
  });
}

const FBHL_COLORS = 'yellow|green|pink|orange|sky|blue|purple';
export function highlightMarksToHtml(s: string): string {
  if (!s) return s;
  // 칩(`[[...]]`)은 `==` 없어도 처리 — 형광펜과 같은 inline-마크업 패스에서 함께.
  let out = s.includes('[[') ? chipMarksToHtml(s) : s;
  if (!out.includes('==')) return out;
  out = out.replace(/==(?!\s)([^\n=]+?)(?<!\s)==/g, (_m, inner: string) => {
    let color = 'yellow';
    let text = inner;
    // CSS식 `color:sky 텍스트` / `color:sky:텍스트` (AI 가 자주 쓰는 형태).
    let cm = inner.match(new RegExp(`^color\\s*:\\s*(${FBHL_COLORS})\\s*[:\\s]\\s*(\\S[\\s\\S]*)$`, 'i'));
    // `sky:텍스트` (색이름 뒤 콜론 — 모호하지 않음).
    if (!cm) cm = inner.match(new RegExp(`^(${FBHL_COLORS})\\s*:\\s*(\\S[\\s\\S]*)$`, 'i'));
    if (cm) { color = cm[1].toLowerCase(); text = cm[2]; }
    if (color === 'blue') color = 'sky';
    // 마커 질감 변형(v1~v4 = 칠한 각도·모서리 다름) — 매번 같은 패턴이면 기계적이라 손으로 그은 듯
    // 다양하게. 단 텍스트 해시 기반(결정적)이라 같은 글자=같은 변형 → SSR/클라 hydration 안전
    // (Math.random 은 server↔client 불일치로 mismatch).
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    const v = (h % 4) + 1;
    return `<mark class="fbhl-${color} fbhl-v${v}">${text}</mark>`;
  });
  return out;
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

export type MdSegment = { md: string } | { blocks: Array<{ type: string; props: Record<string, any> }> };

/**
 * Split body text on ```firebat-render ... ``` fences (= intentional render blocks the model wrote
 * into its TEXT reply instead of calling the `render` tool). Each fence is rendered directly by
 * ComponentRenderer, bypassing the markdown text pipeline entirely — so its JSON is never mangled by
 * cleanMarkdown's hallucination-strip / escape / bold / highlight transforms. Only the surrounding
 * markdown segments go through the normal pipeline. No fence → `[{ md: whole }]` = identical to the
 * old behavior (additive, zero regression).
 *
 * Why text channel: the model corrupts Korean spelling (옳→옵) when generating it inside tool_use
 * JSON arguments, but free text (even JSON-shaped) is clean — so routing render through text fixes
 * both the corruption and the recall amnesia (render content now lives in `content`). See CLAUDE.md
 * 한국어 깨짐 진단 (2026-06-17).
 *
 * Note: bare component-JSON dumps WITHOUT this fence stay in the md segments → cleanMarkdown still
 * strips them as hallucinations (intended vs accidental render disambiguated by the explicit fence).
 */
export function splitFirebatRender(text: string): MdSegment[] {
  if (!text || !text.includes('firebat-render')) return [{ md: text }];
  const out: MdSegment[] = [];
  const re = /```firebat-render[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ md: text.slice(last, m.index) });
    try {
      const parsed = JSON.parse(m[1].trim());
      const raw: any[] = Array.isArray(parsed) ? parsed : (parsed?.blocks ?? []);
      const blocks = raw
        .filter((b) => b && typeof b === 'object')
        .map((b: any) =>
          b.type === 'component'
            ? { type: String(b.name ?? ''), props: b.props ?? {} } // render_blocks output shape
            : { type: String(b.type ?? b.name ?? ''), props: b.props ?? {} }, // direct {type,props}
        )
        .filter((b) => b.type);
      if (blocks.length) out.push({ blocks });
      else out.push({ md: m[0] }); // empty/invalid → keep raw so it's visible
    } catch {
      out.push({ md: m[0] }); // parse failure → keep raw (debuggable, not silently dropped)
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ md: text.slice(last) });
  return out;
}
