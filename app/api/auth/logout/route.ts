import { NextRequest, NextResponse } from 'next/server';
import { logout } from '../../../../lib/api-gen/auth';
import { SESSION_COOKIE_NAME } from '../../../../lib/config';

export async function POST(req: NextRequest) {
  // 로그아웃은 인증 없이도 허용 (쿠키 정리)
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) void logout({ value: token });

  const res = NextResponse.json({ success: true });
  res.cookies.delete(SESSION_COOKIE_NAME);
  res.cookies.delete('firebat_admin_token');
  return res;
}
