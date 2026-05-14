/**
 * RpcResult<T> — gRPC 표준 에러 + 성공 응답 통일 타입.
 *
 * 사용 패턴:
 *   const res = await login({ id, password });
 *   if (!res.ok) {
 *     // res.code / res.message 사용
 *     return;
 *   }
 *   // res.data 사용 (typed)
 *
 * **에러 분류** (gRPC standard Code 매핑):
 *  - INVALID_ARGUMENT → 입력 검증 실패
 *  - NOT_FOUND → 리소스 없음
 *  - PERMISSION_DENIED → 권한 부족
 *  - UNAUTHENTICATED → 세션 / 토큰 없음
 *  - INTERNAL → 서버 내부 오류 (default)
 *  - UNAVAILABLE → gRPC 연결 불가 (Rust core 다운 등)
 *  - DEADLINE_EXCEEDED → timeout
 */
export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: RpcErrorCode; message: string };

export type RpcErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'ALREADY_EXISTS'
  | 'FAILED_PRECONDITION'
  | 'INTERNAL'
  | 'UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'UNIMPLEMENTED'
  | 'UNKNOWN';

/** tonic / connect gRPC code (number) → RpcErrorCode 매핑. */
const GRPC_CODE_MAP: Record<number, RpcErrorCode> = {
  3: 'INVALID_ARGUMENT',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  9: 'FAILED_PRECONDITION',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
  4: 'DEADLINE_EXCEEDED',
};

/** ConnectError / tonic Status 객체 → RpcResult.err. */
export function toRpcError(err: unknown): { ok: false; code: RpcErrorCode; message: string } {
  const anyErr = err as { code?: number | string; message?: string; rawMessage?: string };
  const numCode = typeof anyErr?.code === 'number' ? anyErr.code : null;
  const strCode = typeof anyErr?.code === 'string' ? anyErr.code.toUpperCase() : null;
  let code: RpcErrorCode = 'UNKNOWN';
  if (numCode !== null && GRPC_CODE_MAP[numCode]) code = GRPC_CODE_MAP[numCode];
  else if (strCode && (Object.values(GRPC_CODE_MAP) as string[]).includes(strCode)) {
    code = strCode as RpcErrorCode;
  }
  const message = anyErr?.rawMessage ?? anyErr?.message ?? String(err);
  return { ok: false, code, message };
}
