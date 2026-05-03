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

type CoreBackend = 'ts' | 'rust' | 'tauri' | 'both';

function detectBackend(): CoreBackend {
  // Tauri 환경 감지 — self-installed 자동 분기
  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    return 'tauri';
  }
  // env 변수 우선 — self-hosted 운영자가 명시 설정 시
  const envBackend = (typeof process !== 'undefined' ? process.env?.FIREBAT_CORE_BACKEND : undefined) as CoreBackend | undefined;
  if (envBackend === 'rust' || envBackend === 'tauri' || envBackend === 'ts' || envBackend === 'both') {
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
  if (BACKEND === 'both') {
    // dual-run 검증 — ts + rust 둘 다 호출, 결과 diff log. ts 결과 반환.
    return callDualRun<T>(method, args);
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

/** 'both' backend — dual-run 검증. ts + rust 동시 호출, 결과 diff log, ts 결과 반환. */
async function callDualRun<T>(method: string, args?: any): Promise<T> {
  // ts 결과는 정답 — 반환에 사용. rust 결과는 비교 only (실패해도 main flow 안 막음).
  const tsResult = await callLegacyCore<T>(method, args);
  // rust 호출은 비동기로 실행 (await 안 함 — main flow 지연 0)
  Promise.resolve()
    .then(() => callGrpc<T>(method, args))
    .then(rustResult => {
      const diff = compareResults(tsResult, rustResult);
      if (diff) {
        // 차이 발견 — Phase B 의 Rust 매니저 fix 신호
        // 운영 환경에선 logger 통해 송출. 현재는 console.warn (env 별 hook 추후 박음)
        console.warn(`[dual-run diff] method=${method} diff=${diff}`);
      } else {
        // 결과 일치 — Rust 측 정상 동작 검증
      }
    })
    .catch(err => {
      console.warn(`[dual-run] rust call failed (ts result still returned): method=${method} err=${err?.message ?? err}`);
    });
  return tsResult;
}

/** 두 결과 비교 — JSON 직렬화 후 string diff. 동일하면 null, 다르면 짧은 description. */
function compareResults(ts: unknown, rust: unknown): string | null {
  try {
    const tsJson = JSON.stringify(ts);
    const rustJson = JSON.stringify(rust);
    if (tsJson === rustJson) return null;
    return `len_ts=${tsJson.length} len_rust=${rustJson.length} sample_ts=${tsJson.slice(0, 200)} sample_rust=${rustJson.slice(0, 200)}`;
  } catch (e: any) {
    return `compare error: ${e?.message ?? e}`;
  }
}

/** 현재 활성 backend 조회 — debug / health-check 용 */
export function getCoreBackend(): CoreBackend {
  return BACKEND;
}
