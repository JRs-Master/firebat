/**
 * Core Singleton Factory — Phase A 박힘 / Phase B-4 C 정리.
 *
 * Core는 하나만 존재한다.
 * LLM 모델 변경은 요청별 opts.model로 처리하며, Core를 재생성하지 않는다.
 *
 * env `FIREBAT_CORE_BACKEND` 분기:
 *   - 'rust' (default — Phase B 박힘)  : RustCoreProxy 반환 (callCore → gRPC)
 *   - 'ts'   (legacy fallback / 디버깅) : 옛 in-process FirebatCore 직접
 *   - 'tauri' (Phase D self-installed) : Tauri 환경 자동 감지 — RustCoreProxy 와 동일 (callCore 내부 분기)
 *
 * 옛 frontend route 의 `getCore().savePage(...)` 등 호출 코드 변경 0건 — Proxy 가 옛 시그니처 유지.
 */
import type { FirebatCore } from '../core/index';
import { createRustCoreProxy } from './rust-core-proxy';

const globalForCore = globalThis as unknown as {
  firebatCore: FirebatCore | undefined;
  firebatCoreProxy: unknown;
};

/** legacy in-process Core — env `FIREBAT_CORE_BACKEND=ts` 박혀있을 때만 활성. */
async function getLegacyCore(): Promise<FirebatCore> {
  if (!globalForCore.firebatCore) {
    const { FirebatCore } = await import('../core/index');
    const { getInfra } = await import('../infra/boot');
    globalForCore.firebatCore = new FirebatCore(getInfra());
  }
  return globalForCore.firebatCore;
}

/**
 * 기본 진입점 — env-driven swap.
 *
 * 'rust' (default) / 'tauri' → RustCoreProxy (callCore → gRPC / Tauri invoke).
 * 'ts' → legacy in-process FirebatCore.
 *
 * 옛 호출 패턴 그대로:
 *   ```ts
 *   const core = getCore();
 *   await core.savePage(slug, spec);
 *   const pages = await core.listPages();
 *   ```
 */
export function getCore(): FirebatCore {
  const backend =
    typeof process !== 'undefined' ? process.env?.FIREBAT_CORE_BACKEND : undefined;
  // Tauri 환경 — window.__TAURI__ 가 있으면 강제로 rust path (Tauri invoke 자동 라우팅)
  const isTauri =
    typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__
      ? true
      : false;

  if (backend === 'ts' && !isTauri) {
    // legacy fallback — 동기 export 유지하기 위해 globalThis 캐시 활용. 첫 호출 시 await 필요한
    // 케이스는 호출자가 `await import('./singleton').then(m => m.getCore())` 패턴 또는 별 헬퍼 사용.
    // 옛 호출 패턴은 거의 다 async context 안 — sync 캐시 hit 후 동작.
    if (!globalForCore.firebatCore) {
      // 첫 호출 — 동기 path 강제 (옛 dynamic import 안 사용한 패턴 호환).
      // 옛 singleton.ts 와 동일 동작.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { FirebatCore } = require('../core/index');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getInfra } = require('../infra/boot');
      globalForCore.firebatCore = new FirebatCore(getInfra());
    }
    return globalForCore.firebatCore as FirebatCore;
  }

  // 'rust' (default) / 'tauri' — RustCoreProxy 반환. 옛 시그니처 그대로.
  if (!globalForCore.firebatCoreProxy) {
    globalForCore.firebatCoreProxy = createRustCoreProxy();
  }
  return globalForCore.firebatCoreProxy as FirebatCore;
}

/** Phase B-4 의 async wrapper — 진짜 비동기 init 가 필요한 경우 (legacy core 의 첫 호출). */
export async function getCoreAsync(): Promise<FirebatCore> {
  const backend =
    typeof process !== 'undefined' ? process.env?.FIREBAT_CORE_BACKEND : undefined;
  const isTauri =
    typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__
      ? true
      : false;

  if (backend === 'ts' && !isTauri) {
    return getLegacyCore();
  }
  if (!globalForCore.firebatCoreProxy) {
    globalForCore.firebatCoreProxy = createRustCoreProxy();
  }
  return globalForCore.firebatCoreProxy as FirebatCore;
}
