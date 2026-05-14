/**
 * 글로벌 API 에러 매핑 — gRPC ServiceError → HTTP 친화 응답 + 사용자 메시지 sanitize.
 *
 * BIBLE 제12장 (Observability & Resilience) 정신:
 *  - 외부 사용자에게 노출되어선 안 될 내부 구조 (스택 trace / 파일 path / SQL / token) 차단
 *  - gRPC 코드 (UNAUTHENTICATED / NOT_FOUND / INVALID_ARGUMENT 등) → 표준 HTTP status 매핑
 *  - 실패 메시지는 redactor 통과 (token / API key / IP / email 자동 mask)
 *
 * 사용 패턴:
 *   ```ts
 *   try {
 *     const r = await savePage(args);
 *     if (!r.ok) return NextResponse.json({ success: false, error: r.message }, { status: 400 });
 *     return NextResponse.json({ success: true, ...r.data });
 *   } catch (err) {
 *     return apiErrorResponse(err);   // 자동 매핑 + sanitize
 *   }
 *   ```
 *
 * 또는 wrapper:
 *   ```ts
 *   export const POST = withApiError(async (req) => { ... });
 *   ```
 */
import { NextResponse } from 'next/server';
import { redactString } from './redactor';

/** gRPC status code (grpc-js) — proto/grpc 표준. 일부만 사용. */
const GRPC_CODE = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

/** gRPC status code → HTTP status. */
function grpcCodeToHttp(code: number): number {
  switch (code) {
    case GRPC_CODE.OK: return 200;
    case GRPC_CODE.CANCELLED: return 499; // client closed
    case GRPC_CODE.INVALID_ARGUMENT:
    case GRPC_CODE.OUT_OF_RANGE:
    case GRPC_CODE.FAILED_PRECONDITION:
      return 400;
    case GRPC_CODE.UNAUTHENTICATED: return 401;
    case GRPC_CODE.PERMISSION_DENIED: return 403;
    case GRPC_CODE.NOT_FOUND: return 404;
    case GRPC_CODE.ALREADY_EXISTS:
    case GRPC_CODE.ABORTED:
      return 409;
    case GRPC_CODE.RESOURCE_EXHAUSTED: return 429;
    case GRPC_CODE.UNIMPLEMENTED: return 501;
    case GRPC_CODE.UNAVAILABLE: return 503;
    case GRPC_CODE.DEADLINE_EXCEEDED: return 504;
    case GRPC_CODE.INTERNAL:
    case GRPC_CODE.DATA_LOSS:
    case GRPC_CODE.UNKNOWN:
    default:
      return 500;
  }
}

/** 사용자 친화 한국어 메시지 (HTTP status 별 default). 도메인 메시지는 err.details 우선. */
function defaultMessageFor(status: number): string {
  switch (status) {
    case 400: return '요청 인자가 잘못되었습니다.';
    case 401: return '인증이 필요합니다.';
    case 403: return '권한이 없습니다.';
    case 404: return '대상을 찾을 수 없습니다.';
    case 409: return '이미 존재하거나 충돌이 발생했습니다.';
    case 429: return '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
    case 499: return '요청이 취소되었습니다.';
    case 501: return '아직 구현되지 않은 기능입니다.';
    case 503: return '일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.';
    case 504: return '응답 시간이 초과되었습니다.';
    case 500:
    default:
      return '서버 내부 오류가 발생했습니다.';
  }
}

/** 외부 노출 안전 메시지 추출 — redactor 통과 + 길이 제한. */
function safeMessage(raw: unknown, fallback: string): string {
  if (raw == null) return fallback;
  const s = typeof raw === 'string' ? raw : (raw as { message?: string }).message;
  if (!s || typeof s !== 'string') return fallback;
  const cleaned = redactString(s).trim();
  if (!cleaned) return fallback;
  // 메시지 한도 — 스택 trace / SQL / 긴 path leak 방어
  return cleaned.length > 240 ? cleaned.slice(0, 240) + '…' : cleaned;
}

export class ApiError extends Error {
  readonly status: number;
  readonly grpcCode?: number;
  readonly userMessage: string;

  constructor(status: number, message: string, grpcCode?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.grpcCode = grpcCode;
    this.userMessage = message;
  }

  toResponse(): NextResponse {
    return NextResponse.json(
      { success: false, error: this.userMessage, status: this.status },
      { status: this.status },
    );
  }
}

/** gRPC ServiceError ({ code, details }) 를 ApiError 로 변환. */
export function fromGrpcError(err: unknown): ApiError {
  const e = err as { code?: number; details?: string; message?: string };
  const code = typeof e?.code === 'number' ? e.code : GRPC_CODE.UNKNOWN;
  const status = grpcCodeToHttp(code);
  const fallback = defaultMessageFor(status);
  const msg = safeMessage(e?.details ?? e?.message, fallback);
  return new ApiError(status, msg, code);
}

/** 임의 throw 를 NextResponse 로 변환 — auth-guard 의 NextResponse 는 통과. */
export function apiErrorResponse(err: unknown): NextResponse {
  if (err instanceof NextResponse) return err;
  if (err instanceof ApiError) return err.toResponse();
  // gRPC ServiceError 추정 (number code + details)
  const e = err as { code?: unknown; details?: unknown };
  if (typeof e?.code === 'number') {
    return fromGrpcError(err).toResponse();
  }
  // 일반 Error
  const msg = safeMessage((err as { message?: string })?.message, '서버 내부 오류가 발생했습니다.');
  return NextResponse.json(
    { success: false, error: msg, status: 500 },
    { status: 500 },
  );
}
