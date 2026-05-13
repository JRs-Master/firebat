import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';
import { ApiError } from '../../../../lib/api-error';

/**
 * POST /api/module/run
 * Form bindModule 전용 — LLM 우회, Core를 통한 모듈 직접 실행
 */
export const POST = withAuth(async (req) => {
  const { module: moduleName, data } = await req.json();
  if (!moduleName || typeof moduleName !== 'string') {
    throw new ApiError(400, '모듈 이름이 필요합니다.');
  }
  const result = await getCore().runModule(moduleName, data ?? {});
  return NextResponse.json(result, { status: result.success ? 200 : 400 });
});
