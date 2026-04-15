/**
 * API 토큰 관리 (MCP 등)
 *
 * GET    /api/mcp/tokens — 토큰 정보 조회 (마스킹)
 * POST   /api/mcp/tokens — 새 토큰 생성 (원본 1회 반환)
 * DELETE /api/mcp/tokens — 토큰 폐기
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/** 토큰 정보 조회 (마스킹된 힌트 + 생성일) */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const core = getCore();
  const info = core.getApiTokenInfo();
  return NextResponse.json({ success: true, ...info });
}

/** 새 토큰 생성 — 기존 토큰 무효화, 원본은 이 응답에서만 노출 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const core = getCore();
  const token = core.generateApiToken('MCP API');
  const info = core.getApiTokenInfo();
  return NextResponse.json({
    success: true,
    token, // 원본 — 이 응답에서만 1회 노출
    hint: info.hint,
    createdAt: info.createdAt,
  });
}

/** 토큰 폐기 */
export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const core = getCore();
  core.revokeApiTokens();
  return NextResponse.json({ success: true });
}
