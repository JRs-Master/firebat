import { NextRequest, NextResponse } from 'next/server';
import { getCore } from './singleton';
import type { AuthSession } from '../core/ports';

/**
 * API Route 인증 가드
 *
 * 쿠키(세션 토큰) 또는 Authorization 헤더(API 토큰)를 확인한다.
 * 유효한 세션이 없으면 401 응답을 반환한다.
 */
export function requireAuth(request: NextRequest): AuthSession | NextResponse {
  const core = getCore();

  // 1) Authorization: Bearer (API 토큰)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const session = core.validateToken(token);
    if (session) return session;
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  // 2) Cookie (세션 토큰)
  const cookie = request.cookies.get('firebat_token');
  if (cookie?.value) {
    const session = core.validateToken(cookie.value);
    if (session) return session;
  }

  // 3) 레거시 쿠키 호환 (기존 firebat_admin_token)
  const legacyCookie = request.cookies.get('firebat_admin_token');
  if (legacyCookie?.value === 'authenticated') {
    return {
      token: legacyCookie.value,
      type: 'session',
      role: 'admin',
      createdAt: Date.now(),
    };
  }

  return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
}

/** 인증 결과가 NextResponse(에러)인지 확인 */
export function isAuthError(result: AuthSession | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}
