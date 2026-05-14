import { NextRequest, NextResponse } from 'next/server';
import { queryDatabase } from '../../../lib/api-gen/database';
import { listCron } from '../../../lib/api-gen/schedule';
import { stats as getJobStats } from '../../../lib/api-gen/status';

/**
 * GET /api/health — 외부 모니터링 (UptimeRobot 등) 진입점.
 *
 * 인증 없음 — 모니터링 도구가 토큰 없이 접근 가능해야 함. 응답에 민감 정보 미노출.
 *
 * 응답 형태:
 *   200 OK — { status: 'ok' | 'degraded', uptimeSec, checks: { db, cron, status, memory } }
 *   503 Service Unavailable — { status: 'error', uptimeSec, checks: {...} }
 *
 * UptimeRobot 룰: HTTP 200 = 정상. 503 = 알림 발송 (텔레그램·이메일·SMS).
 *
 * 일반 로직 — 특정 잡·도메인 분기 X. 인프라 어댑터·매니저 stats 만 노출.
 */

interface CheckResult {
  ok: boolean;
  detail?: string;
  meta?: Record<string, unknown>;
}

async function checkDb(): Promise<CheckResult> {
  try {
    // SQLite 간단 ping — 1 row select
    const res = await queryDatabase({ sql: 'SELECT 1 AS ok', paramsJson: JSON.stringify([]) });
    if (!res.ok) return { ok: false, detail: res.message };
    if (Array.isArray(res.data) && res.data.length > 0) {
      return { ok: true };
    }
    return { ok: false, detail: 'unexpected response' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkCron(): Promise<CheckResult> {
  try {
    const res = await listCron();
    if (!res.ok) return { ok: false, detail: res.message };
    const jobs = res.data.jobs ?? [];
    return { ok: true, meta: { count: jobs.length } };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkStatusManager(): Promise<CheckResult> {
  try {
    const res = await getJobStats();
    if (!res.ok) return { ok: false, detail: res.message };
    const stats = res.data as { running?: number } & Record<string, unknown>;
    const running = typeof stats.running === 'number' ? stats.running : 0;
    // running > 100 이면 누적 의심 — degraded 알림
    const degraded = running > 100;
    return {
      ok: !degraded,
      ...(degraded ? { detail: `running jobs accumulating (${running})` } : {}),
      meta: stats as Record<string, unknown>,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkMemory(): CheckResult {
  try {
    const m = process.memoryUsage();
    const rssMb = Math.round(m.rss / 1024 / 1024);
    const heapMb = Math.round(m.heapUsed / 1024 / 1024);
    // 600MB rss 초과 — degraded (systemd MemoryMax 500MB 와 안전 마진).
    // 일반 로직: 임계값 단일 상수, 도메인별 분기 X.
    const degraded = rssMb > 600;
    return {
      ok: !degraded,
      ...(degraded ? { detail: `high rss memory (${rssMb}MB)` } : {}),
      meta: { rssMb, heapMb },
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(_req: NextRequest) {
  const startedAt = process.uptime ? Math.floor(process.uptime()) : 0;

  const [db, cron, status, memory] = await Promise.all([
    checkDb(),
    checkCron(),
    checkStatusManager(),
    Promise.resolve(checkMemory()),
  ]);

  const allOk = db.ok && cron.ok && status.ok && memory.ok;
  // db 실패 = error (503), 그 외 단일 실패 = degraded (200 OK 유지 — UptimeRobot alert 안 띄움)
  const overall: 'ok' | 'degraded' | 'error' = !db.ok ? 'error' : allOk ? 'ok' : 'degraded';
  const httpStatus = overall === 'error' ? 503 : 200;

  return NextResponse.json(
    {
      status: overall,
      uptimeSec: startedAt,
      timestamp: new Date().toISOString(),
      checks: { db, cron, status, memory },
    },
    { status: httpStatus },
  );
}
