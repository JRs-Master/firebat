import { NextResponse } from 'next/server';
import { vault } from '../../../infra/storage/vault-adapter';

function getCredentials() {
  const id       = vault.getSecret('FIREBAT_ADMIN_ID')       ?? process.env.FIREBAT_ADMIN_ID       ?? 'admin';
  const password = vault.getSecret('FIREBAT_ADMIN_PASSWORD') ?? process.env.FIREBAT_ADMIN_PASSWORD ?? 'admin';
  return { id, password };
}

function isDemoMode() {
  return process.env.FIREBAT_DEMO === 'true';
}

// 로그인
export async function POST(req: Request) {
  const { id, password } = await req.json();

  // 데모 모드: user/user 계정 허용
  if (isDemoMode() && id === 'user' && password === 'user') {
    const res = NextResponse.json({ success: true, role: 'demo' });
    res.cookies.set({ name: 'firebat_admin_token', value: 'demo', httpOnly: true, path: '/' });
    res.cookies.set({ name: 'firebat_role', value: 'demo', httpOnly: false, path: '/' });
    return res;
  }

  const creds = getCredentials();
  if (id === creds.id && password === creds.password) {
    const res = NextResponse.json({ success: true, role: 'admin' });
    res.cookies.set({ name: 'firebat_admin_token', value: 'authenticated', httpOnly: true, path: '/' });
    res.cookies.set({ name: 'firebat_role', value: 'admin', httpOnly: false, path: '/' });
    return res;
  }

  return NextResponse.json({ success: false }, { status: 401 });
}

// 자격증명 변경 (현재 비밀번호 검증 필수)
export async function PATCH(req: Request) {
  const { currentPassword, newId, newPassword } = await req.json();
  const creds = getCredentials();

  if (!currentPassword || currentPassword !== creds.password) {
    return NextResponse.json({ success: false, error: '현재 비밀번호가 틀렸습니다.' }, { status: 401 });
  }
  if (!newId?.trim() && !newPassword?.trim()) {
    return NextResponse.json({ success: false, error: '변경할 ID 또는 비밀번호를 입력해주세요.' }, { status: 400 });
  }

  if (newId?.trim())       vault.setSecret('FIREBAT_ADMIN_ID',       newId.trim());
  if (newPassword?.trim()) vault.setSecret('FIREBAT_ADMIN_PASSWORD', newPassword.trim());

  return NextResponse.json({ success: true });
}
