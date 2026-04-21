/**
 * 공용 sanitize util — LLM 응답 정제 중앙 집중 레이어.
 *
 * 모든 LLM (Gemini/Claude/Codex/GPT) 이 AiManager 를 거쳐 파이어뱃에 진입하므로,
 * 정제는 한 곳 (여기) 에서만 수행하고 프론트 컴포넌트는 받은 값 그대로 렌더한다.
 *
 * 적용 대상:
 * - blocks[].props 의 모든 text 필드 (label/title/message/content/…)
 * - result.reply 최종 텍스트
 *
 * 적용 NOT 대상:
 * - render_text.content (마크다운 렌더러가 처리)
 * - render_html.htmlContent (iframe 내부, 독립 DOM)
 * - 숫자 배열 (차트 data 등)
 */

/** HTML 인라인 태그를 마크다운 변환. plain text 필드에서 사용. */
export function htmlToMarkdown(s: string): string {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*\/?\s*(em|i)\s*>/gi, '*')
    .replace(/<\s*\/?\s*code\s*>/gi, '`')
    .replace(/<\s*\/?\s*u\s*>/gi, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/** AI (특히 Claude Haiku) 가 한국어/emoji 토큰을 \uXXXX escape 형태로 출력하는 케이스 디코딩.
 *  surrogate pair (emoji) 도 정확히 합쳐 처리. */
export function decodeUnicodeEscapes(s: string): string {
  if (!s || typeof s !== 'string' || !s.includes('\\u')) return s;
  // \uD83D\uDD1F 같은 surrogate pair 는 한 번에 처리 → 올바른 emoji 코드포인트 복원
  return s.replace(/\\u([\dA-Fa-f]{4})(?:\\u([\dA-Fa-f]{4}))?/g, (match, hi, lo) => {
    try {
      const high = parseInt(hi, 16);
      if (lo) {
        const low = parseInt(lo, 16);
        // surrogate pair 인지 확인
        if (high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF) {
          return String.fromCharCode(high, low);
        }
        // surrogate 가 아니면 두 글자 각각
        return String.fromCharCode(high) + String.fromCharCode(low);
      }
      return String.fromCharCode(high);
    } catch {
      return match;
    }
  });
}

/** Plain text 필드 정제 — HTML 태그 + 마크다운 마커 제거 + unicode escape 디코딩. */
export function cleanText(s: string | number | null | undefined): string {
  if (s == null) return '';
  let str = typeof s === 'string' ? s : String(s);
  str = decodeUnicodeEscapes(str);
  str = htmlToMarkdown(str);
  // plain text 필드엔 **/*/` 마커도 제거 (마크다운 렌더 안 되므로 raw 노출됨)
  str = str.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  return str;
}

/** 숫자 3자리 콤마 자동 포맷.
 *  - number → toLocaleString
 *  - 순수 숫자 문자열("1000000") → "1,000,000"
 *  - 단위 붙은 "216000원" → "216,000원"
 *  - 이미 콤마 있거나 4자리 미만이면 그대로
 */
export function formatNumber(v: string | number | null | undefined): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString('ko-KR');
  const s = String(v);
  if (s.includes(',')) return s;
  const pure = s.trim().match(/^([+\-]?)(\d{4,})(\.\d+)?$/);
  if (pure) return pure[1] + Number(pure[2]).toLocaleString('ko-KR') + (pure[3] ?? '');
  const wrapped = s.match(/^(\D*)(\d{4,})(\D*)$/);
  if (wrapped) return wrapped[1] + Number(wrapped[2]).toLocaleString('ko-KR') + wrapped[3];
  return s;
}

/** render_* 컴포넌트의 props 를 재귀 정제.
 *  컴포넌트별 규칙은 sanitize 대상 필드 목록으로 단순화 — 재귀 깊이 1~2 단계.
 *  필드 이름 기반 분류:
 *   - text 필드: label, title, message, subLabel, subtitle, description, key, name, text 등 → cleanText
 *   - numeric 필드: value, delta (number|string 받음) → number 는 보존, string 은 formatNumber
 *   - content 필드: content (Text/Html 에선 원본 유지) → 컴포넌트별 분기
 *   - 배열: items, rows, children, steps, indicators, buyPoints, sellPoints → 재귀
 *   - object: left, right (Compare), og (PageHead) → 재귀
 *
 *  Markdown 이 허용되는 필드(render_text.content) 와 HTML 이 허용되는 필드(render_html.htmlContent) 는
 *  component name 기반으로 예외 처리.
 */
