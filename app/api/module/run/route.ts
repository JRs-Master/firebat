import { NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { ApiError } from '../../../../lib/api-error';
import { runModule } from '../../../../lib/api-gen/module';

/**
 * POST /api/module/run
 * Form bindModule 전용 — LLM 우회, Core를 통한 모듈 직접 실행
 */
export const POST = withAuth(async (req) => {
  const { module: moduleName, data } = await req.json();
  if (!moduleName || typeof moduleName !== 'string') {
    throw new ApiError(400, '모듈 이름이 필요합니다.');
  }
  const res = await runModule({ module: moduleName, dataJson: JSON.stringify(data ?? {}) });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  const out = res.data;
  const parsedData = out.dataJson ? JSON.parse(out.dataJson) : undefined;
  return NextResponse.json(
    { success: out.success, data: parsedData, error: out.error, stderr: out.stderr, exitCode: out.exitCode },
    { status: out.success ? 200 : 400 },
  );
});
