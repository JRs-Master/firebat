/**
 * Next.js API route handler wrappers — Phase 2 정공 (2026-05-13).
 *
 * 옛 산재된 requireAuth + isAuthError boilerplate (~54 routes) 통합 + try/catch 통합 + ApiError 자동 매핑.
 *
 * 사용 패턴:
 *
 *   // 인증 필요 — auth 자동 검증 + 에러 wrap
 *   export const GET = withAuth(async (req) => {
 *     const result = await savePage(args);
 *     if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 400 });
 *     return NextResponse.json({ success: true, ...result.data });
 *   });
 *
 *   // 공개 endpoint — 에러 wrap 만
 *   export const POST = withApiError(async (req) => {
 *     return NextResponse.json({ ok: true });
 *   });
 *
 * 효과:
 *  - throw 된 ApiError → toResponse() 자동 (status + userMessage)
 *  - gRPC ServiceError ({code, details}) → fromGrpcError 자동 매핑
 *  - 일반 Error → 500 + redactor 통과 메시지
 *  - NextResponse instance → 그대로 통과 (auth-guard 의 401 등)
 *  - withAuth: 인증 통과 후 handler 호출, 실패 시 401 NextResponse 자동 반환
 */
import type { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse } from './api-error';
import { requireAuth, isAuthError } from './auth-guard';
import type { AuthSession } from './types/firebat-types';
import { logger } from './util/logger';

type ApiResponse = NextResponse | Response;

type ApiHandler<TCtx = unknown> = (
  req: NextRequest,
  ctx: TCtx,
) => Promise<ApiResponse> | ApiResponse;

type AuthApiHandler<TCtx = unknown> = (
  req: NextRequest,
  ctx: TCtx,
  auth: AuthSession,
) => Promise<ApiResponse> | ApiResponse;

/** 에러 자동 wrap (auth 없음). 공개 endpoint 또는 인증 자체 endpoint 용. */
export function withApiError<TCtx = unknown>(handler: ApiHandler<TCtx>): ApiHandler<TCtx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      // 진단용 console.error — production 에서도 stderr 에 stack 보존 (사용자에겐 안 노출)
      logger.error('api', '[api-error]', err);
      return apiErrorResponse(err);
    }
  };
}

/**
 * 인증 자동 + 에러 wrap. requireAuth + isAuthError boilerplate 0.
 *
 * 옛 boilerplate (각 route 4-5줄):
 *   export async function POST(req: NextRequest) {
 *     const auth = await requireAuth(req);
 *     if (isAuthError(auth)) return auth;
 *     // ... body
 *   }
 *
 * 새 패턴:
 *   export const POST = withAuth(async (req) => {
 *     // ... body, auth 이미 검증됨
 *   });
 */
export function withAuth<TCtx = unknown>(handler: AuthApiHandler<TCtx>): ApiHandler<TCtx> {
  return async (req, ctx) => {
    try {
      const auth = await requireAuth(req);
      if (isAuthError(auth)) return auth;
      return await handler(req, ctx, auth);
    } catch (err) {
      logger.error('api', '[api-error]', err);
      return apiErrorResponse(err);
    }
  };
}
