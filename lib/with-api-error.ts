/**
 * Next.js API route handler wrapper — try/catch 통합 + ApiError 자동 매핑.
 *
 * 사용:
 *   ```ts
 *   import { withApiError } from '../../../lib/with-api-error';
 *
 *   export const POST = withApiError(async (req) => {
 *     const result = await getCore().savePage(args);
 *     return NextResponse.json({ success: true, ...result });
 *   });
 *   ```
 *
 * 효과:
 *  - throw 된 ApiError → toResponse() 자동 (status + userMessage)
 *  - gRPC ServiceError ({code, details}) → fromGrpcError 자동 매핑
 *  - 일반 Error → 500 + redactor 통과 메시지
 *  - NextResponse instance → 그대로 통과 (auth-guard 의 401 등)
 */
import type { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse } from './api-error';

type ApiHandler<TCtx = unknown> = (
  req: NextRequest,
  ctx: TCtx,
) => Promise<NextResponse> | NextResponse;

export function withApiError<TCtx = unknown>(handler: ApiHandler<TCtx>): ApiHandler<TCtx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      // 진단용 console.error — production 에서도 stderr 에 stack 보존 (사용자에겐 안 노출)
      console.error('[api-error]', (err as Error)?.stack ?? err);
      return apiErrorResponse(err);
    }
  };
}
