import { NextResponse } from 'next/server';
import { getFileTree } from '../../../../lib/api-gen/storage';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const res = await getFileTree({ value: 'user' } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, tree: res.data });
});
