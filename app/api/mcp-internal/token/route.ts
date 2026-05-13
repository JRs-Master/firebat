/**
 * 내부 MCP 토큰 관리 (LLM 통신용)
 * GET:    토큰 현황 조회 (마스킹)
 * POST:   새 토큰 생성 (기존 토큰 폐기)
 * DELETE: 토큰 폐기
 */
import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';
import { VK_INTERNAL_MCP_TOKEN as TOKEN_KEY, VK_INTERNAL_MCP_TOKEN_CREATED as CREATED_KEY } from '../../../../lib/proto-gen/vault-keys';

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
  const core = getCore();
  const [token, created] = await Promise.all([
    core.getGeminiKey(TOKEN_KEY),
    core.getGeminiKey(CREATED_KEY),
  ]);
  return NextResponse.json({
    success: true,
    token: maskToken(token),
    createdAt: created,
  });
});

export const POST = withAuth(async () => {
  const core = getCore();
  const token = generateToken();
  const now = new Date().toISOString();
  await core.setGeminiKey(TOKEN_KEY, token);
  await core.setGeminiKey(CREATED_KEY, now);
  return NextResponse.json({ success: true, token, createdAt: now });
});

export const DELETE = withAuth(async () => {
  const core = getCore();
  // secret 삭제는 vault 직접 호출 필요 — setGeminiKey로는 덮어쓰기만
  await core.setGeminiKey(TOKEN_KEY, '');
  await core.setGeminiKey(CREATED_KEY, '');
  return NextResponse.json({ success: true });
});
