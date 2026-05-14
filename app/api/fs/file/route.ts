import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from '../../../../lib/api-gen/storage';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async (request: NextRequest) => {
  const targetPath = new URL(request.url).searchParams.get('path');
  if (!targetPath) {
    return NextResponse.json({ success: false, error: 'path 파라미터가 필요합니다.' }, { status: 400 });
  }
  const result = await readFile({ value: targetPath } as any);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: result.message?.includes('Kernel Block') ? 403 : 500 });
  }
  const data = result.data as { content?: string } | undefined;
  return NextResponse.json({ success: true, content: data?.content });
});

export const PUT = withAuth(async (request: NextRequest) => {
  const { path: targetPath, content } = await request.json();
  if (!targetPath || content === undefined) {
    return NextResponse.json({ success: false, error: 'path와 content가 필요합니다.' }, { status: 400 });
  }
  const result = await writeFile({ path: targetPath, content } as any);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: result.message?.includes('Kernel Block') ? 403 : 500 });
  }
  return NextResponse.json({ success: true });
});
