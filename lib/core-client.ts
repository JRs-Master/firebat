/**
 * Core Client Abstraction — v1.0 Final 의 핵심 IPC backbone (Phase A 박힘 / Phase B-4 정리).
 *
 * Frontend / API route 에서 Core 를 호출하는 단일 진입점.
 * 환경 변수 `FIREBAT_CORE_BACKEND` 에 따라 자동 분기:
 *
 *   'ts'    (legacy fallback, 디버깅용)  — getCore() 직접 호출. 옛 in-process TS Core.
 *   'rust'  (운영 default — Phase B 박힘) — gRPC client → Rust Core (별 process, port 50051).
 *   'tauri' (Phase D self-installed)     — Tauri invoke → Rust Core (in-process embed).
 *
 * Tauri 환경 자동 감지 — 그 외엔 env 명시 없으면 'rust' 사용.
 * 'both' (dual-run) 분기는 폐기 — 사용자 결정: 동시 운영 안 함, cutover 한 번에.
 *
 * 변환 룰 (CLAUDE.md / FIREBAT_BIBLE 박힘):
 *   1. Hot path / 보안 / 정밀 timing 영역 → Rust 강제
 *   2. Trade-off 영역 → 좋은 라이브러리 활용 (언어 중립)
 *   3. Hexagonal port interface 안정성 보장 — 어댑터 안 라이브러리 변경이 매니저·Frontend 영향 0
 */

type CoreBackend = 'ts' | 'rust' | 'tauri';

function detectBackend(): CoreBackend {
  // Tauri 환경 감지 — self-installed 자동 분기
  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    return 'tauri';
  }
  // env 변수 우선 — 운영자가 명시 설정 시 (디버깅 시 'ts' 박을 수 있음)
  const envBackend = (typeof process !== 'undefined' ? process.env?.FIREBAT_CORE_BACKEND : undefined) as CoreBackend | undefined;
  if (envBackend === 'rust' || envBackend === 'tauri' || envBackend === 'ts') {
    return envBackend;
  }
  // default — Rust Core (Phase B 박힘, 운영 default).
  return 'rust';
}

const BACKEND: CoreBackend = detectBackend();

/**
 * Core 메서드 단일 진입점.
 *
 * Phase A: 'ts' 분기만 동작 — `getCore()` 직접 호출 (옛 코드 그대로).
 * Phase B 활성 시: 'rust' 분기 — gRPC client 통해 Rust Core 호출.
 * Phase D 활성 시: 'tauri' 분기 — Tauri invoke 통해 in-process Rust 호출.
 *
 * @param method - Core facade 메서드 이름 (예: 'savePage', 'listProjects')
 * @param args   - 메서드 인자 객체 (현재 단일 객체 가정 — 추후 다인자 지원 시 확장)
 */
export async function callCore<T = unknown>(method: string, args?: any): Promise<T> {
  if (BACKEND === 'tauri') {
    // Phase D 활성 — Tauri invoke (Rust Core in-process embed)
    return invokeTauri<T>(method, args);
  }
  if (BACKEND === 'ts') {
    // legacy fallback — 디버깅·검증용. 옛 in-process TS Core 직접 호출.
    return callLegacyCore<T>(method, args);
  }
  // 'rust' (default) — gRPC client → Rust Core (port 50051)
  return callGrpc<T>(method, args);
}

/** 'ts' backend — 옛 in-process TS Core 직접 호출. Phase B cutover 까지 default. */
async function callLegacyCore<T>(method: string, args?: any): Promise<T> {
  // dynamic import — 빌드 시 env 별 tree-shake 가능 + 순환 의존 회피
  const { getCore } = await import('./singleton');
  const core = getCore() as any;
  if (typeof core[method] !== 'function') {
    throw new Error(`[callCore] unknown method: ${method}`);
  }
  return core[method](args);
}

/** 'rust' backend — gRPC client. Node side 만 동작 (Frontend 에선 Tauri 또는 'ts'). */
async function callGrpc<T>(method: string, args?: any): Promise<T> {
  if (typeof window !== 'undefined') {
    throw new Error('[callCore] rust backend 는 Node side 전용 — Frontend 에서 직접 호출 X. API route 경유 필요');
  }
  const { invokeCore } = await import('./core-grpc-client');
  return invokeCore<T>(method, args);
}

/** 'tauri' backend — Tauri invoke. Phase D self-installed 에서 구현. */
async function invokeTauri<T>(method: string, args?: any): Promise<T> {
  if (typeof window === 'undefined' || !('__TAURI__' in window)) {
    throw new Error('[callCore] tauri backend 는 Tauri 환경 전용');
  }
  // @ts-ignore — Phase D 시점에 @tauri-apps/api 의존성 추가 후 정상 import
  const tauriCore = await import('@tauri-apps/api/core').catch(() => {
    throw new Error('[callCore] @tauri-apps/api not installed — Phase D 활성 후 가능');
  });
  // invoke 의 generic 시그니처 — 동적 import 라 타입 추론 필요
  return (tauriCore as any).invoke(method, args) as Promise<T>;
}

/** 현재 활성 backend 조회 — debug / health-check 용 */
export function getCoreBackend(): CoreBackend {
  return BACKEND;
}
