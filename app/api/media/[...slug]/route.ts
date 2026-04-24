import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/**
 * GET /api/media/<slug>.<ext> — IMediaPort 로 저장된 이미지 공개 서빙.
 *
 * 인증 불필요 (블로그 포스팅 등에서 외부 공개 가능해야 함).
 * 공유 페이지·OG 이미지·render_image 모두 이 경로로 접근.
 *
 * 파일명: "<slug>.<ext>" 형태 (예: "lx9a2p1f-a3c2.png")
 * 경로 파라미터가 catch-all (`[...slug]`) 이라 slash 포함 요청 차단은 adapter 측에서.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  try {
    const { slug: segments } = await params;
    const filename = segments?.[0] ?? '';
    if (!filename) return new NextResponse('Not found', { status: 404 });
    // "slug.ext" 분리 — 확장자 버리고 adapter 는 slug 만 사용 (meta JSON 에 ext 보유)
    const dotIdx = filename.lastIndexOf('.');
    const slug = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;

    const core = getCore();
    const res = await core.readMedia(slug);
    if (!res.success) return new NextResponse(res.error || '서버 오류', { status: 500 });
    if (!res.data) return new NextResponse('Not found', { status: 404 });

    const { binary, contentType } = res.data;
    const uint8 = new Uint8Array(binary);
    return new NextResponse(uint8, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // 서버 저장 파일은 slug 자체가 immutable → 긴 캐시
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(binary.length),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(msg, { status: 500 });
  }
}
