import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from './auth-guard';
import { authenticate } from './api-gen/hub';
import type { HubInstancePb } from './proto-gen/firebat_pb';

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
  /** hub widget 의 인증된 instance (admin 은 undefined) — system_prompt/model/allowed_* 필요 시. */
  hubInstance?: HubInstancePb;
  /** hub 방문자 세션 id (admin 은 undefined) — `<inst>:<sid>` 스코프 직접 조립·RPC 인자용. */
  sessionId?: string;
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
    // hub 는 외부 사이트 임베드(cross-origin) — 인증 에러도 CORS 허용해야 위젯이 응답을 읽음.
    const hubErr = (status: number, error: string) =>
      NextResponse.json({ error }, { status, headers: { 'Access-Control-Allow-Origin': '*' } });
    const apiToken = req.headers.get('x-api-token') ?? '';
    const sessionId = req.headers.get('x-session-id') ?? '';
    if (!apiToken) return hubErr(401, 'X-Api-Token 헤더가 필요합니다.');
    if (!sessionId) return hubErr(400, 'X-Session-Id 헤더가 필요합니다.');
    // 형식 검증 — sessionId 가 path 스코프(`<inst>:<sid>`)에 들어가므로 콜론·traversal·과길이 차단(defense-in-depth).
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) return hubErr(400, '잘못된 X-Session-Id 형식입니다.');
    const origin = req.headers.get('origin') ?? '';
    const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
    const authRes = await authenticate({ slug, apiToken, origin, selfHost });
    if (!authRes.ok) {
      const msg = authRes.message ?? '인증 실패';
      if (msg.includes('UNAUTHORIZED_ORIGIN:')) return hubErr(403, '허용되지 않은 도메인입니다.');
      return hubErr(401, msg);
    }
    const instance = authRes.data?.instance;
    if (!instance) return hubErr(500, 'instance 조회 실패');
    // visitor 별 격리 — "hub:<instance_id>:<session_id>".
    return {
      kind: 'widget',
      isAdmin: false,
      owner: `hub:${instance.id}:${sessionId}`,
      hubInstance: instance,
      sessionId,
    };
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
