import { NextRequest, NextResponse } from 'next/server';
import { validateToken } from './api-gen/auth';
import { SESSION_COOKIE_NAME } from './config';
import type { AuthSession } from './types/firebat-types';
import type { AuthValidateTokenResponse } from './proto-gen/firebat_pb';

/** AuthValidateTokenResponse → AuthSession 변환. session.token 빈 문자열이면 null (미인증). */
function pbToSession(resp: AuthValidateTokenResponse | undefined | null): AuthSession | null {
  const pb = resp?.session;
  if (!pb || !pb.token) return null;
  return {
    token: pb.token,
    type: (pb.sessionType === 'api' ? 'api' : 'session'),
    role: 'admin',
    label: pb.label,
    createdAt: Number(pb.createdAt ?? 0n),
    expiresAt: pb.expiresAt !== undefined ? Number(pb.expiresAt) : undefined,
    lastUsedAt: pb.lastUsedAt !== undefined ? Number(pb.lastUsedAt) : undefined,
  };
}

/**
 * API Route 인증 가드
 *
 * 쿠키(세션 토큰) 또는 Authorization 헤더(API 토큰)를 확인한다.
 * 유효한 세션이 없으면 401 응답을 반환한다.
 */
export async function requireAuth(request: NextRequest): Promise<AuthSession | NextResponse> {
  // 1) Authorization: Bearer (API 토큰)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const res = await validateToken({ token });
    const session = res.ok ? pbToSession(res.data) : null;
    if (session) return session;
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  // 2) Cookie (세션 토큰) — Vault 검증 필수. 옛 'firebat_admin_token=authenticated'
  // legacy fallback 폐기 (2026-05-09) — 쿠키 string 만으로 admin 통과되던 보안 결함.
  const cookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (cookie?.value) {
    const res = await validateToken({ token: cookie.value });
    const session = res.ok ? pbToSession(res.data) : null;
    if (session) return session;
  }

  return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
}

/** 인증 결과가 NextResponse(에러)인지 확인 */
export function isAuthError(result: AuthSession | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}
