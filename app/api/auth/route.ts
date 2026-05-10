import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
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
  const core = getCore();

  // RustCoreProxy 의 autoWrap.unwrapLogin 통과 후 형식:
  //   - 성공 → AuthSession 객체 (token / type / role / createdAt 설정)
  //   - 실패 → null
  //   - 잠금 → { locked: true, retryAfterSec }
  const result = await core.login(id ?? '', password ?? '', attemptKeyFrom(req));

  // 잠금
  if (result && typeof result === 'object' && 'locked' in result && result.locked) {
    const retryAfterSec = (result as { retryAfterSec?: number }).retryAfterSec ?? 60;
    return NextResponse.json(
      { success: false, error: `로그인 시도 한도 초과 — ${retryAfterSec}초 후 다시 시도하세요` },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }
  // 실패 (null) — token 미설정 시점도 차단
  if (!result || typeof result !== 'object' || !('token' in result) || !result.token) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  // 정상 세션
  const session = result as { token: string };

  const res = NextResponse.json({ success: true });

  // httpOnly 세션 쿠키 (실제 토큰).
  // secure 는 운영 (https) 환경 강제 — http localhost dev 에선 false (cookie 박힘 보장).
  // sameSite=lax — CSRF 기본 방어 (외부 사이트 cross-origin POST 차단).
  // 옛 firebat_admin_token=authenticated legacy 쿠키 발급 폐기 (2026-05-09 보안 결함 fix).
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.token,
    httpOnly: true,
    secure: isHttpsRequest(req),
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS, // 24시간
  });

  return res;
}

// 로그아웃
export async function DELETE(req: NextRequest) {
  const core = getCore();
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) core.logout(token);

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
  const core = getCore();

  // argon2 hash 검증 — Rust core.verifyAdminPassword 가 hash vs plain 비교.
  // RustCoreProxy autoUnwrap 박혀 BoolRequest 자동 boolean 박힘.
  if (!currentPassword) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  const isValid = Boolean(await core.verifyAdminPassword(currentPassword));
  if (!isValid) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  if (!newId?.trim() && !newPassword?.trim()) {
    return NextResponse.json({ success: false, error: '변경할 ID 또는 비밀번호를 입력해주세요.' }, { status: 400 });
  }

  // 비번 정책 검증 — Rust core.validatePasswordPolicy single source.
  if (newPassword?.trim()) {
    const pw = newPassword.trim();
    const policy = await core.validatePasswordPolicy(pw);
    if (!policy?.ok) {
      return NextResponse.json(
        { success: false, error: policy?.error ?? '비밀번호 정책 위반' },
        { status: 400 },
      );
    }
  }

  await core.setAdminCredentials(newId?.trim() || undefined, newPassword?.trim() || undefined);
  return NextResponse.json({ success: true });
}
