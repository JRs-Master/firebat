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

/** AI 가 닫는 </script> 를 JS-문자열 escape 형태 `<\/script>` 로 내보내는 습관 — iframe srcdoc(독립 문서)
 *  에선 스크립트가 안 닫혀 JS 전체가 죽음(디자인만 뜨고 버튼 무반응). 진짜 </script> 닫기가 *없을 때만*
 *  (=스크립트 미닫힘) `<\/script>`→`</script>` 정규화. JS 문자열 안 legit escape(진짜 닫기가 따로 있는
 *  경우)는 안 건드림. iframe srcdoc 생성 직전에 적용(HtmlComp / AutoResizeIframe / 공유). */
export function closeStrayScript(html: string): string {
  if (!html || !html.includes('script')) return html;
  return /<\/script\s*>/i.test(html) ? html : html.replace(/<\\+\/script\s*>/gi, '</script>');
}

const FBHL_COLORS = 'yellow|green|pink|orange|sky|blue|purple';
// `색:텍스트` / `color:색 텍스트` 파싱 — 형광펜·flat 강조 공통. 색은 AI 가 의미에 맞게 고른다.
// 미지정 시 yellow. (답변별 기계적 로테이션은 안 함 — 사용자 요구.)
function parseHlColor(inner: string): { color: string; text: string } {
  let color = 'yellow';
  let text = inner;
  let cm = inner.match(new RegExp(`^color\\s*:\\s*(${FBHL_COLORS})\\s*[:\\s]\\s*(\\S[\\s\\S]*)$`, 'i'));
  if (!cm) cm = inner.match(new RegExp(`^(${FBHL_COLORS})\\s*:\\s*(\\S[\\s\\S]*)$`, 'i'));
  if (cm) { color = cm[1].toLowerCase(); text = cm[2]; }
  if (color === 'blue') color = 'sky';
  return { color, text };
}
/**
 * `==text==` → **플랫 형광펜**(반투명 단색 마커). 색 `==색:text==`. escape 단계 뒤 호출 →
 * rehypeRaw native <mark> 렌더(globals.css `.fbhl-*`). 2026-07-15 사용자 결정으로 손그림
 * 질감(SVG 가장자리 + r0~r7 덧칠 변형) 폐기 = 일반 모양. 역할 분담: 칩 `[[term]]`
 * (chipMarksToHtml) = 핵심 키워드(용어) / 형광펜 = 핵심 내용(구절·문장 스팬).
 */
export function highlightMarksToHtml(s: string): string {
  if (!s) return s;
  if (!s.includes('[[') && !s.includes('==')) return s;
  // 코드펜스(```) 안은 건드리지 않는다 — escapeHtmlTagMentions 와 같은 가드. 칩 변환이
  // 컨텍스트-무시(문자열 전역 치환)라 펜스 안 `[[term]]` 까지 `<span class="fbchip">` 로 바꿔,
  // 코드블록이 그 태그를 리터럴로 노출하던 버그(2026-07-12 실측: 라이브 스트림 사본의
  // 펜스 안 칩이 박스 속 raw 태그로 보임). 펜스 안 마크업은 코드 = 원문 그대로가 정답.
  const parts = s.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p; // 코드펜스 원본 유지
      let out = p.includes('[[') ? chipMarksToHtml(p) : p;
      if (!out.includes('==')) return out;
      out = out.replace(/==(?!\s)([^\n=]+?)(?<!\s)==/g, (_m, inner: string) => {
        const { color, text } = parseHlColor(inner);
        return `<mark class="fbhl-${color}">${text}</mark>`;
      });
      return out;
    })
    .join('');
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
 * Inline `$...$` requires no space after the opener and none before the closer (the KaTeX
 * convention) and, since 2026-08-01, refuses to open on a digit. A price written `$0.00057` with
 * another `$0.00063` later in the sentence used to match as one formula: everything between them
 * rendered in the math font and the `<strong>` inside came out as literal tags. Prose about money
 * is far more common here than inline math that starts with a digit, and `$$...$$` still covers
 * real formulas.
 *
 * The same dollars are also escaped, because remark-math matches on its own rules further down the
 * pipeline and would pair them even after masking declined to.
 */
/** A `$` sitting right before a digit is money, not a delimiter — escape it so nothing downstream
 *  can pair it. Code spans and fences are skipped: a backslash would be visible there. */
