import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

// OpenAI API 키 (Vault 내부 키: OPENAI_API_KEY)
const OPENAI_KEY = 'OPENAI_API_KEY';

function maskKey(key: string | null): { hasKey: boolean; maskedKey: string } {
  if (!key) return { hasKey: false, maskedKey: '' };
  if (key.length > 10) return { hasKey: true, maskedKey: `${key.substring(0, 4)}...${key.substring(key.length - 4)}` };
  return { hasKey: true, maskedKey: '***' };
}

// OpenAI 키 현황 조회
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const core = getCore();
    const value = core.getGeminiKey(OPENAI_KEY);
    return NextResponse.json({ success: true, keys: { openai_api_key: maskKey(value) } });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// OpenAI 키 저장
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드에서는 설정을 변경할 수 없습니다.' }, { status: 403 });
  }
  try {
    const { apiKey } = await req.json();
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'apiKey field is required' }, { status: 400 });
    }

    const core = getCore();
    const saved = core.setGeminiKey(OPENAI_KEY, apiKey);
    return saved
      ? NextResponse.json({ success: true })
      : NextResponse.json({ success: false, error: 'Database save failed' }, { status: 500 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
