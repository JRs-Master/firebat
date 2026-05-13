/**
 * Frontend logger — Phase 2 정공 (2026-05-13).
 *
 * 옛 산재된 console.log/error/warn + silent catch {} 패턴 통합.
 *
 * 특징:
 * - structured (level + category + msg + context)
 * - 환경별 level threshold (dev = debug ↑, prod = warn ↑)
 * - PII redaction — Rust 측 redactor 와 같은 패턴 (token / API key / IP / email mask)
 * - 카테고리 명시 (sse / fetch / chat / cron / etc) — 필터링 가능
 *
 * 사용 패턴:
 *   import { logger } from '@/lib/util/logger';
 *   logger.debug('chat', 'SSE event received', { event, dataLen });
 *   logger.warn('localStorage', 'pending status save 실패', { error: e });
 *   logger.error('fetch', 'auth verify 실패', err, { url });
 *
 * silent catch 패턴 교체:
 *   try { ... } catch {}              → try { ... } catch (e) { logger.debug('영역', '동작 실패', { error: e }); }
 *   try { ... } catch (e) {}          → 같음
 *
 * 진단 가시화 = 운영 중 발견 시 grep / DevTools console 으로 추적 가능.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 환경별 minimum level — dev = debug, prod = warn. NODE_ENV 기반. */
function currentMinLevel(): LogLevel {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') return 'warn';
  return 'debug';
}

/** PII / secret 마스킹 — Rust `lib/redactor.ts` 와 일관. */
function redact(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer ***')
    .replace(/sk-[\w-]{20,}/g, 'sk-***')
    .replace(/AIzaSy[\w-]{20,}/g, 'AIzaSy***')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***.***.***.***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***');
}

function redactContext(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: redact(v.message), stack: v.stack ? redact(v.stack) : undefined };
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentMinLevel()];
}

function emit(level: LogLevel, category: string, msg: string, ctx?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const safeCtx = redactContext(ctx);
  const prefix = `[firebat:${category}]`;
  // console.* 분기 — DevTools 가 level filter 자동 적용. 추후 remote sink 추가 시 분기 추가.
  if (level === 'error') console.error(prefix, msg, safeCtx ?? '');
  else if (level === 'warn') console.warn(prefix, msg, safeCtx ?? '');
  else if (level === 'info') console.info(prefix, msg, safeCtx ?? '');
  else console.debug(prefix, msg, safeCtx ?? '');
}

/**
 * frontend logger 단일 진입점. category 명시 권장 — 필터링 / 추적 용.
 */
export const logger = {
  debug: (category: string, msg: string, ctx?: Record<string, unknown>) => emit('debug', category, msg, ctx),
  info: (category: string, msg: string, ctx?: Record<string, unknown>) => emit('info', category, msg, ctx),
  warn: (category: string, msg: string, ctx?: Record<string, unknown>) => emit('warn', category, msg, ctx),
  error: (category: string, msg: string, err: unknown, ctx?: Record<string, unknown>) => {
    const errCtx: Record<string, unknown> = { ...(ctx ?? {}) };
    if (err instanceof Error) errCtx.error = err;
    else errCtx.error = String(err);
    emit('error', category, msg, errCtx);
  },
};