function escapeCurrencyDollars(s: string): string {
  if (!s.includes('$')) return s;
  let out = '';
  let fence = false;
  let code = false;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('```', i)) {
      fence = !fence;
      out += '```';
      i += 2;
      continue;
    }
    const c = s[i];
    if (!fence && c === '`') {
      code = !code;
      out += c;
      continue;
    }
    const next = s[i + 1] ?? '';
    if (!fence && !code && c === '$' && next >= '0' && next <= '9' && s[i - 1] !== '\\' && s[i - 1] !== '$') {
      // A digit after `$` usually means money — but `$30^\circ$` and `$2\pi$` are math that
      // happens to start with a digit, and this escape was killing every one of them (measured
      // 2026-08-08: the trigonometry answer's degree headers and periods all rendered as raw
      // text while the backslash-leading fractions next to them survived). A span that closes
      // on the same line and carries a LaTeX marker — a backslash command or `^` — is math;
      // only the rest is money. `_` is deliberately not a marker: `$30 file_name … $40` is
      // prose about money, not a formula.
      const close = s.indexOf('$', i + 1);
      const nl = s.indexOf('\n', i + 1);
      const inner = close > i && (nl === -1 || close < nl) ? s.slice(i + 1, close) : '';
      if (inner && /\\[a-zA-Z]|\^/.test(inner)) {
        out += c;
        continue;
      }
      out += '\\$';
      continue;
    }
    out += c;
  }
  return out;
}

/** `\(...\)` / `\[...\]` → `$...$` / block `$$`. Models write the standard LaTeX delimiters in
 *  plain chat (Solar emitted `\(\theta\)` and `\[...\]` display blocks, 2026-08-08) but
 *  remark-math parses only the dollar forms, so the raw markup reached the screen as text.
 *  Normalizing the delimiter is a display concern, so it lives here and not in a prompt rule —
 *  every model does this, and a prompt cannot stop it. Code fences and inline code pass through
 *  untouched (a backslash there is content).
 *
 *  Display math MUST come out as flow form — `$$` on its own line. The first version jammed the
 *  content into an inline `$$...$$` run, and a multi-line body (`\quad` breaks, `aligned` rows)
 *  makes remark-math open a math node on the SECOND line and swallow the closing `$$` into it,
 *  flipping the pairing for the rest of the document — one long red KaTeX error wall (measured
 *  2026-08-08, the trigonometry answer: section ① single-line survived, ② onward died).
 *  The lookbehinds keep `\\[4pt]`-style aligned spacing from reading as a `\[` opener. */
export function normalizeLatexDelimiters(s: string): string {
  if (!s.includes('\\(') && !s.includes('\\[')) return s;
  return s
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(
          /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g,
          (_m, inner) => `\n\n$$\n${String(inner).trim()}\n$$\n\n`,
        )
        .replace(/(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g, (_m, inner) => `$${String(inner).trim()}$`);
    })
    .join('');
}

