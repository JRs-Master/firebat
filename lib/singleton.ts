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
 * Build-mode stub — `next build` 시 generateMetadata / RSC prerender 가 backend 호출 시도.
 * Rust core 가 안 떠있으면 ECONNREFUSED → /_not-found prerender 실패 → 빌드 통째 멈춤.
 *
 * env `FIREBAT_BUILD_MODE=1` 박힌 빌드 시 Proxy 가 모든 메서드 호출 → 정적 fallback 반환.
 *   - listX / scanX → 빈 배열
 *   - getX / readX → null
 *   - getCmsSettings → 정적 fallback (siteTitle/lang 박힘)
 *   - 기타 → null
 *
 * 빌드 명령:
 *   FIREBAT_BUILD_MODE=1 npm run build
 *
 * 운영 (npm start / systemd) 에서는 env 미설정 → 정상 gRPC 호출.
 */
const BUILD_MODE_FALLBACKS: Record<string, unknown> = {
  // CMS — root layout / 페이지 generateMetadata 호출.
  getCmsSettings: {
    siteTitle: 'Firebat',
    siteDescription: 'Just Imagine. Firebat Runs.',
    siteLang: 'ko',
    faviconUrl: '',
    layout: { mode: 'full' },
    theme: {},
    verifications: [],
  },
  // Page / Project / Tag listing — 빈 배열.
  listPages: { success: true, data: [] },
  scanProjects: [],
  listAllTags: [],
  listConversations: { success: true, data: [] },
  listCronJobs: [],
  listMcpServers: [],
  listTemplates: [],
  listMedia: { success: true, data: [] },
  // 기본값 묶음.
  getKakaoMapJsKey: '',
  getTimezone: 'Asia/Seoul',
  getAiModel: '',
};

function createBuildModeStub(): FirebatCore {
  return new Proxy({}, {
    get: (_target, method) => {
      if (typeof method !== 'string') return undefined;
      return async () => BUILD_MODE_FALLBACKS[method] ?? null;
    },
  }) as FirebatCore;
}

/**
 * 기본 진입점 — 옛 호출 패턴 유지:
 *   ```ts
 *   const core = getCore();
 *   await core.savePage(slug, spec);
 *   const pages = await core.listPages();
 *   ```
 */
export function getCore(): FirebatCore {
  if (process.env.FIREBAT_BUILD_MODE === '1') {
    if (!globalForCore.firebatCoreProxy) {
      globalForCore.firebatCoreProxy = createBuildModeStub();
    }
    return globalForCore.firebatCoreProxy as FirebatCore;
  }
  if (!globalForCore.firebatCoreProxy) {
    globalForCore.firebatCoreProxy = createRustCoreProxy();
  }
  return globalForCore.firebatCoreProxy as FirebatCore;
}

/** async wrapper — sync `getCore()` 와 동일하지만 await 패턴 유지 위해 노출. */
export async function getCoreAsync(): Promise<FirebatCore> {
  return getCore();
}
