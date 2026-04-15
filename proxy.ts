import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js Proxy (Edge Runtime)
 *
 * Edge에서는 SQLite/Vault 접근 불가 — 쿠키 존재 여부만 확인.
 * 실제 토큰 유효성 검증은 API route 내 requireAuth()가 담당.
 *
 * - /admin: 쿠키 없으면 /login 리다이렉트
 * - /login: 쿠키 있으면 /admin 리다이렉트
 * - /api/auth: 로그인 엔드포인트 — 인증 불필요
 * - /api/*: 쿠키 또는 Bearer 토큰 필요 (세부 검증은 route handler에서)
 */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // 쿠키 확인 — 새 토큰(fbat_) 또는 레거시(authenticated/demo)
  const newToken = request.cookies.get('firebat_token');
  const legacyToken = request.cookies.get('firebat_admin_token');
  const hasCookie = !!newToken?.value || legacyToken?.value === 'authenticated' || legacyToken?.value === 'demo';

  // Bearer 토큰 확인
  const hasBearer = !!request.headers.get('authorization')?.startsWith('Bearer ');

  // ── /admin 페이지 보호 ──
  if (pathname.startsWith('/admin')) {
    if (!hasCookie) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  // ── /login 리다이렉트 ──
  if (pathname.startsWith('/login')) {
    if (hasCookie) {
      return NextResponse.redirect(new URL('/admin', request.url));
    }
  }

  // ── 인증 불필요 엔드포인트 ──
  if (pathname.startsWith('/api/auth')) return NextResponse.next();
  // 비밀번호 보호 페이지/프로젝트 검증 (비인증 사용자용)
  if (pathname.match(/^\/api\/pages\/[^/]+\/visibility$/) && request.method === 'POST') return NextResponse.next();
  if (pathname === '/api/fs/projects/verify') return NextResponse.next();

  // ── /api/* — 쿠키 또는 Bearer 없으면 401 ──
  if (pathname.startsWith('/api/')) {
    if (!hasCookie && !hasBearer) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/login', '/api/:path*'],
};
