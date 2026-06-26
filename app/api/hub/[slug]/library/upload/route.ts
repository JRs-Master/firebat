import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { uploadSource } from '../../../../../../lib/api-gen/library';
import { resolvePrincipal, isPrincipalError } from '../../../../../../lib/principal';
import { logger } from '../../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/library/upload — 익명 hub 방문자의 파일 업로드 (지원 포맷은 Rust dispatch 권위).
 *
 * admin /api/library/upload-and-extract 와 동등 흐름 — X-Api-Token + X-Session-Id 인증 +
 * referenceId 가 hub-scoped owner 인지 가드.
 *
 * form-data:
 *   - file: 파일
 *   - referenceId: string
 *   - name: string
 *   - sourceType: 'pdf' | 'txt' | 'md'
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;
  const hubOwner = principal.owner;

  const form = await req.formData().catch(() => null);
  if (!form) return jsonResponse(400, { error: 'multipart/form-data 필요' });

  const file = form.get('file');
  const referenceId = String(form.get('referenceId') ?? '').trim();
  const sourceType = String(form.get('sourceType') ?? '').trim().toLowerCase();
  let name = String(form.get('name') ?? '').trim();

  if (!(file instanceof File)) return jsonResponse(400, { error: 'file 필드가 필요합니다.' });
  if (!referenceId) return jsonResponse(400, { error: 'referenceId 필드가 필요합니다.' });
  // 지원 포맷은 Rust dispatch 가 단일 권위 (unknown → invalid_argument). 존재만 확인 (drift 방지).
  if (!sourceType) {
    return jsonResponse(400, { error: 'sourceType 필드가 필요합니다.' });
  }
  if (!name) name = file.name || `source-${Date.now()}.${sourceType}`;

  // reference owner scoping 은 Rust core(LibraryService.upload_source)가 강제 — owner=hubOwner 전달 시 미소유 거부. 프론트 가드 폐기.
  const dir = path.join(tmpdir(), 'firebat-library-hub');
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `${randomUUID()}.${sourceType}`);
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(tmpPath, buf);

  try {
    const result = await uploadSource({
      referenceId,
      name,
      sourceType,
      filePath: tmpPath,
      owner: hubOwner,
    } as Parameters<typeof uploadSource>[0]);
    if (!result.ok) {
      return jsonResponse(500, { error: result.message ?? 'UploadSource 실패' });
    }
    return NextResponse.json({
      success: true,
      data: {
        sourceId: result.data.sourceId,
        chunkCount: Number(result.data.chunkCount),
      },
    });
  } finally {
    await unlink(tmpPath).catch(e => logger.debug('hub-library', 'temp 파일 삭제 실패', { tmpPath, error: e }));
  }
}

function jsonResponse(status: number, body: unknown) {
  return NextResponse.json(body, { status });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}
