import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { uploadSource } from '../../../../lib/api-gen/library';
import { withAuth } from '../../../../lib/with-api-error';
import { logger } from '../../../../lib/util/logger';

/**
 * POST /api/library/upload-and-extract
 *
 * Library Source 파일 업로드 (PDF / TXT / MD) 전용.
 * multipart/form-data 받아서 서버 임시 디스크 저장 → UploadSource RPC 호출 (extractor 가
 * file_path 영역 read) → 임시 파일 즉시 삭제.
 *
 * 직접 입력 영역 (source_type='text') / URL 영역 (Phase 1.5) 은 client 에서 uploadSource()
 * 직접 호출. 이 endpoint 는 binary 파일 전용.
 *
 * form-data:
 *   - file: 파일 (binary)
 *   - referenceId: string
 *   - name: string (옵션 — 없으면 파일명)
 *   - sourceType: 'pdf' | 'txt' | 'md'
 *
 * 응답: { success: true, data: { sourceId, chunkCount } }
 */
export const POST = withAuth(async (req: NextRequest) => {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ success: false, error: 'multipart/form-data 필요합니다.' }, { status: 400 });
  }

  const file = form.get('file');
  const referenceId = String(form.get('referenceId') ?? '').trim();
  const sourceType = String(form.get('sourceType') ?? '').trim().toLowerCase();
  let name = String(form.get('name') ?? '').trim();
  // 정밀 추출(vision) — 수동 opt-in (pdf 전용). quality_boost = Gemini Pro, 아니면 Flash.
  const precise = String(form.get('precise') ?? '') === 'true';
  const qualityBoost = String(form.get('qualityBoost') ?? '') === 'true';
  // 파싱 프로바이더 — "" 레거시(precise 그대로) / "none" 로컬 강제 / "solar" Upstage DP / "gemini" vision.
  const parseProviderRaw = String(form.get('parseProvider') ?? '');
  const parseProvider = ['none', 'solar', 'gemini'].includes(parseProviderRaw) ? parseProviderRaw : '';

  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: 'file 필드가 필요합니다.' }, { status: 400 });
  }
  if (!referenceId) {
    return NextResponse.json({ success: false, error: 'referenceId 필드가 필요합니다.' }, { status: 400 });
  }
  // 지원 포맷 검증은 Rust dispatch(grpc/library.rs)가 단일 권위 — unknown → invalid_argument.
  // 포맷 리스트를 route/Rust/프론트 여러 곳에 두면 drift (hub route 가 실제로 뒤처졌던 사례). 존재만 확인.
  if (!sourceType) {
    return NextResponse.json({ success: false, error: 'sourceType 필드가 필요합니다.' }, { status: 400 });
  }
  if (!name) name = file.name || `source-${Date.now()}.${sourceType}`;

  const dir = path.join(tmpdir(), 'firebat-library');
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
      precise,
      qualityBoost,
      parseProvider,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message ?? 'UploadSource 실패' }, { status: 500 });
    }
    return NextResponse.json({
      success: true,
      data: {
        sourceId: result.data.sourceId,
        chunkCount: Number(result.data.chunkCount),
        deduped: !!result.data.deduped,
      },
    });
  } finally {
    await unlink(tmpPath).catch(e => logger.debug('library', 'temp 파일 삭제 실패', { tmpPath, error: e }));
  }
});
