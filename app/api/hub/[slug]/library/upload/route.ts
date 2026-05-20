import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { uploadSource, listReferences } from '../../../../../../lib/api-gen/library';
import { authenticate } from '../../../../../../lib/api-gen/hub';
import { logger } from '../../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/library/upload — 익명 hub 방문자의 파일 업로드 (PDF / TXT / MD).
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
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';

  if (!apiToken) return jsonResponse(401, { error: 'X-Api-Token 헤더가 필요합니다.' });
  if (!sessionId) return jsonResponse(400, { error: 'X-Session-Id 헤더가 필요합니다.' });

  const authRes = await authenticate({ slug, apiToken, origin, selfHost });
  if (!authRes.ok) {
    const msg = authRes.message ?? '인증 실패';
    if (msg.includes('UNAUTHORIZED_ORIGIN:')) {
      return jsonResponse(403, { error: '허용되지 않은 도메인입니다.' });
    }
    return jsonResponse(401, { error: msg });
  }
  const instance = authRes.data?.instance;
  if (!instance) return jsonResponse(500, { error: 'instance 조회 실패' });
  // visitor 별 격리 — `hub:<instance_id>:<session_id>` 형태.
  const hubOwner = `hub:${instance.id}:${sessionId}`;

  const form = await req.formData().catch(() => null);
  if (!form) return jsonResponse(400, { error: 'multipart/form-data 필요' });

  const file = form.get('file');
  const referenceId = String(form.get('referenceId') ?? '').trim();
  const sourceType = String(form.get('sourceType') ?? '').trim().toLowerCase();
  let name = String(form.get('name') ?? '').trim();

  if (!(file instanceof File)) return jsonResponse(400, { error: 'file 필드가 필요합니다.' });
  if (!referenceId) return jsonResponse(400, { error: 'referenceId 필드가 필요합니다.' });
  if (!['pdf', 'txt', 'md'].includes(sourceType)) {
    return jsonResponse(400, { error: `지원되지 않는 sourceType: ${sourceType}` });
  }
  if (!name) name = file.name || `source-${Date.now()}.${sourceType}`;

  // referenceId 가 본 hub owner 안에 있는지 가드 — 다른 hub 자료에 업로드 차단.
  const refList = await listReferences({ owner: hubOwner });
  if (!refList.ok) return jsonResponse(500, { error: refList.message });
  if (!(refList.data ?? []).some(r => r.id === referenceId)) {
    return jsonResponse(403, { error: '이 reference 에 업로드할 권한이 없습니다.' });
  }

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
    });
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
