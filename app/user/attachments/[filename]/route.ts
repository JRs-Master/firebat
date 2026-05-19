import { NextRequest, NextResponse } from 'next/server';
import { readTempAttachment } from '../../../../lib/api-gen/media';

/**
 * GET /user/attachments/<filename> — 채팅 첨부 임시 이미지 서빙.
 *
 * 갤러리 (/user/media/) 와 분리 — 30일 retention internal cron 이 자동 cleanup.
 * 인증 불필요 — LLM API 가 외부에서 fetch 가능해야 함 (slug 영역 random hex 라 URL obscurity 보안).
 *
 * 프로덕션에서는 nginx 가 가로채 /root/firebat/user/attachments/ 에서 직접 서빙 가능.
 * 이 handler 는 dev 환경 + nginx 미설정 fallback.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  if (!filename) return new NextResponse('Not found', { status: 404 });

  const res = await readTempAttachment({ filename });
  if (!res.ok) return new NextResponse(res.message || '서버 오류', { status: 500 });
  if (!res.data?.found) return new NextResponse('Not found', { status: 404 });

  const binary = res.data.binary;
  // binary 가 codegen 산출 (Uint8Array 또는 base64 string) — 두 케이스 자동 처리.
  const buf = binary instanceof Uint8Array
    ? Buffer.from(binary)
    : Buffer.from(binary as unknown as string, 'base64');
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': res.data.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=2592000',  // 30일 retention 같이 align
      'Content-Length': String(buf.length),
    },
  });
}
