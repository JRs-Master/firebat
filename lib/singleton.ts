/**
 * Core Singleton Factory — Phase B 박힘 (TS legacy 폐기 후 Rust 단일).
 *
 * Rust Core 가 유일한 backend. Frontend / API route 의 옛 호출 패턴 (`getCore().savePage(...)`)
 * 그대로 동작 — RustCoreProxy 가 메서드 호출을 callCore → gRPC → Rust Core 로 라우팅.
 *
 * Tauri 환경 자동 감지 — `window.__TAURI__` 존재 시 Tauri invoke 로 자동 분기 (callCore 내부).
 */
import type { FirebatCore } from './types/firebat-types';
import { createRustCoreProxy } from './rust-core-proxy';

const globalForCore = globalThis as unknown as {
  firebatCoreProxy: unknown;
};

/**
 * 기본 진입점 — 옛 호출 패턴 유지:
 *   ```ts
 *   const core = getCore();
 *   await core.savePage(slug, spec);
 *   const pages = await core.listPages();
 *   ```
 */
export function getCore(): FirebatCore {
  if (!globalForCore.firebatCoreProxy) {
    globalForCore.firebatCoreProxy = createRustCoreProxy();
  }
  return globalForCore.firebatCoreProxy as FirebatCore;
}

/** async wrapper — sync `getCore()` 와 동일하지만 await 패턴 유지 위해 노출. */
export async function getCoreAsync(): Promise<FirebatCore> {
  return getCore();
}
