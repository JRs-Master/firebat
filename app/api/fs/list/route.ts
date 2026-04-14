import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

export async function GET() {
  const tree = await getCore().getFileTree('user');
  return NextResponse.json({ success: true, tree });
}
