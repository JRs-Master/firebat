import { NextRequest, NextResponse } from 'next/server';
import { read as readMedia } from '../../../../lib/api-gen/media';

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

    const res = await readMedia({ value: slug });
    if (!res.ok) return new NextResponse(res.message || '서버 오류', { status: 500 });
    const payload = res.data;
    if (!payload || !payload.binaryBase64) return new NextResponse('Not found', { status: 404 });
    // scope 검증 — /system/media/ URL 로 user scope 파일 요청 시 404
    if (payload.record?.scope && payload.record.scope !== 'system') {
      return new NextResponse('Not found', { status: 404 });
    }

    const binary = Buffer.from(payload.binaryBase64, 'base64');
    const uint8 = new Uint8Array(binary);
    return new NextResponse(uint8, {
      status: 200,
      headers: {
        'Content-Type': payload.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(binary.length),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(msg, { status: 500 });
  }
}
