import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';

function isDemo(req: NextRequest) {
  return req.cookies.get('firebat_admin_token')?.value === 'demo';
}

const KEY_MAP: Record<string, string> = {
  vertex_api_key:  'VERTEX_AI_API_KEY',
  vertex_project:  'VERTEX_AI_PROJECT',
  vertex_location: 'VERTEX_AI_LOCATION',
};

function maskKey(key: string | null): { hasKey: boolean; maskedKey: string } {
  if (!key) return { hasKey: false, maskedKey: '' };
  if (key.length > 10) return { hasKey: true, maskedKey: `${key.substring(0, 4)}...${key.substring(key.length - 4)}` };
  return { hasKey: true, maskedKey: '***' };
}

const PLAIN_KEYS = new Set(['vertex_location', 'vertex_project']);

// Vertex AI 키 현황 조회
export async function GET() {
  try {
    const core = getCore();
    const keys: Record<string, { hasKey: boolean; maskedKey: string }> = {};
    for (const [alias, secretKey] of Object.entries(KEY_MAP)) {
      const value = core.getVertexKey(secretKey);
      keys[alias] = PLAIN_KEYS.has(alias)
        ? { hasKey: !!value, maskedKey: value ?? '' }
        : maskKey(value);
    }
    return NextResponse.json({ success: true, keys });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Vertex AI 키 저장
export async function POST(req: NextRequest) {
  if (isDemo(req)) {
    return NextResponse.json({ success: false, error: '데모 모드에서는 설정을 변경할 수 없습니다.' }, { status: 403 });
  }
  try {
    const { provider, apiKey } = await req.json();

    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'apiKey field is required' }, { status: 400 });
    }

    const secretKey = KEY_MAP[provider];
    if (!secretKey) {
      return NextResponse.json({ success: false, error: `Unknown key: ${provider}` }, { status: 400 });
    }

    const core = getCore();
    const saved = core.setVertexKey(secretKey, apiKey);
    return saved
      ? NextResponse.json({ success: true })
      : NextResponse.json({ success: false, error: 'Database save failed' }, { status: 500 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
