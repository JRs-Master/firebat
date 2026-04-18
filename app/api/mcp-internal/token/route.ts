/**
 * 내부 MCP 토큰 관리 (LLM 통신용)
 * GET:    토큰 현황 조회 (마스킹)
 * POST:   새 토큰 생성 (기존 토큰 폐기)
 * DELETE: 토큰 폐기
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

const TOKEN_KEY = 'system:internal-mcp-token';
const CREATED_KEY = 'system:internal-mcp-token-created';

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'fbm_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function maskToken(token: string | null): { hasToken: boolean; masked: string } {
  if (!token) return { hasToken: false, masked: '' };
  return { hasToken: true, masked: `${token.slice(0, 8)}****${token.slice(-4)}` };
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const token = core.getGeminiKey(TOKEN_KEY);
  const created = core.getGeminiKey(CREATED_KEY);
  return NextResponse.json({
    success: true,
    token: maskToken(token),
    createdAt: created,
  });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드 불가' }, { status: 403 });
  }
  const core = getCore();
  const token = generateToken();
  const now = new Date().toISOString();
  core.setGeminiKey(TOKEN_KEY, token);
  core.setGeminiKey(CREATED_KEY, now);
  return NextResponse.json({ success: true, token, createdAt: now });
}

export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  if (auth.role === 'demo') {
    return NextResponse.json({ success: false, error: '데모 모드 불가' }, { status: 403 });
  }
  const core = getCore();
  // secret 삭제는 vault 직접 호출 필요 — setGeminiKey로는 덮어쓰기만
  core.setGeminiKey(TOKEN_KEY, '');
  core.setGeminiKey(CREATED_KEY, '');
  return NextResponse.json({ success: true });
}
