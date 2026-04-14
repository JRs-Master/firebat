import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const result = await getCore().getPage(slug);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 404 });
  }
  return NextResponse.json({ success: true, spec: result.data });
}
