import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/**
 * GET /user/media/<slug>.<ext> — 유저 AI 생성 이미지 공개 서빙.
 *
 * 프로덕션에선 nginx 가 가로채 /root/firebat/user/media/ 에서 직접 서빙 (Node 우회).
 * 이 handler 는 dev 환경 + nginx 미설정 fallback.
 *
 * nginx 예:
 *   location /user/media/ {
 *     alias /root/firebat/user/media/;
 *     expires 1y;
 *     add_header Cache-Control "public, immutable";
 *   }
 *
 * 인증 불필요 — 블로그·OG·공유 페이지에서 익명 접근. slug 는 crypto.randomBytes
 * 기반 hex 라 URL 알면 접근 가능한 obscurity 보안.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  try {
    const { slug: segments } = await params;
    const filename = segments?.[segments.length - 1] ?? '';
    if (!filename) return new NextResponse('Not found', { status: 404 });
    const dotIdx = filename.lastIndexOf('.');
    const slug = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;

    const core = getCore();
    const res = await core.readMedia(slug);
    if (!res.success) return new NextResponse(res.error || '서버 오류', { status: 500 });
    if (!res.data) return new NextResponse('Not found', { status: 404 });
    // scope 검증 — /user/media/ URL 로 system scope 파일 요청 시 404
    if (res.data.record.scope && res.data.record.scope !== 'user') {
      return new NextResponse('Not found', { status: 404 });
    }

    const { binary, contentType } = res.data;
    const uint8 = new Uint8Array(binary);
    return new NextResponse(uint8, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(binary.length),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(msg, { status: 500 });
  }
}
