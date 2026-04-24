import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/**
 * GET /system/media/<slug>.<ext> — Firebat 내부 생성 이미지 (OG 캐시·모듈 자산 등) 서빙.
 *
 * 프로덕션에선 nginx 가 가로채 /root/firebat/system/media/ 에서 직접 서빙.
 *
 * nginx 예:
 *   location /system/media/ {
 *     alias /root/firebat/system/media/;
 *     expires 1y;
 *   }
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
    // scope 검증 — /system/media/ URL 로 user scope 파일 요청 시 404
    if (res.data.record.scope && res.data.record.scope !== 'system') {
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