const TEXT_FIELDS = new Set([
  'label', 'title', 'subtitle', 'message', 'subLabel', 'description', 'text', 'name', 'key',
  'symbol', 'alt', 'placeholder', 'helpUrl', 'targetDate', 'category', 'estimatedTime', 'unit',
]);
const NUMERIC_LIKE_FIELDS = new Set(['value', 'delta']);
/** 배열이 텍스트성 원시값(string/number)을 담는 필드 — 원소 각각을 cleanText/formatNumber.
 *  rows 는 2차원 (행→셀) 이므로 재귀 시 insideTextArray 플래그 전파로 처리. */
const TEXT_ARRAY_FIELDS = new Set(['columns', 'headers', 'rows', 'cells', 'items', 'steps', 'indicators', 'buyPoints', 'sellPoints']);
const PRESERVE_COMPONENTS = new Set(['Text', 'Html']);
const PRESERVE_FIELDS_BY_COMP: Record<string, Set<string>> = {
  Text: new Set(['content']),
  Html: new Set(['content', 'htmlContent']),
};

/** 숫자성 문자열 감지 — Table 의 isNumLikeStr 과 동일 규칙.
 *  합성 단위(조원, 만원) + 접미사(+/-) 인식 위해 단위 그룹은 0~N 회 반복 + 접미사 허용. */
const NUM_LIKE_RE = /^(?:약|대략|~|≈|approx\.?)?\s*[▲▼+\-−]?\s*[\d,]+(\.\d+)?\s*(?:원|%|배|개|건|만|억|조|천|명|월|일|시|분|달러|엔|위안|유로|\$|￥|€|£)*\s*[+\-]?\s*$/i;

function sanitizeValue(val: unknown, componentName?: string, fieldName?: string, insideTextArray = false): unknown {
  // preserve 대상: 컴포넌트+필드 조합 매칭 시 원본 유지
  if (componentName && fieldName && PRESERVE_FIELDS_BY_COMP[componentName]?.has(fieldName)) {
    return val;
  }

  if (val == null) return val;
  if (Array.isArray(val)) {
    const nextInsideTextArray = insideTextArray || (fieldName ? TEXT_ARRAY_FIELDS.has(fieldName) : false);
    return val.map(item => sanitizeValue(item, componentName, undefined, nextInsideTextArray));
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      // 객체 내부로 들어가면 insideTextArray 컨텍스트는 해제 — 객체 필드명이 우선
      out[k] = sanitizeValue(v, componentName, k, false);
    }
    return out;
  }
  if (typeof val === 'string') {
    if (fieldName && TEXT_FIELDS.has(fieldName)) return cleanText(val);
    if (fieldName && NUMERIC_LIKE_FIELDS.has(fieldName)) {
      const pure = val.trim().match(/^[+\-]?\d+(\.\d+)?$/);
      return pure ? formatNumber(val) : cleanText(val);
    }
    if (insideTextArray) {
      // 셀·리스트 원소: 숫자성이면 콤마 포맷, 아니면 텍스트 정제
      return NUM_LIKE_RE.test(val.trim()) ? formatNumber(val) : cleanText(val);
    }
    return val;
  }
  if (typeof val === 'number') {
    if (insideTextArray) return formatNumber(val); // 셀 숫자 → "1,000,000"
    if (fieldName && NUMERIC_LIKE_FIELDS.has(fieldName)) return formatNumber(val); // Metric value/delta → locale 문자열
    return val;
  }
  return val;
}

/** 렌더 블록(component props) 정제. Table/KeyValue 같이 복합 구조도 재귀 처리. */
export function sanitizeBlock(block: { type?: string; name?: string; props?: unknown; [k: string]: unknown }): typeof block {
  if (!block || typeof block !== 'object') return block;
  // preserve 대상 컴포넌트는 props 손대지 않음
  const compName = block.name ?? block.type;
  if (compName && PRESERVE_COMPONENTS.has(compName as string) && block.props && typeof block.props === 'object') {
    // Text/Html 도 title/label 같은 보조 필드가 있으면 그것만 정제. content 는 보존.
    const safeProps = sanitizeValue(block.props, compName as string) as Record<string, unknown>;
    return { ...block, props: safeProps };
  }
  if (!block.props) return block;
  return { ...block, props: sanitizeValue(block.props, compName as string) as Record<string, unknown> };
}

