import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

export async function POST(req: NextRequest) {
  // 로그아웃은 인증 없이도 허용 (쿠키 정리)
  const core = getCore();
  const token = req.cookies.get('firebat_token')?.value;
  if (token) core.logout(token);

  const res = NextResponse.json({ success: true });
  res.cookies.delete('firebat_token');
  res.cookies.delete('firebat_admin_token');
  return res;
}
