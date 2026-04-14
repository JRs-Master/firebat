import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

export async function POST(req: NextRequest) {
  try {
    const { code, language, instruction, selectedCode, config } = await req.json();
    if (!instruction?.trim()) {
      return NextResponse.json({ success: false, error: '지시사항을 입력해주세요.' }, { status: 400 });
    }

    const core = getCore();
    const result = await core.codeAssist({ code, language, instruction, selectedCode }, { model: config?.model });

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ success: true, suggestion: result.data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
