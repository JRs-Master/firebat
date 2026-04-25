/**
 * PM2 프로세스 정의 — 운영 (Vultr 서버) 용.
 *
 * 사용:
 *   pm2 start ecosystem.config.js     # 시작
 *   pm2 reload firebat                 # 무중단 재시작
 *   pm2 logs firebat                   # 실시간 로그
 *   pm2 monit                          # 리소스 모니터
 *
 * 안정성 옵션:
 *   - max_memory_restart: 메모리 누수 자동 복구 (LLM CLI daemon 누적 대응).
 *   - autorestart: 크래시 시 자동 재시작.
 *   - max_restarts: 폭주 방지 — 1분 안에 10번 재시작하면 중단.
 *   - kill_timeout: SIGTERM 후 30초 대기 — critical section (매수 체결·DB write) 보호.
 *   - wait_ready: app 이 ready signal 보낼 때까지 대기 (Next.js standalone build 권장).
 */

module.exports = {
  apps: [
    {
      name: 'firebat',
      cwd: '.',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      exec_mode: 'fork',  // Next.js 는 cluster mode 와 일부 충돌 — fork 권장.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',  // 60초 이내 재크래시는 폭주로 간주.
      max_memory_restart: '500M',
      kill_timeout: 30_000,  // 30초 graceful shutdown — node-cron / SQLite write / sandbox 보호.
      listen_timeout: 30_000,
      shutdown_with_message: true,
      env: {
        NODE_ENV: 'production',
        // Sentry DSN — 미설정 시 자동 비활성. 어드민 설정 모달에서 Vault 저장 가능.
        // SENTRY_DSN: 'https://...@sentry.io/...',
      },
      error_file: 'data/logs/pm2-error.log',
      out_file: 'data/logs/pm2-out.log',
      merge_logs: true,
      time: true,  // 로그 라인에 timestamp prefix.
    },
  ],
};
