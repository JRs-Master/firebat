import { NextRequest, NextResponse } from 'next/server';
import { login, logout, verifyAdminPassword, validatePasswordPolicy, setAdminCredentials } from '../../../lib/api-gen/auth';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { SESSION_MAX_AGE_SECONDS, SESSION_COOKIE_NAME } from '../../../lib/config';
import { isHttpsRequest } from '../../../lib/cookie-helpers';

/** rate-limit key — IP 또는 fallback 'unknown'. proxy 뒤일 때 X-Forwarded-For 우선. */
function attemptKeyFrom(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return 'unknown';
}

// 로그인
export async function POST(req: NextRequest) {
  const { id, password } = await req.json();

  const res = await login({ id: id ?? '', password: password ?? '', attemptKey: attemptKeyFrom(req) });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  const lr = res.data;

  // 잠금 — LoginResponsePb.code === 'LOGIN_LOCKED'. retryAfterSec 를 body 로 내려 클라가 카운트다운
  // (문구는 클라에서 i18n 포맷). error='locked' = 코드.
  if (lr.code === 'LOGIN_LOCKED') {
    const retryAfterSec = lr.retryAfterSec ?? 60;
    return NextResponse.json(
      { success: false, error: 'locked', retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }
  // 실패
  if (!lr.ok || !lr.session || !lr.session.token) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  const session = lr.session;

  const out = NextResponse.json({ success: true });

  // httpOnly 세션 쿠키 (실제 토큰).
  // secure 는 운영 (https) 환경 강제 — http localhost dev 에선 false (cookie 저장 보장).
  // sameSite=lax — CSRF 기본 방어 (외부 사이트 cross-origin POST 차단).
  // 옛 firebat_admin_token=authenticated legacy 쿠키 발급 폐기 (2026-05-09 보안 결함 fix).
  out.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.token,
    httpOnly: true,
    secure: isHttpsRequest(req),
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS, // 24시간
  });

  return out;
}

// 로그아웃
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) void logout({ sessionToken: token });

  const res = NextResponse.json({ success: true });
  res.cookies.delete(SESSION_COOKIE_NAME);
  res.cookies.delete('firebat_admin_token');
  return res;
}

// 자격증명 변경 (현재 비밀번호 검증 필수)
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { currentPassword, newId, newPassword } = await req.json();

  // argon2 hash 검증 — Rust verifyAdminPassword RPC 가 hash vs plain 비교.
  if (!currentPassword) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  const verifyRes = await verifyAdminPassword({ password: currentPassword });
  const isValid = verifyRes.ok && verifyRes.data === true;
  if (!isValid) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  if (!newId?.trim() && !newPassword?.trim()) {
    return NextResponse.json({ success: false, error: '변경할 ID 또는 비밀번호를 입력해주세요.' }, { status: 400 });
  }

  // 비번 정책 검증 — Rust validatePasswordPolicy single source.
  if (newPassword?.trim()) {
    const pw = newPassword.trim();
    const policy = await validatePasswordPolicy({ password: pw });
    if (!policy.ok) {
      return NextResponse.json(
        { success: false, error: policy.message || '비밀번호 정책 위반' },
        { status: 400 },
      );
    }
  }

  const setRes = await setAdminCredentials({ id: newId?.trim() || undefined, password: newPassword?.trim() || undefined });
  if (!setRes.ok) {
    return NextResponse.json({ success: false, error: setRes.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
