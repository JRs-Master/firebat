/**
 * Core Client Abstraction — v1.0 Final 의 핵심 IPC backbone (Phase A 박힘).
 *
 * Frontend / API route 에서 Core 를 호출하는 단일 진입점.
 * 환경 변수 `FIREBAT_CORE_BACKEND` 에 따라 자동 분기:
 *
 *   'ts'    (default, 옛 v0.1 path)  — getCore() 직접 호출. 옛 in-process TS Core.
 *   'rust'  (Phase B 활성)             — gRPC client → Rust Core (별 process, port 50051).
 *   'tauri' (Phase D self-installed)   — Tauri invoke → Rust Core (in-process embed).
 *
 * Phase A 의 첫 commit 단계에선 'ts' 만 동작 (옛 코드 그대로 — 운영 영향 0).
 * 'rust' / 'tauri' 는 Phase B / D 에서 점진 활성.
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
  // env 변수 우선 — self-hosted 운영자가 명시 설정 시
  const envBackend = (typeof process !== 'undefined' ? process.env?.FIREBAT_CORE_BACKEND : undefined) as CoreBackend | undefined;
  if (envBackend === 'rust' || envBackend === 'tauri' || envBackend === 'ts') {
    return envBackend;
  }
  // default — 옛 v0.1 path. 운영 영향 0 보장.
  return 'ts';
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
  if (BACKEND === 'rust') {
    // Phase B 활성 — gRPC client (Rust Core 별 process)
    return callGrpc<T>(method, args);
  }
  // 'ts' (default) — 옛 v0.1 path. getCore() 직접 호출.
  return callLegacyCore<T>(method, args);
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

/** 'rust' backend — gRPC client. Phase B 에서 구현. */
async function callGrpc<T>(_method: string, _args?: any): Promise<T> {
  throw new Error('[callCore] gRPC backend (rust) not yet implemented — Phase B 활성 시 박힘');
}

/** 'tauri' backend — Tauri invoke. Phase D self-installed 에서 구현. */
async function invokeTauri<T>(_method: string, _args?: any): Promise<T> {
  throw new Error('[callCore] Tauri backend not yet implemented — Phase D 활성 시 박힘');
}

/** 현재 활성 backend 조회 — debug / health-check 용 */
export function getCoreBackend(): CoreBackend {
  return BACKEND;
}
