import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

export async function DELETE(request: NextRequest) {
  const auth = requireAuth(request);
  if (isAuthError(auth)) return auth;
  const targetPath = new URL(request.url).searchParams.get('path');
  if (!targetPath) {
    return NextResponse.json({ success: false, error: 'path 파라미터가 필요합니다.' }, { status: 400 });
  }

  const result = await getCore().deleteFile(targetPath);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.error?.includes('Kernel Block') ? 403 : 500 });
  }
  return NextResponse.json({ success: true, deleted: targetPath });
}
