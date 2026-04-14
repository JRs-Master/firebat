/**
 * Core Singleton Factory
 *
 * Core는 하나만 존재한다.
 * LLM 모델 변경은 요청별 opts.model로 처리하며, Core를 재생성하지 않는다.
 */
import { FirebatCore } from '../core/index';
import { getInfra } from '../infra/boot';

const globalForCore = globalThis as unknown as { firebatCore: FirebatCore | undefined };

export function getCore(): FirebatCore {
  if (!globalForCore.firebatCore) {
    globalForCore.firebatCore = new FirebatCore(getInfra());
  }
  return globalForCore.firebatCore;
}
