/**
 * API 토큰 관리 (MCP 등)
 *
 * GET    /api/mcp/tokens — 토큰 정보 조회 (마스킹)
 * POST   /api/mcp/tokens — 새 토큰 생성 (원본 1회 반환)
 * DELETE /api/mcp/tokens — 토큰 폐기
 */
import { NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getApiTokenInfo, generateApiToken, revokeApiTokens } from '../../../../lib/api-gen/auth';

/** 토큰 정보 조회 (마스킹된 힌트 + 생성일) */
export const GET = withAuth(async () => {
  const res = await getApiTokenInfo();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, ...res.data });
});

/** 새 토큰 생성 — 기존 토큰 무효화, 원본은 이 응답에서만 노출 */
export const POST = withAuth(async () => {
  const tokenRes = await generateApiToken({ label: 'MCP API' });
  if (!tokenRes.ok) {
    return NextResponse.json({ success: false, error: tokenRes.message }, { status: 500 });
  }
  const infoRes = await getApiTokenInfo();
  if (!infoRes.ok) {
    return NextResponse.json({ success: false, error: infoRes.message }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    token: tokenRes.data, // 원본 — 이 응답에서만 1회 노출
    hint: infoRes.data.hint,
    createdAt: infoRes.data.createdAt,
  });
});

/** 토큰 폐기 */
export const DELETE = withAuth(async () => {
  const res = await revokeApiTokens();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});
