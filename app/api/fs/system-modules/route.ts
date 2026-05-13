import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const modules = await getCore().getSystemModules();
  return NextResponse.json({ success: true, modules });
});
