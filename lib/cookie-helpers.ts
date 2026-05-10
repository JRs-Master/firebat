/**
 * Cookie helper — secure flag 동적 판정.
 *
 * 옛: `secure: process.env.NODE_ENV === 'production'` — production 빌드 + HTTP
 *     접속 시 브라우저가 secure cookie 무시 → 로그인 토큰 미저장 → 매번 인증 실패
 *     (self-hosted Docker / IP 직접 접속 / dev HTTPS 미설정 케이스 모두 해당)
 * 새: request scheme 검사 — HTTPS 접속 시만 secure=true. HTTP 접속 시 false
 *     로 저장 보장. nginx / Caddy reverse proxy 뒤 X-Forwarded-Proto 헤더 우선.
 */

import { NextRequest } from 'next/server';

export function isHttpsRequest(req: NextRequest): boolean {
  // reverse proxy 뒤 — Caddy / nginx 가 X-Forwarded-Proto 헤더 설정
  const xfp = req.headers.get('x-forwarded-proto');
  if (xfp) return xfp.toLowerCase().includes('https');
  // 직접 접속 — req.url 의 scheme
  return req.url.startsWith('https://');
}
