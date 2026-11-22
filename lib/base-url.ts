import type { NextRequest } from 'next/server';

/**
 * Frontend / API route 의 Base URL 폴백 — 옛 `infra/config.ts` 의존성 제거 (Phase B-4 cutover).
 *
 * env 미설정 시 로컬 개발 default. 운영 환경에선 NEXT_PUBLIC_BASE_URL env 또는 nginx
 * `x-forwarded-host` 로 자동 감지 (`getBaseUrl(req)` 우선 사용).
 */
export const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

/** Anything with a header getter — a Request's `headers`, or `await headers()` in a server component. */
type HeaderReader = { get(name: string): string | null };

const stripSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * The site's public origin, no trailing slash. The one place this order lives:
 *   1. the CMS `siteUrl` setting (what the admin typed)
 *   2. NEXT_PUBLIC_BASE_URL
 *   3. the request — `x-forwarded-host`/`host` + `x-forwarded-proto` (correct behind Caddy/nginx)
 *   4. BASE_URL (dev fallback)
 * Server components go through `resolveSiteUrl` (lib/site-url.ts), which supplies the headers.
 */
export function siteOrigin(siteUrl: string | undefined, h?: HeaderReader): string {
  const configured = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  if (configured) return stripSlash(configured);
  if (process.env.NEXT_PUBLIC_BASE_URL) return stripSlash(process.env.NEXT_PUBLIC_BASE_URL);
  if (h) {
    try {
      const host = h.get('x-forwarded-host') || h.get('host');
      if (host) {
        const proto = h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
        return `${proto}://${host}`;
      }
    } catch {
      // header access failed — fall through
    }
  }
  return stripSlash(BASE_URL);
}

/** Request-based origin for API routes that don't take the CMS setting (share links). */
export function getBaseUrl(req?: NextRequest | Request): string {
  return siteOrigin(undefined, req?.headers);
}
