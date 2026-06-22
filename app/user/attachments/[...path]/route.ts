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
  req: NextRequest,
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
  const total = buf.length;
  // .lrc.json 정렬 사이드카 = 가변 메타데이터(오디오 생성 후 재정렬 가능) → 캐시 금지로 항상 최신.
  // 오디오(.wav 등)는 불변이라 30일 캐시 유지.
  const fname = path[path.length - 1];
  const mutable = fname.endsWith('.lrc.json');
  const baseHeaders: Record<string, string> = {
    'Content-Type': res.data.contentType || 'application/octet-stream',
    'Cache-Control': mutable ? 'no-store' : 'public, max-age=2592000',
    // 오디오/비디오 seek(시간바 이동) 필수 — 브라우저가 Range 요청으로 특정 시각 바이트를 가져옴.
    'Accept-Ranges': 'bytes',
  };

  // HTTP Range — 미디어 seek. 없으면 currentTime 점프가 안 먹어 재생·스크립트가 안 따라감.
  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      return new NextResponse('Range Not Satisfiable', {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
      });
    }
    const chunk = buf.subarray(start, end + 1);
    return new NextResponse(chunk, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(chunk.length),
      },
    });
  }

  return new NextResponse(buf, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(total) },
  });
}
