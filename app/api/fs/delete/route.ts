import { NextRequest, NextResponse } from 'next/server';
import { deleteFile } from '../../../../lib/api-gen/storage';
import { withAuth } from '../../../../lib/with-api-error';

export const DELETE = withAuth(async (request: NextRequest) => {
  const targetPath = new URL(request.url).searchParams.get('path');
  if (!targetPath) {
    return NextResponse.json({ success: false, error: 'path 파라미터가 필요합니다.' }, { status: 400 });
  }
  const result = await deleteFile({ value: targetPath } as any);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.message }, { status: result.message?.includes('Kernel Block') ? 403 : 500 });
  }
  return NextResponse.json({ success: true, deleted: targetPath });
});
