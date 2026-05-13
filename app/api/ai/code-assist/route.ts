import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

export const POST = withAuth(async (req: NextRequest) => {
  const { code, language, instruction, selectedCode, config } = await req.json();
  if (!instruction?.trim()) {
    return NextResponse.json({ success: false, error: '지시사항을 입력해주세요.' }, { status: 400 });
  }

  const result = await getCore().codeAssist(
    { code, language, instruction, selectedCode },
    { model: config?.model, thinkingLevel: config?.thinkingLevel },
  );

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, suggestion: result.data });
});
