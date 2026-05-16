/**
 * Node.js 런타임 전용 bootstrap — instrumentation.ts 에서 조건부 import.
 * Edge Runtime 에서는 절대 로드되지 않습니다.
 *
 * 책임: SIGTERM / SIGINT graceful shutdown — systemd 정상 종료 + Cost flush + Rust core 작업 완료 대기.
 *
 * 옛 setupSystemDependencies (playwright 자동 install) 영역은 2026-05-17 폐기 — Rust core 의 silent
 * install path 폐기 (commit 897a08c) 와 일관. 매 sysmod 호출 시점 패키지 누락 시 envelope errorKey
 * (`core.error.module.packages_missing`) 반환 + 사용자가 설정 화면에서 [설치] 버튼으로 명시 trigger.
 */
export {}; // module 표기 — 부수 효과만 박는 파일이지만 ESM 의 module 인식 위해 빈 export

// SIGTERM / SIGINT graceful shutdown — Core 작업 완료 대기 + Cost flush.
// systemd unit TimeoutStopSec=30s 와 호환 (Core 는 25s, 5s 여유).
// 멱등 — 같은 프로세스에서 한 번만 등록.
const __gShut = globalThis as unknown as { __firebatShutdownWired?: boolean };
if (!__gShut.__firebatShutdownWired) {
  __gShut.__firebatShutdownWired = true;
  let shuttingDown = false;
  const handler = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Firebat] ${sig} 수신 — graceful shutdown 시작`);
    try {
      const { gracefulShutdown } = await import('./lib/api-gen/lifecycle');
      await gracefulShutdown({ timeoutMs: 25_000n });
    } catch (err) {
      console.warn('[Firebat] shutdown 실패:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void handler('SIGTERM'); });
  process.on('SIGINT', () => { void handler('SIGINT'); });
}
