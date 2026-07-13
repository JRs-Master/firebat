import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../lib/with-api-error';
import { getGeminiKey, setGeminiKey } from '../../../lib/api-gen/secret';

// 프로바이더별 Vault 키 — **model config(system/llm/models.json)의 apiKeyVaultKey 와 동일 키(단일 소스)**.
// 어댑터(fetch_api_key)가 이 콜론키를 읽으므로 저장·읽기가 여기서 연결된다. 옛 언더스코어키
// (OPENAI_API_KEY 등)는 어댑터가 안 읽어 UI 로 넣은 키가 무시되던 disconnect 를 정정(2026-07-05).
const PROVIDER_KEYS = {
  openai_api_key: 'system:openai:api-key',
  gemini_api_key: 'system:gemini:api-key',
  anthropic_api_key: 'system:anthropic:api-key',
  google_service_account_json: 'system:vertex:service-account-json',
  upstage_api_key: 'system:upstage:api-key',
} as const;

type ProviderField = keyof typeof PROVIDER_KEYS;

function maskKey(key: string | null): { hasKey: boolean; maskedKey: string } {
  if (!key) return { hasKey: false, maskedKey: '' };
  if (key.length > 10) return { hasKey: true, maskedKey: `${key.substring(0, 4)}...${key.substring(key.length - 4)}` };
  return { hasKey: true, maskedKey: '***' };
}

// 레거시 언더스코어 키 — 옛 UI/모듈이 저장하던 이름. TTS 등 first_secret 소비자는 양쪽을 다
// 읽어 동작하는데 이 GET 은 콜론 키만 봐서 "키가 있는데 빈 칸"으로 표시되던 것(2026-07-13 실측:
// TTS 용 GEMINI_API_KEY 등록분이 LLM 탭·파싱 게이트에서 미인식). 발견 시 콜론 키로 자가 이관
// (write-through) — 어댑터(fetch_api_key)·표시·게이트가 단일 키로 수렴.
const LEGACY_KEYS: Partial<Record<ProviderField, string[]>> = {
  openai_api_key: ['OPENAI_API_KEY'],
  gemini_api_key: ['GEMINI_API_KEY'],
  anthropic_api_key: ['ANTHROPIC_API_KEY'],
  upstage_api_key: ['UPSTAGE_API_KEY'],
};

// 프로바이더 키 현황 조회 (OpenAI / Gemini / Anthropic / Upstage / Vertex)
export const GET = withAuth(async () => {
  const keys: Record<string, { hasKey: boolean; maskedKey: string }> = {};
  const entries = Object.entries(PROVIDER_KEYS) as Array<[ProviderField, string]>;
  const values = await Promise.all(entries.map(([, vaultKey]) => getGeminiKey({ key: vaultKey })));
  await Promise.all(entries.map(async ([field, vaultKey], i) => {
    const v = values[i];
    let raw = v && v.ok ? v.data : null;
    if (!raw) {
      for (const legacy of LEGACY_KEYS[field] ?? []) {
        const lv = await getGeminiKey({ key: legacy });
        if (lv.ok && lv.data) {
          raw = lv.data;
          // self-migrate to the canonical colon key (adapters only read that one)
          await setGeminiKey({ key: vaultKey, value: lv.data }).catch(() => {});
          break;
        }
      }
    }
    keys[field] = maskKey(raw ?? null);
  }));
  return NextResponse.json({ success: true, keys });
});

// 프로바이더 키 저장 — body: { provider?: 'openai'|'gemini'|'anthropic', apiKey }
// provider 생략 시 OpenAI (기존 호환)
export const POST = withAuth(async (req: NextRequest) => {
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

  const res = await setGeminiKey({ key: vaultKey, value: apiKey });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message || 'Database save failed' }, { status: 500 });
});
