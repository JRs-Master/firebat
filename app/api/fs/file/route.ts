import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async (request: NextRequest) => {
  const targetPath = new URL(request.url).searchParams.get('path');
  if (!targetPath) {
    return NextResponse.json({ success: false, error: 'path 파라미터가 필요합니다.' }, { status: 400 });
  }
  const result = await getCore().readFile(targetPath);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.error?.includes('Kernel Block') ? 403 : 500 });
  }
  return NextResponse.json({ success: true, content: result.data });
});

export const PUT = withAuth(async (request: NextRequest) => {
  const { path: targetPath, content } = await request.json();
  if (!targetPath || content === undefined) {
    return NextResponse.json({ success: false, error: 'path와 content가 필요합니다.' }, { status: 400 });
  }
  const result = await getCore().writeFile(targetPath, content);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.error?.includes('Kernel Block') ? 403 : 500 });
  }
  return NextResponse.json({ success: true });
});
