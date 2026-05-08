/**
 * Core Client Abstraction — v1.0 Final 의 IPC backbone.
 *
 * Frontend / API route 에서 Core 를 호출하는 단일 진입점.
 * Rust gRPC client → Rust Core (별 process, port 50051) 단일 backend.
 *
 * 옛 'ts' (in-process TS Core) / 'tauri' (self-installed) 분기 폐기 (2026-05-08):
 *   - 'ts' = Phase B-4 cutover 박힌 시점에 옛 TS core/ infra/ 통째 삭제됨
 *   - 'tauri' = self-installed 폐기 (commit 2b98cb6, 2026-05-06). v2.0 시점에 재시작
 *
 * Frontend 는 직접 호출 X — API route 경유. browser 에서 gRPC 직접 못 함.
 */

/**
 * Core 메서드 단일 진입점 — Rust gRPC.
 *
 * @param method - Core facade 메서드 이름 (예: 'savePage', 'listProjects')
 * @param args   - 메서드 인자 객체
 */
export async function callCore<T = unknown>(method: string, args?: any): Promise<T> {
  if (typeof window !== 'undefined') {
    throw new Error('[callCore] Node side 전용 — Frontend 에서 직접 호출 X. API route 경유 필요');
  }
  const { invokeCore } = await import('./core-grpc-client');
  return invokeCore<T>(method, args);
}

/** 현재 활성 backend 조회 — debug / health-check 용 (legacy 호환). */
export function getCoreBackend(): 'rust' {
  return 'rust';
}
