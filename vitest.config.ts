import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest 설정 — 인바리언트 테스트 + 통합 테스트.
 *
 * 목적: 회귀 방어 backbone — 큰 리팩토링·매니저 rename 시 즉각 감지.
 *
 * 스코프:
 *   - 순수 함수: reducer / $prev resolver / CONDITION ops / token redactor / PII sanitizer.
 *   - 인프라 의존 없음 (DB·LLM·sandbox mock 불필요한 것만).
 *   - DOM 없는 테스트 — happy-dom / jsdom 미사용.
 *
 * CI: GitHub Actions 가 push 마다 실행 (.github/workflows/test.yml).
 */
export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    // 단위 테스트는 빠름 — fake timer 없이 실시간.
    testTimeout: 10000,
    // 병렬 실행 — 단일 프로세스 안에서 worker 분산.
    pool: 'threads',
    // path alias 가 필요한 경우 vite resolve 가 자동 처리.
  },
  resolve: {
    alias: {
      // tsconfig 의 path mapping 과 동기화 — 현재는 alias 없음, baseUrl 만.
    },
  },
  // 환경변수 — 테스트가 전역 lookup 시 fallback.
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
});