export function maskMath(s: string): { masked: string; restore: (t: string) => string } {
  const identity = (t: string) => t;
  if (!s) return { masked: s, restore: identity };
  s = normalizeLatexDelimiters(s);
  s = escapeCurrencyDollars(s);
  const store: string[] = [];
  // The third alternative mirrors escapeCurrencyDollars' exception: digit-leading spans are
  // masked as math only when they carry a LaTeX marker, so `$30^\circ$` is protected while a
  // stray "$30" that survived escaping still is not.
  const masked = s.replace(
    /\$\$[\s\S]+?\$\$|\$(?![\s\d])[^$\n]*?(?<!\s)\$|\$(?=\d)(?=[^$\n]*(?:\\[a-zA-Z]|\^))[^$\n]*?(?<!\s)\$/g,
    (m) => {
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
 * Tolerant fence-JSON parse — strict first, then retry after stripping `//` and `/* *\/` comments
 * plus trailing commas (all string-aware, so `https://…` and commas inside values survive). Weak
 * models decorate fence JSON with comments (2026-07-06 Solar typhoon fence `"radius": 460000,
 * // 460 km`), which broke strict parse → raw display. Mirrors Rust render_exec
 * `tolerant_json_cleanup` so server and client accept the same dialects (also fixes stored
 * messages retroactively at display time).
 */
export function parseFenceJson(body: string): any | undefined {
  const trimmed = body.trim();
  try { return JSON.parse(trimmed); } catch { /* tolerant retry below */ }
  // pass 1: strip comments
  let noComments = '';
  let inStr = false, esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inStr) {
      noComments += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; noComments += c; continue; }
    if (c === '/' && trimmed[i + 1] === '/') {
      while (i < trimmed.length && trimmed[i] !== '\n') i++;
      i--; // for-loop increments
      continue;
    }
    if (c === '/' && trimmed[i + 1] === '*') {
      i += 2;
      while (i + 1 < trimmed.length && !(trimmed[i] === '*' && trimmed[i + 1] === '/')) i++;
      i++; // lands on '/', for-loop steps past
      continue;
    }
    noComments += c;
  }
  // pass 2: drop trailing commas (`, }` / `, ]`)
  let out = '';
  inStr = false; esc = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') continue;
    }
    out += c;
  }
  // pass 3: escape raw control chars INSIDE string literals (multi-line string values —
  // never valid JSON, so escaping cannot change a valid document's meaning). Mirrors Rust
  // render_exec `escape_control_chars_in_strings` (2026-07-12 Solar 실측 클래스).
  let fixed = '';
  inStr = false; esc = false;
  for (const c of out) {
    if (inStr) {
      if (esc) { fixed += c; esc = false; continue; }
      if (c === '\\') { fixed += c; esc = true; continue; }
      if (c === '"') { fixed += c; inStr = false; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') fixed += '\\n';
        else if (c === '\r') fixed += '\\r';
        else if (c === '\t') fixed += '\\t';
        else fixed += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      fixed += c;
      continue;
    }
    if (c === '"') inStr = true;
    fixed += c;
  }
  try { return JSON.parse(fixed.trim()); } catch { /* bracket-balance retry below */ }
  // pass 4: balance brackets/braces outside strings — surplus closers dropped, wrong-type
  // closers rewritten, missing closers appended at EOF. Mirrors Rust render_exec
  // `balance_json_brackets` (2026-07-12 실측: `}}]}]}]}` tails on near-valid emissions).
  let balanced = '';
  const stack: string[] = [];
  inStr = false; esc = false;
  for (const c of fixed) {
    if (inStr) {
      balanced += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; balanced += c; continue; }
    if (c === '{') { stack.push('}'); balanced += c; continue; }
    if (c === '[') { stack.push(']'); balanced += c; continue; }
    if (c === '}' || c === ']') {
      const want = stack[stack.length - 1];
      if (want === c) { stack.pop(); balanced += c; }
      else if (want) { stack.pop(); balanced += want; }
      // no opener on the stack → surplus closer, drop it
      continue;
    }
    balanced += c;
  }
  if (inStr) balanced += '"';
  while (stack.length) balanced += stack.pop();
  try { return JSON.parse(balanced.trim()); } catch { return undefined; }
}

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
/** Item-level salvage for a fence body that defeated parseFenceJson — TS mirror of Rust
 *  render_exec::salvage_fence_items, for messages already stored with the broken fence (the
 *  server repair only touches new turns). One missing `}` in one block used to render a
 *  14-block reply as a raw JSON wall (measured 2026-08-08): the bracket-balance repair appends
 *  closers at end-of-document, the wrong place for a mid-document gap — but cut the array into
 *  items first and the same repair lands the closer exactly where it was missing. Boundaries are
 *  findable because the block shape is a fixed contract ({"type"/"name": ...}). Openers are
 *  accepted at depth 1 or 2 (one missing closer shifts everything after it by one level) and
 *  each accepted opener re-anchors the depth. Returns null when nothing was recovered. */
function salvageFenceItems(body: string): { blocks: any[]; brokenRaw: string[] } | null {
  const s = body.trim();
  if (!s.startsWith('[')) return null;
  let inStr = false, esc = false, depth = 0, lastSig = ' ';
  const starts: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; lastSig = c; continue; }
    if (c === '{') {
      if ((depth === 1 || depth === 2) && (lastSig === ',' || lastSig === '[')) {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const peek = s.slice(j, j + 7);
        if (peek.startsWith('"type"') || peek.startsWith('"name"')) {
          starts.push(i);
          depth = 1;
        }
      }
      depth++; lastSig = c; continue;
    }
    if (c === '[') { depth++; lastSig = c; continue; }
    if (c === '}' || c === ']') { depth--; lastSig = c; continue; }
    if (!/\s/.test(c)) lastSig = c;
  }
  if (starts.length < 2) return null;
  const blocks: any[] = [];
  const brokenRaw: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    let slice = s.slice(starts[i], starts[i + 1] ?? s.length).trimEnd();
    // strip the array's joinery — trailing commas and the final `]` belong to the array, and
    // the item's own missing closers are the repair's job
    while (slice.endsWith(',') || slice.endsWith(']')) slice = slice.slice(0, -1).trimEnd();
    const parsed = parseFenceJson(slice);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) blocks.push(parsed);
    else brokenRaw.push(slice);
  }
  return blocks.length ? { blocks, brokenRaw } : null;
}