/** 유효하지 않은 블록(이름 누락, 빈 content 등) 걸러내기 — 프론트에서 '지원되지 않는 컴포넌트 ()' 방지 */
export function isValidBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: string; name?: string; text?: string; htmlContent?: string };
  if (b.type === 'component') return typeof b.name === 'string' && b.name.trim().length > 0;
  if (b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0;
  if (b.type === 'html') return typeof b.htmlContent === 'string' && b.htmlContent.trim().length > 0;
  return false;
}

/** 마크다운 표 + 헤더 추출 → 순서 있는 segments 로 분할.
 *  AI 가 시스템 프롬프트 무시하고 |---| 표 / ## 헤더 그대로 출력하는 케이스 후처리.
 *  reply 를 line 단위로 walk → 표/헤더 발견 시 segment 분리, 일반 텍스트는 buffer 누적.
 *
 *  반환: segments — 순서대로 [text|header|table] 구조 */
export type ReplySegment =
  | { type: 'text'; text: string }
  | { type: 'header'; level: number; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

export function extractMarkdownStructure(reply: string): { segments: ReplySegment[] } {
  if (!reply) return { segments: [] };
  const segments: ReplySegment[] = [];
  const lines = reply.split('\n');
  let textBuffer: string[] = [];
  const cleanInline = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').trim();
  const flushText = () => {
    const text = textBuffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) segments.push({ type: 'text', text });
    textBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 1. 헤더 (#~######) — 단독 줄
    const headerMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (headerMatch) {
      flushText();
      segments.push({ type: 'header', level: headerMatch[1].length, text: cleanInline(headerMatch[2]) });
      i++;
      continue;
    }
    // 2. 표 — 헤더줄 + 구분줄 + 데이터줄 N개
    if (line.trim().startsWith('|') && i + 2 < lines.length) {
      const headerLine = line.trim();
      const sepLine = lines[i + 1].trim();
      const sepCells = sepLine.startsWith('|') ? sepLine.split('|').slice(1, -1).map(c => c.trim()) : [];
      const isValidSep = sepCells.length > 0 && sepCells.every(c => /^:?-+:?$/.test(c));
      if (isValidSep) {
        const headerCells = headerLine.split('|').slice(1, -1).map(c => c.trim());
        if (headerCells.length === sepCells.length) {
          const rows: string[][] = [];
          let j = i + 2;
          while (j < lines.length && lines[j].trim().startsWith('|')) {
            const cells = lines[j].trim().split('|').slice(1, -1).map(c => c.trim());
            if (cells.length === headerCells.length) rows.push(cells);
            else break;
            j++;
          }
          if (rows.length > 0) {
            flushText();
            segments.push({
              type: 'table',
              headers: headerCells.map(cleanInline),
              rows: rows.map(r => r.map(cleanInline)),
            });
            i = j;
            continue;
          }
        }
      }
    }
    // 3. 일반 텍스트
    textBuffer.push(line);
    i++;
  }
  flushText();
  return { segments };
}

/** @deprecated extractMarkdownStructure 사용 권장. 하위 호환용으로 유지. */
export function extractMarkdownTables(reply: string): { cleanedReply: string; tables: Array<{ headers: string[]; rows: string[][] }> } {
  const { segments } = extractMarkdownStructure(reply);
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const textParts: string[] = [];
  for (const s of segments) {
    if (s.type === 'table') tables.push({ headers: s.headers, rows: s.rows });
    else if (s.type === 'text') textParts.push(s.text);
    else if (s.type === 'header') textParts.push(`${'#'.repeat(s.level)} ${s.text}`);
  }
  return { cleanedReply: textParts.join('\n\n'), tables };
}

/** reply 텍스트 정제 (최종 사용자 메시지 본문 — 마크다운 렌더러에 들어감).
 *  모든 LLM (API·CLI 공통) 이 거치는 지점 — 공급자별 후처리는 여기로 일원화. */
export function sanitizeReply(reply: string | undefined | null): string {
  if (!reply) return '';
  return decodeUnicodeEscapes(htmlToMarkdown(reply))
    // 3+ 개행 → 2 개행 (CLI 출력이 간혹 과도한 공백 행 포함)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
