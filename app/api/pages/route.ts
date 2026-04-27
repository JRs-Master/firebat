import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const result = await getCore().listPages();
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, pages: result.data });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { slug, spec } = await req.json();
    if (!slug || !spec) {
      return NextResponse.json({ success: false, error: 'slug와 spec이 필요합니다.' }, { status: 400 });
    }

    const specStr = typeof spec === 'string' ? spec : JSON.stringify(spec);
    const result = await getCore().savePage(slug, specStr);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { slug, spec } = await req.json();
    if (!slug || !spec) {
      return NextResponse.json({ success: false, error: 'slug와 spec이 필요합니다.' }, { status: 400 });
    }

    const specStr = typeof spec === 'string' ? spec : JSON.stringify(spec);
    // REST PUT semantic = update/replace. 어드민이 모나코 에디터 등으로 명시적으로
    // "이 페이지 수정" 의도라 덮어쓰기 default true. (AI 의 save_page tool 은
    // allowOverwrite=false default 유지 — 실수성 덮어쓰기 차단, -N 접미사 자동.)
    const result = await getCore().savePage(slug, specStr, { allowOverwrite: true });
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ success: false, error: 'slug 파라미터가 필요합니다.' }, { status: 400 });
  }

  const result = await getCore().deletePage(slug);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
