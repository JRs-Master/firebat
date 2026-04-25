import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { SESSION_MAX_AGE_SECONDS } from '../../../infra/config';
import * as nodeCrypto from 'crypto';

/** rate-limit key — IP 또는 fallback 'unknown'. proxy 뒤일 때 X-Forwarded-For 우선. */
function attemptKeyFrom(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return 'unknown';
}

/** 시간 안정 문자열 비교 — currentPassword 비교 시 timing attack 방지 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length, 1);
  const ab = Buffer.from(a.padEnd(max, '\0'));
  const bb = Buffer.from(b.padEnd(max, '\0'));
  if (ab.length !== bb.length) return false;
  return nodeCrypto.timingSafeEqual(ab, bb) && a.length === b.length;
}

// 로그인
export async function POST(req: NextRequest) {
  const { id, password } = await req.json();
  const core = getCore();

  const result = core.login(id ?? '', password ?? '', attemptKeyFrom(req));
  // 잠금
  if (result && typeof result === 'object' && 'locked' in result && result.locked) {
    return NextResponse.json(
      { success: false, error: `로그인 시도 한도 초과 — ${result.retryAfterSec}초 후 다시 시도하세요` },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSec) } },
    );
  }
  // 자격증명 불일치
  if (!result) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  // 정상 세션 (위에서 locked 분기 처리됐으므로 여기는 AuthSession 단일)
  const session = result as Exclude<typeof result, { locked: true }>;

  const res = NextResponse.json({ success: true });

  // httpOnly 세션 쿠키 (실제 토큰)
  res.cookies.set({
    name: 'firebat_token',
    value: session.token,
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS, // 24시간
  });

  // 레거시 쿠키도 설정 (마이그레이션 기간)
  res.cookies.set({
    name: 'firebat_admin_token',
    value: 'authenticated',
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return res;
}

// 로그아웃
export async function DELETE(req: NextRequest) {
  const core = getCore();
  const token = req.cookies.get('firebat_token')?.value;
  if (token) core.logout(token);

  const res = NextResponse.json({ success: true });
  res.cookies.delete('firebat_token');
  res.cookies.delete('firebat_admin_token');
  return res;
}

// 자격증명 변경 (현재 비밀번호 검증 필수)
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { currentPassword, newId, newPassword } = await req.json();
  const core = getCore();
  const creds = core.getAdminCredentials();

  if (!currentPassword || !timingSafeStringEqual(currentPassword, creds.password)) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  if (!newId?.trim() && !newPassword?.trim()) {
    return NextResponse.json({ success: false, error: '변경할 ID 또는 비밀번호를 입력해주세요.' }, { status: 400 });
  }

  core.setAdminCredentials(newId?.trim() || undefined, newPassword?.trim() || undefined);
  return NextResponse.json({ success: true });
}
