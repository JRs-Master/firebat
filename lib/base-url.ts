import type { NextRequest } from 'next/server';
import { BASE_URL } from '../infra/config';

/**
 * 런타임 Base URL 해석
 *
 * 우선순위:
 *   1. NEXT_PUBLIC_BASE_URL 환경변수 (명시 설정)
 *   2. 요청 헤더 (`x-forwarded-proto` + `host`) — Nginx/프록시 뒤에서도 정확
 *   3. BASE_URL 폴백 (http://localhost:3000)
 *
 * 서로 다른 도메인·서버로 배포해도 같은 코드가 동작하도록 요청 기반 해석을 지원한다.
 */
export function getBaseUrl(req?: NextRequest | Request): string {
  // env 우선 — 명시 설정은 무조건 존중
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;

  if (req) {
    try {
      const headers = req.headers;
      const host = headers.get('x-forwarded-host') || headers.get('host');
      if (host) {
        const proto = headers.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
        return `${proto}://${host}`;
      }
    } catch {
      // headers 접근 실패 — 폴백 사용
    }
  }

  return BASE_URL;
}
