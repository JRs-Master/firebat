import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/log — 브라우저 (특히 hub 익명 visitor) 의 error/warn 로그를 서버로 수집.
 *
 * 배경 (로그 시스템 Phase 2, 2026-05-21): hub 는 외부 visitor 라 브라우저 console 에 찍힌
 * 에러가 운영자(admin) ssh journalctl 에서 안 보였음 → hub 에서 발견되는 에러를 진단 불가.
 * frontend logger.error/warn 이 본 endpoint 로 전송 → firebat-frontend 의 서버 console
 * (= journalctl -u firebat-frontend) 합류. `[client:<category>]` prefix 로 backend 로그와 구분.
 *
 * 인증 면제 (proxy.ts) — visitor 인증 없음. 대신 size/필드 cap 으로 남용 방지.
 * debug/info 는 받지 않음 (브라우저 console 전용 — 폭주 방지). error/warn 만.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { level?: string; category?: string; msg?: string; context?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const level = body.level === 'error' ? 'error' : 'warn';
  const category = String(body.category ?? 'unknown').slice(0, 40);
  const msg = String(body.msg ?? '').slice(0, 2000);
  const ctx = body.context ? JSON.stringify(body.context).slice(0, 4000) : '';
  // 브라우저 식별 단서 — UA 끝부분만 (full UA 는 길어 cap). PII 인 IP 는 기록 X.
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 80);

  const line = `[client:${category}] ${msg}${ctx ? ` ${ctx}` : ''}${ua ? ` | ua=${ua}` : ''}`;
  // 서버 console → firebat-frontend journalctl. SSR 환경이라 stdout 이 systemd 가 capture.
  if (level === 'error') console.error(line);
  else console.warn(line);

  return NextResponse.json({ ok: true });
}