export function splitFirebatRender(text: string): MdSegment[] {
  if (!text || !text.includes('firebat-render')) return [{ md: text }];
  const out: MdSegment[] = [];
  // 두 방언 수용: ```firebat-render 코드펜스(canonical) + <firebat-render>...</firebat-render>
  // XML 태그(약한 모델이 fence 를 태그로 쓰는 drift — 2026-07-06 Solar 실측). 서버(render_exec)도
  // 동일하게 양쪽을 받아 canonical 펜스로 재작성하지만, 서버를 안 거친 저장분·구버전 대비 방어.
  const re = /```firebat-render[^\n]*\n([\s\S]*?)```|<firebat-render>\s*([\s\S]*?)\s*<\/firebat-render>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ md: text.slice(last, m.index) });
    const parsed = parseFenceJson(m[1] ?? m[2] ?? '');
    if (parsed !== undefined) {
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
    } else {
      // Whole-fence parse failure → salvage the items individually before falling back to raw.
      // Recovered blocks render; an unrecoverable item stays visible as a small json fence of
      // its own text — excluded by name, never the whole answer, never silently.
      const salvaged = salvageFenceItems(m[1] ?? m[2] ?? '');
      if (salvaged) {
        const blocks = salvaged.blocks
          .map((b: any) =>
            b.type === 'component'
              ? { type: String(b.name ?? ''), props: b.props ?? {} }
              : { type: String(b.type ?? b.name ?? ''), props: b.props ?? {} },
          )
          .filter((b) => b.type);
        if (blocks.length) out.push({ blocks });
        for (const raw of salvaged.brokenRaw) out.push({ md: '```json\n' + raw + '\n```' });
        if (!blocks.length && !salvaged.brokenRaw.length) out.push({ md: m[0] });
      } else {
        out.push({ md: m[0] }); // nothing recovered → keep raw (debuggable, not silently dropped)
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ md: text.slice(last) });
  return out;
}

/** 답변 텍스트 정제 — **bold** 주입 + CLI thought 마커/환각 컴포넌트 JSON 덤프 제거.
 *  admin 채팅과 공유 페이지가 **같은 정제**를 쓰도록 공용화(옛엔 admin 로컬이라 공유에만 잔여 덤프가 보였다). */
export function cleanMarkdown(text: string): string {
  // **text** → <strong>text</strong> 변환 (CommonMark 파서가 한국어+따옴표 조합에서 볼드 인식 실패 방지)
  let cleaned = text.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>');
  // 남은 고아 ** 제거
  cleaned = cleaned.replace(/\*\*/g, '');
  // Gemini CLI 사고 과정 마커 — 파서가 놓친 경우 UI 에서 마지막 안전장치로 제거
  //   '[Thought: true]...' 이 한 번이라도 등장하면 그 이후 블록 전체 thought 로 간주하여 삭제
  if (cleaned.includes('[Thought:')) {
    cleaned = cleaned.replace(/\[Thought:\s*(?:true|false)\][\s\S]*?(?=\[Thought:\s*(?:true|false)\]|$)/g, '');
  }
  // AI 가 render_* / PageSpec 컴포넌트를 코드블록에 출력한 경우 제거 (렌더링 안 되고 길게 늘어지는 환각 텍스트)
  // 지원 패턴:
  //   1. "type":"render_xxx" 형태
  //   2. render_xxx(...) 함수 호출 형태
  //   3. "type":"Header"/"Metric"/"Grid" 등 PageSpec 컴포넌트 JSON (AI 가 tool 대신 text 로 뱉음)
  //   4. // 로 시작하는 주석이 있는 json 블록
  //   5. OHLCV/차트용 props 덤프 (symbol + data 배열 + open/high/low/close)
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?["']type["']\s*:\s*["']render_[a-z_]+["'][\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?render_[a-z_]+\s*\([\s\S]*?```/g, '');
  // PageSpec 컴포넌트 JSON (type + props 쌍 1회 이상) — 대부분 AI 가 tool 호출 대신 텍스트로 뱉는 환각
  // 주요 PascalCase 컴포넌트 이름 목록 매치 (의도하지 않은 코드 예시 제거 방지)
  const COMP_NAMES = 'Header|Text|Image|Form|Button|Divider|Table|Card|Grid|Html|Slider|Tabs|Accordion|Progress|Badge|Alert|Callout|List|Carousel|Countdown|Chart|StockChart|Metric|Timeline|Compare|KeyValue|StatusBadge|PlanCard|AdSlot';
  cleaned = cleaned.replace(new RegExp(`\`\`\`[a-zA-Z]*\\s*[\\s\\S]*?["']type["']\\s*:\\s*["'](?:${COMP_NAMES})["'][\\s\\S]*?["']props["']\\s*:[\\s\\S]*?\`\`\``, 'g'), '');
  cleaned = cleaned.replace(/```json\s*\n\s*\/\/[^\n]*\n[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*(?:\/\/[^\n]*\n)?[\s\S]*?["']symbol["']\s*:[\s\S]*?["']data["']\s*:\s*\[[\s\S]*?["'](open|close|high|low)["'][\s\S]*?```/g, '');
  return cleaned;
}
