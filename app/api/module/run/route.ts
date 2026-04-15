import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * POST /api/module/run
 * Form bindModule 전용 — LLM 우회, Core를 통한 모듈 직접 실행
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { module: moduleName, data } = await req.json();
    if (!moduleName || typeof moduleName !== 'string') {
      return NextResponse.json({ success: false, error: '모듈 이름이 필요합니다.' }, { status: 400 });
    }

    const result = await getCore().runModule(moduleName, data ?? {});
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: `서버 오류: ${err.message}` }, { status: 500 });
  }
}
