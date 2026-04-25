/**
 * Media URL parser — 공개 URL 에서 (scope, slug, ext) 추출.
 *
 * 패턴: `/user/media/<slug>.<ext>` 또는 `/system/media/<slug>.<ext>`
 *   - 절대 URL (https://example.com/user/media/foo.png) 도 인식
 *   - variant suffix (`-480w`, `-thumb`) 포함 슬러그도 base slug 로 정규화
 *
 * 일반 로직 — scope·slug·ext 파라미터화. 특정 도메인·확장자에 의존 X.
 */

const VARIANT_SUFFIX_RE = /-(?:\d+w|thumb|full)$/;
// 캡처: (1) scope='user'|'system'  (2) slug  (3) ext
const MEDIA_PATH_RE = /\/(user|system)\/media\/([^./?#]+)\.([a-z0-9]+)(?:[?#].*)?$/i;

export interface ParsedMediaUrl {
  scope: 'user' | 'system';
  /** variant suffix 가 제거된 base slug — 메타 조회용 */
  slug: string;
  /** 원본 URL 의 raw slug (variant suffix 포함) */
  rawSlug: string;
  ext: string;
}

/** url 이 미디어 URL 패턴 매칭 시 components 반환. 아니면 null. */
export function parseMediaUrl(url: string): ParsedMediaUrl | null {
  if (!url) return null;
  // pathname 만 추출 — 절대 URL 도 같은 정규식으로 처리
  let pathname = url;
  try {
    if (/^https?:\/\//i.test(url)) {
      pathname = new URL(url).pathname;
    }
  } catch { /* fall through to raw */ }
  const match = pathname.match(MEDIA_PATH_RE);
  if (!match) return null;
  const scope = match[1] as 'user' | 'system';
  const rawSlug = match[2];
  const ext = match[3].toLowerCase();
  const slug = rawSlug.replace(VARIANT_SUFFIX_RE, '');
  return { scope, slug, rawSlug, ext };
}

/** 미디어 URL 인지만 boolean 으로. */
export function isMediaUrl(url: string): boolean {
  return parseMediaUrl(url) !== null;
}
