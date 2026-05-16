import { NextResponse } from 'next/server';
import { getSystemModules } from '../../../../lib/api-gen/module';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const res = await getSystemModules();
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, modules: res.data ?? [] });
});
