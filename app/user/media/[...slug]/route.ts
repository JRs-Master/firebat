import { NextRequest, NextResponse } from 'next/server';
import { read as readMedia } from '../../../../lib/api-gen/media';

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
    // <slug>.meta.json — generation status lookup (status: rendering/done/error). ImageComp
    // decides the generating card and the completion swap with this: async image_gen saves the
    // placeholder at the real URL first, so image load success/failure cannot tell "generating"
    // apart (measured 2026-08-09).
    const isMeta = filename.endsWith('.meta.json');
    const base = isMeta ? filename.slice(0, -'.meta.json'.length) : filename;
    const dotIdx = base.lastIndexOf('.');
    const slug = dotIdx > 0 ? base.slice(0, dotIdx) : base;

    const res = await readMedia({ slug: slug });
    if (!res.ok) return new NextResponse(res.message || '서버 오류', { status: 500 });
    const payload = res.data;
    if (!payload) return new NextResponse('Not found', { status: 404 });
    // scope 검증 — /user/media/ URL 로 system scope 파일 요청 시 404
    if (payload.record?.scope && payload.record.scope !== 'user') {
      return new NextResponse('Not found', { status: 404 });
    }
    const status = (payload.record as { status?: string } | undefined)?.status;
    if (isMeta) {
      // Meta must not require the binary: a failed generation can have a record and NO file
      // (measured 2026-08-09 — three error records whose meta 404'd here, so the client could
      // never learn "failed" and spun its retry loop instead).
      if (!payload.record) return new NextResponse('Not found', { status: 404 });
      return NextResponse.json(payload.record, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (!payload.binaryBase64) return new NextResponse('Not found', { status: 404 });

    const binary = Buffer.from(payload.binaryBase64, 'base64');
    const uint8 = new Uint8Array(binary);
    return new NextResponse(uint8, {
      status: 200,
      headers: {
        'Content-Type': payload.contentType,
        // Serving the mid-generation placeholder as immutable lets the browser cache the grey
        // for a year and the completion swap never shows — no-store until done.
        'Cache-Control':
          status && status !== 'done'
            ? 'no-store'
            : 'public, max-age=31536000, immutable',
        'Content-Length': String(binary.length),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(msg, { status: 500 });
  }
}
