/**
 * 에러 캡처 파이프라인 — self-hosted observability layer.
 *
 * Sentry 빠진 후 (CLAUDE.md 박힘) 자체 stack:
 *   1. console.error + log file 누적 (이미 redact 적용)
 *   2. data/errors.jsonl 영구 기록 (분석용)
 *   3. Telegram 알림 (sysmod_telegram, rate limit + PII mask)
 *
 * 사용:
 *   try { ... } catch (e: any) { await captureException(e, { source: 'cron-trigger', jobId }); }
 *
 * StatusManager.error 에서도 자동 호출 (Core 의 statusMgr.error 시 forward).
 *
 * 일반 메커니즘 — 특정 에러 종류 enumerate X. 모든 에러 동일 처리. severity 기반 분기만.
 */

import type { FirebatCore } from '../index';
import { redactString } from '../../lib/redactor';
import * as fs from 'fs';
import * as path from 'path';

// DATA_DIR 직접 해석 — infra/config import 회피 (BIBLE: core 는 infra 직접 import 금지).
// FIREBAT_DATA_DIR env 미설정 시 'data' (infra/config 와 동일 정의).
const DATA_DIR = process.env.FIREBAT_DATA_DIR || 'data';
const ERRORS_LOG_PATH = path.join(DATA_DIR, 'errors.jsonl');

/** Telegram rate limit — 같은 errorKey 5분 안에 1회만 발송. 폭주 방어. */
const TELEGRAM_RATE_LIMIT_MS = 5 * 60_000;
const recentTelegramErrors = new Map<string, number>();

export interface ErrorContext {
  /** 에러 발생 위치 (예: 'cron-trigger', 'save_page', 'llm-call') */
  source?: string;
  /** 관련 식별자 (jobId, slug 등) */
  identifier?: string;
  /** 추가 메타 (PII 자동 redact 됨) */
  meta?: Record<string, unknown>;
  /** Telegram 알림 발송 여부 (default: severity 가 critical 이면 true) */
  notify?: boolean;
  /** 심각도 — info / warn / error / critical */
  severity?: 'info' | 'warn' | 'error' | 'critical';
}

/** 에러 캡처 + 영구 기록 + (옵션) Telegram 알림 */
export async function captureException(
  core: FirebatCore,
  err: unknown,
  ctx: ErrorContext = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const severity = ctx.severity ?? 'error';
  const safeMessage = redactString(message);
  const safeStack = stack ? redactString(stack) : undefined;
  const entry = {
    ts: new Date().toISOString(),
    severity,
    source: ctx.source ?? 'unknown',
    identifier: ctx.identifier,
    message: safeMessage,
    stack: safeStack,
    meta: ctx.meta,
  };
  // 1. jsonl 누적 — 분석·패턴 발견용
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(ERRORS_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* 로깅 실패는 silent — recursion 방지 */ }
  // 2. Telegram 알림 — severity critical or ctx.notify 명시 시
  const shouldNotify = ctx.notify === true || severity === 'critical';
  if (shouldNotify) await maybeSendTelegram(core, entry);
}

/** Rate limit + sysmod_telegram 호출 */
async function maybeSendTelegram(
  core: FirebatCore,
  entry: { source: string; identifier?: string; severity: string; message: string; ts: string },
): Promise<void> {
  // errorKey = source + identifier + message 의 일부 — 같은 에러 반복 폭주 방어
  const errorKey = `${entry.source}:${entry.identifier ?? ''}:${entry.message.slice(0, 100)}`;
  const now = Date.now();
  const lastSent = recentTelegramErrors.get(errorKey);
  if (lastSent && (now - lastSent) < TELEGRAM_RATE_LIMIT_MS) return;
  recentTelegramErrors.set(errorKey, now);
  // 오래된 entries 정리
  for (const [k, t] of recentTelegramErrors) {
    if ((now - t) > TELEGRAM_RATE_LIMIT_MS) recentTelegramErrors.delete(k);
  }
  // sysmod_telegram 호출 — 환경변수 안 박혔으면 silent skip
  try {
    const text = `🚨 Firebat 에러 [${entry.severity}]\n출처: ${entry.source}${entry.identifier ? ` (${entry.identifier})` : ''}\n시각: ${entry.ts}\n\n${entry.message.slice(0, 500)}`;
    await core.sandboxExecute('system/modules/telegram/index.mjs', { action: 'send-message', text });
  } catch { /* Telegram 발송 실패는 silent — 무한 recursion 방지 */ }
}
