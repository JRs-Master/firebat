/**
 * 내부 MCP 토큰 관리 (LLM 통신용)
 * GET:    토큰 현황 조회 (마스킹)
 * POST:   새 토큰 생성 (기존 토큰 폐기)
 * DELETE: 토큰 폐기
 */
import { NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { VK_INTERNAL_MCP_TOKEN as TOKEN_KEY, VK_INTERNAL_MCP_TOKEN_CREATED as CREATED_KEY } from '../../../../lib/proto-gen/vault-keys';
import { getGeminiKey, setGeminiKey } from '../../../../lib/api-gen/secret';

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'fbm_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function maskToken(token: string | null): { hasToken: boolean; masked: string } {
  if (!token) return { hasToken: false, masked: '' };
  return { hasToken: true, masked: `${token.slice(0, 8)}****${token.slice(-4)}` };
}

export const GET = withAuth(async () => {
  const [tokenRes, createdRes] = await Promise.all([
    getGeminiKey({ value: TOKEN_KEY }),
    getGeminiKey({ value: CREATED_KEY }),
  ]);
  const token = tokenRes.ok ? tokenRes.data : null;
  const created = createdRes.ok ? createdRes.data : null;
  return NextResponse.json({
    success: true,
    token: maskToken(token),
    createdAt: created,
  });
});

export const POST = withAuth(async () => {
  const token = generateToken();
  const now = new Date().toISOString();
  await setGeminiKey({ key: TOKEN_KEY, value: token });
  await setGeminiKey({ key: CREATED_KEY, value: now });
  return NextResponse.json({ success: true, token, createdAt: now });
});

export const DELETE = withAuth(async () => {
  // secret 삭제는 vault 직접 호출 필요 — setGeminiKey로는 덮어쓰기만
  await setGeminiKey({ key: TOKEN_KEY, value: '' });
  await setGeminiKey({ key: CREATED_KEY, value: '' });
  return NextResponse.json({ success: true });
});
