import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

// 프로바이더별 Vault 키
const PROVIDER_KEYS = {
  openai_api_key: 'OPENAI_API_KEY',
  gemini_api_key: 'GEMINI_API_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  google_service_account_json: 'GOOGLE_SERVICE_ACCOUNT_JSON',
} as const;

type ProviderField = keyof typeof PROVIDER_KEYS;

function maskKey(key: string | null): { hasKey: boolean; maskedKey: string } {
  if (!key) return { hasKey: false, maskedKey: '' };
  if (key.length > 10) return { hasKey: true, maskedKey: `${key.substring(0, 4)}...${key.substring(key.length - 4)}` };
  return { hasKey: true, maskedKey: '***' };
}

// 프로바이더 키 현황 조회 (OpenAI / Gemini / Anthropic)
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const core = getCore();
    const keys: Record<string, { hasKey: boolean; maskedKey: string }> = {};
    for (const [field, vaultKey] of Object.entries(PROVIDER_KEYS)) {
      keys[field] = maskKey(core.getGeminiKey(vaultKey));
    }
    return NextResponse.json({ success: true, keys });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// 프로바이더 키 저장 — body: { provider?: 'openai'|'gemini'|'anthropic', apiKey }
// provider 생략 시 OpenAI (기존 호환)
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { apiKey, provider } = await req.json();
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'apiKey field is required' }, { status: 400 });
    }
    // Vertex는 API 키 대신 Service Account JSON 사용
    const field: ProviderField = provider === 'vertex'
      ? 'google_service_account_json'
      : provider
        ? (`${provider}_api_key` as ProviderField)
        : 'openai_api_key';
    const vaultKey = PROVIDER_KEYS[field];
    if (!vaultKey) {
      return NextResponse.json({ success: false, error: `Unknown provider: ${provider}` }, { status: 400 });
    }

    const core = getCore();
    const saved = core.setGeminiKey(vaultKey, apiKey);
    return saved
      ? NextResponse.json({ success: true })
      : NextResponse.json({ success: false, error: 'Database save failed' }, { status: 500 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
