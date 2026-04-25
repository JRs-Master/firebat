/**
 * Core Singleton Factory
 *
 * Core는 하나만 존재한다.
 * LLM 모델 변경은 요청별 opts.model로 처리하며, Core를 재생성하지 않는다.
 */
import { FirebatCore } from '../core/index';
import { getInfra } from '../infra/boot';
import { wireStatusManagerForwarder, isSentryEnabled } from '../infra/observability/sentry-adapter';

const globalForCore = globalThis as unknown as { firebatCore: FirebatCore | undefined };

export function getCore(): FirebatCore {
  if (!globalForCore.firebatCore) {
    globalForCore.firebatCore = new FirebatCore(getInfra());
    // Sentry 활성 시 StatusManager error 자동 forward — 멱등 (같은 core 두번 wire 방지)
    if (isSentryEnabled()) {
      wireStatusManagerForwarder(globalForCore.firebatCore);
    }
  }
  return globalForCore.firebatCore;
}
