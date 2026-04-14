import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

export async function GET() {
  const modules = await getCore().getSystemModules();
  return NextResponse.json({ success: true, modules });
}
