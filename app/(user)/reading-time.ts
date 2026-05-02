/**
 * Reading time 추정 — render_* 컴포넌트 트리에서 텍스트 추출 → N분 읽기 산정.
 *
 * 한국어 기준 ~500자/분 (느린 독해 안전 마진 포함).
 * 한·영 혼재해도 character count 기반이라 자연 작동.
 * Code/Embed/Image/Video/Map/Iframe 등은 본문 시간 산정에서 제외 (시각 요소).
 */

const CHARS_PER_MIN = 500;

/** PageComponent 트리에서 본문 텍스트 추출 (재귀). */
function extractText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node + ' ';
  if (typeof node === 'number' || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node !== 'object') return '';

  const obj = node as Record<string, unknown>;
  const type = obj.type;

  // 시각 요소 — 텍스트 시간 산정에서 제외
  if (type === 'Image' || type === 'Video' || type === 'Embed' || type === 'Map' || type === 'Iframe' || type === 'Chart' || type === 'Code' || type === 'Divider' || type === 'Spacer' || type === 'Countdown') {
    return '';
  }

  // 텍스트 보유 필드 — 알려진 키 위주 (props/children 도 포함)
  const TEXT_FIELDS = [
    'title', 'subtitle', 'content', 'text', 'label', 'description', 'caption',
    'message', 'heading', 'subheading', 'body', 'placeholder', 'name', 'alt',
  ];
  let acc = '';
  for (const k of TEXT_FIELDS) {
    const v = obj[k];
    if (typeof v === 'string') acc += v + ' ';
  }

  // 자식 컬렉션 — 재귀
  const COLLECTION_FIELDS = ['items', 'children', 'tabs', 'rows', 'cells', 'columns', 'steps', 'data', 'props'];
  for (const k of COLLECTION_FIELDS) {
    const v = obj[k];
    if (v != null) acc += extractText(v);
  }

  return acc;
}

/** 본문에서 단어/문자 수 → 읽기 시간(분). 최소 1분. */
export function estimateReadingTime(body: unknown): number {
  if (!body) return 1;
  const text = extractText(body);
  // 공백·줄바꿈 압축 후 길이.
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return 0;
  return Math.max(1, Math.ceil(compact.length / CHARS_PER_MIN));
}
