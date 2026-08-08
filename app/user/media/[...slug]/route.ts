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
    // <slug>.meta.json — 생성 상태 조회(status: rendering/done/error). ImageComp 가 "생성 중"
    // 카드와 완료 스왑을 이걸로 판정한다 (async image_gen 은 placeholder 를 실제 URL 에 먼저
    // 저장하므로 이미지 로드 성공/실패로는 생성 중임을 알 수 없다 — 2026-08-09 실측).
    const isMeta = filename.endsWith('.meta.json');
    const base = isMeta ? filename.slice(0, -'.meta.json'.length) : filename;
    const dotIdx = base.lastIndexOf('.');
    const slug = dotIdx > 0 ? base.slice(0, dotIdx) : base;

    const res = await readMedia({ slug: slug });
    if (!res.ok) return new NextResponse(res.message || '서버 오류', { status: 500 });
    const payload = res.data;
    if (!payload || !payload.binaryBase64) return new NextResponse('Not found', { status: 404 });
    // scope 검증 — /user/media/ URL 로 system scope 파일 요청 시 404
    if (payload.record?.scope && payload.record.scope !== 'user') {
      return new NextResponse('Not found', { status: 404 });
    }
    const status = (payload.record as { status?: string } | undefined)?.status;
    if (isMeta) {
      return NextResponse.json(payload.record ?? { slug }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const binary = Buffer.from(payload.binaryBase64, 'base64');
    const uint8 = new Uint8Array(binary);
    return new NextResponse(uint8, {
      status: 200,
      headers: {
        'Content-Type': payload.contentType,
        // 생성 중 placeholder 를 immutable 로 내보내면 브라우저가 회색을 1년짜리로 캐시해
        // 완료 스왑이 영영 안 보인다 — done 전에는 no-store.
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
