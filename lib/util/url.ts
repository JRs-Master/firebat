/**
 * URL utility — Phase 1 정공 (2026-05-13).
 *
 * `lib/base-url.ts::getBaseUrl` 박혀있는데 path 결합 / query string 빌딩은 매 호출 site
 * manual 처리. 본 모듈이 path / query 빌딩 표준 제공.
 */

import { getBaseUrl } from '../base-url';

/**
 * URL 빌더 — base + path + query string 결합. type-safe.
 *
 * Example:
 *   buildUrl('/api/pages', { limit: 10, q: 'hello' })
 *   → 'http://localhost:3000/api/pages?limit=10&q=hello'
 */
export function buildUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
  baseOverride?: string,
): string {
  const base = baseOverride ?? getBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${base.replace(/\/$/, '')}${cleanPath}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * path-only URL 빌더 (base 제외) — Next.js Link / router push 용.
 *
 * Example:
 *   buildPath('/admin/pages', { tab: 'list' })
 *   → '/admin/pages?tab=list'
 */
export function buildPath(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (!query) return cleanPath;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${cleanPath}?${qs}` : cleanPath;
}

/**
 * URL 또는 path 의 query string 만 추출 — Record<string, string>.
 *
 * 옛 `req.nextUrl.searchParams.get(...)` 보일러플레이트 단순화.
 */
export function parseQuery(input: string | URL | URLSearchParams): Record<string, string> {
  let params: URLSearchParams;
  if (input instanceof URLSearchParams) params = input;
  else if (input instanceof URL) params = input.searchParams;
  else {
    const qIdx = input.indexOf('?');
    params = new URLSearchParams(qIdx >= 0 ? input.slice(qIdx + 1) : '');
  }
  const out: Record<string, string> = {};
  params.forEach((v, k) => { out[k] = v; });
  return out;
}
