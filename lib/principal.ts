import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from './auth-guard';
import { authenticate } from './api-gen/hub';

/**
 * Principal — 요청 주체. admin(tenant) vs hub widget. "공통 로직 / 로그인으로 구분"의 키.
 *
 * admin·hub 라우트가 각자 반복하던 auth + owner 도출을 한 곳으로(Phase 2/3). 공통 핸들러는
 * `principal.owner` 로 owner-scoped 호출 → 본문이 admin·hub 동일, owner 만 다름.
 */
export type PrincipalKind = 'tenant' | 'widget';

export interface Principal {
  kind: PrincipalKind;
  /** 설정·시스템관리 등 admin 전용 게이트 허용 여부. */
  isAdmin: boolean;
  /** owner-scoped store 키. "admin" | "hub:<instance>:<session>". */
  owner: string;
}

/**
 * 요청 → Principal 해석. slug 있으면 hub widget(X-Api-Token + origin → authenticate → owner),
 * 없으면 admin 세션(쿠키/Bearer). 실패 시 NextResponse(에러) 반환 — 호출측은 isPrincipalError 로 분기.
 */
export async function resolvePrincipal(
  req: NextRequest,
  slug?: string,
): Promise<Principal | NextResponse> {
  // hub widget — slug 경로 + X-Api-Token (+ origin / self-host 검증은 Rust authenticate).
  if (slug) {
    const apiToken = req.headers.get('x-api-token') ?? '';
    const sessionId = req.headers.get('x-session-id') ?? '';
    if (!apiToken) {
      return NextResponse.json({ error: 'X-Api-Token 헤더가 필요합니다.' }, { status: 401 });
    }
    if (!sessionId) {
      return NextResponse.json({ error: 'X-Session-Id 헤더가 필요합니다.' }, { status: 400 });
    }
    const origin = req.headers.get('origin') ?? '';
    const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
    const authRes = await authenticate({ slug, apiToken, origin, selfHost });
    if (!authRes.ok) {
      const msg = authRes.message ?? '인증 실패';
      if (msg.includes('UNAUTHORIZED_ORIGIN:')) {
        return NextResponse.json({ error: '허용되지 않은 도메인입니다.' }, { status: 403 });
      }
      return NextResponse.json({ error: msg }, { status: 401 });
    }
    const instance = authRes.data?.instance;
    if (!instance) {
      return NextResponse.json({ error: 'instance 조회 실패' }, { status: 500 });
    }
    // visitor 별 격리 — "hub:<instance_id>:<session_id>".
    return { kind: 'widget', isAdmin: false, owner: `hub:${instance.id}:${sessionId}` };
  }

  // admin tenant — 세션 쿠키 / Bearer 토큰.
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  return { kind: 'tenant', isAdmin: true, owner: 'admin' };
}

/** resolvePrincipal 결과가 에러(NextResponse)인지 — 호출측 early-return 가드. */
export function isPrincipalError(p: Principal | NextResponse): p is NextResponse {
  return p instanceof NextResponse;
}
