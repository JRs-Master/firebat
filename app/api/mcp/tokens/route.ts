/**
 * MCP 토큰 관리 API
 *
 * GET    /api/mcp/tokens — 토큰 정보 조회 (마스킹)
 * POST   /api/mcp/tokens — 새 토큰 생성 (원본 1회 반환)
 * DELETE /api/mcp/tokens — 토큰 폐기
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/** 토큰 정보 조회 (마스킹된 힌트 + 생성일) */
export async function GET() {
  const core = getCore();
  const info = core.getMcpTokenInfo();
  return NextResponse.json({ success: true, ...info });
}

/** 새 토큰 생성 — 기존 토큰 무효화, 원본은 이 응답에서만 노출 */
export async function POST() {
  const core = getCore();
  const token = core.generateMcpToken();
  const info = core.getMcpTokenInfo();
  return NextResponse.json({
    success: true,
    token, // 원본 — 이 응답에서만 1회 노출
    hint: info.hint,
    createdAt: info.createdAt,
  });
}

/** 토큰 폐기 */
export async function DELETE() {
  const core = getCore();
  core.revokeMcpToken();
  return NextResponse.json({ success: true });
}
