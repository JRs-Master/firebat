import { NextRequest, NextResponse } from 'next/server';
import { readTempAttachment, readConvAttachment } from '../../../../lib/api-gen/media';

/**
 * GET /user/attachments/<filename>          — flat 업로드 첨부(이미지). 30일 retention cron cleanup.
 * GET /user/attachments/<conv>/<filename>   — conv-scoped 미디어(TTS 오디오 등). 대화와 함께 살고
 *                                             대화 영구삭제 시 cascade. 30일 cleanup 대상 아님.
 *
 * 인증 불필요 — LLM API / 브라우저가 외부에서 fetch 가능해야 함 (slug = random hex 라 URL obscurity).
 * 프로덕션에서는 nginx 가 가로채 직접 서빙 가능. 이 handler 는 dev + nginx 미설정 fallback.
 * path traversal 가드는 Rust adapter(sanitize_path_seg) 안.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  if (!path || path.length === 0) return new NextResponse('Not found', { status: 404 });

  const res =
    path.length >= 2
      ? await readConvAttachment({ conv: path[0], name: path[1] })
      : await readTempAttachment({ filename: path[0] });
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
      'Cache-Control': 'public, max-age=2592000',
      'Content-Length': String(buf.length),
    },
  });
}
