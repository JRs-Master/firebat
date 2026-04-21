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

/** Plain text 필드 정제 — HTML 태그 + 마크다운 마커 제거. render_text 외 모든 텍스트 필드에. */
export function cleanText(s: string | number | null | undefined): string {
  if (s == null) return '';
  let str = typeof s === 'string' ? s : String(s);
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

/** 숫자성 문자열 감지 — Table 의 isNumLikeStr 과 동일 규칙. */
const NUM_LIKE_RE = /^(?:약|대략|~|≈|approx\.?)?\s*[▲▼+\-−]?\s*[\d,]+(\.\d+)?\s*(원|%|배|개|건|만|억|조|명|월|일|시|분|달러|엔|위안|유로|\$|￥|€|£)?$/i;

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

/** reply 텍스트 정제 (최종 사용자 메시지 본문 — 마크다운 렌더러에 들어감). */
export function sanitizeReply(reply: string | undefined | null): string {
  if (!reply) return '';
  // reply 는 마크다운 렌더되므로 HTML 태그만 마크다운으로 변환 (마커는 유지).
  return htmlToMarkdown(reply);
}
