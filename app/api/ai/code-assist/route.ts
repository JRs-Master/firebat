import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { codeAssist } from '../../../../lib/api-gen/ai';

export const POST = withAuth(async (req: NextRequest) => {
  const { code, language, instruction, selectedCode, config } = await req.json();
  if (!instruction?.trim()) {
    return NextResponse.json({ success: false, error: '지시사항을 입력해주세요.' }, { status: 400 });
  }

  const promptPayload = JSON.stringify({ code, language, instruction, selectedCode });
  const optsPayload = JSON.stringify({ model: config?.model, thinkingLevel: config?.thinkingLevel });

  const res = await codeAssist({
    prompt: promptPayload,
    opts: { optsJson: optsPayload },
  });

  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, suggestion: res.data });
});
