import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

// 로그인
export async function POST(req: NextRequest) {
  const { id, password } = await req.json();
  const core = getCore();

  const session = core.login(id, password);
  if (!session) {
    return NextResponse.json({ success: false }, { status: 401 });
  }

  const res = NextResponse.json({ success: true, role: session.role });

  // httpOnly 세션 쿠키 (실제 토큰)
  res.cookies.set({
    name: 'firebat_token',
    value: session.token,
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60, // 24시간
  });

  // 클라이언트 읽기용 역할 쿠키 (비밀 아님)
  res.cookies.set({ name: 'firebat_role', value: session.role, httpOnly: false, path: '/' });

  // 레거시 쿠키도 설정 (마이그레이션 기간)
  res.cookies.set({
    name: 'firebat_admin_token',
    value: session.role === 'demo' ? 'demo' : 'authenticated',
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60,
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
  res.cookies.delete('firebat_role');
  return res;
}

// 자격증명 변경 (현재 비밀번호 검증 필수)
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const { currentPassword, newId, newPassword } = await req.json();
  const core = getCore();
  const creds = core.getAdminCredentials();

  if (!currentPassword || currentPassword !== creds.password) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  if (!newId?.trim() && !newPassword?.trim()) {
    return NextResponse.json({ success: false, error: '변경할 ID 또는 비밀번호를 입력해주세요.' }, { status: 400 });
  }

  core.setAdminCredentials(newId?.trim() || undefined, newPassword?.trim() || undefined);
  return NextResponse.json({ success: true });
}
