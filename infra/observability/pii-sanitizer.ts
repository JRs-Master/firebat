/**
 * PII Sanitizer — Sentry beforeSend hook.
 *
 * 배경: Sentry 에 시크릿·토큰·사용자 prompt 본문이 그대로 흘러가면 안 됨.
 *   - Vault 시크릿 (API 키): KIS_APP_KEY, OPENAI_API_KEY, KAKAO_*, TELEGRAM_*, FIRECRAWL_API_KEY 등
 *   - 인증 토큰: Bearer, fbat_, fbt_, sk-, AIza, eyJ (JWT), JSON Web Token
 *   - 사용자 식별 정보: 카카오/텔레그램 chat ID, 이메일, 전화번호
 *   - 사용자 prompt 본문 (긴 텍스트 — context body)
 *
 * 일반 로직 (특정 키 하드코딩 X):
 *   1. 객체 키 이름이 "secret/token/password/apiKey/authorization/credential" 류면 value mask
 *   2. 문자열 값이 알려진 토큰 prefix 패턴이면 mask
 *   3. base64-like 긴 문자열 (32자+)은 mask (보수적)
 *   4. 깊이 제한 + 순환 참조 방어
 *
 * 결정적 (deterministic) — 같은 입력 = 같은 출력. Sentry 측 캐싱·중복 검출 호환.
 */

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /private[-_]?key/i,
  /client[-_]?secret/i,
  /session[-_]?id/i,
  /cookie/i,
  /vault/i,
];

const TOKEN_PATTERNS: RegExp[] = [
  // Firebat 자체 토큰
  /fbat_[a-f0-9]{16,}/gi,
  /fbt_[a-f0-9]{16,}/gi,
  // OpenAI / Anthropic / Google
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  // 카카오 / 텔레그램
  /\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b/g,  // Telegram bot token (id:hash)
  // JWT
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  // GitHub / Slack
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // base64-ish 긴 문자열 (40자+ 영숫자/=) — 보수적 mask
  /\b[A-Za-z0-9+/=_-]{40,}\b/g,
];

const MASK = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_STRING_PREVIEW = 2000;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

/** 문자열 내 토큰 패턴 mask. 긴 문자열은 잘라냄 (Sentry payload 비대 방지). */
function maskString(s: string): string {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const pat of TOKEN_PATTERNS) {
    out = out.replace(pat, MASK);
  }
  if (out.length > MAX_STRING_PREVIEW) {
    out = out.slice(0, MAX_STRING_PREVIEW) + `... [truncated ${s.length - MAX_STRING_PREVIEW} chars]`;
  }
  return out;
}

/** 재귀 sanitize. depth 제한 + 순환 참조 방어 (seen WeakSet) */
function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[max depth]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return maskString(value as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function' || t === 'symbol') return undefined;

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map(v => sanitize(v, depth + 1, seen));
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSensitiveKey(k)) {
        out[k] = MASK;
      } else {
        out[k] = sanitize(v, depth + 1, seen);
      }
    }
    return out;
  }

  return value;
}

/**
 * Sentry 이벤트 sanitize. 발견되는 PII 노출 지점:
 *   - event.message (raw text)
 *   - event.exception.values[].value (에러 메시지)
 *   - event.exception.values[].stacktrace.frames[].vars (스택 변수)
 *   - event.contexts (런타임 컨텍스트)
 *   - event.extra (사용자 추가 데이터)
 *   - event.breadcrumbs[].data
 *   - event.request.headers / cookies / data
 *   - event.tags
 *   - event.user (email/id 외 추가 필드)
 */
export function sanitizeSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
  // sanitize 자체가 throw 하면 Sentry SDK 가 그대로 보낼 수 있으므로 broad catch
  try {
    const seen = new WeakSet<object>();
    return sanitize(event, 0, seen) as Record<string, unknown>;
  } catch {
    // sanitize 실패 시 안전한 최소 정보만 (메시지 없이)
    return {
      level: event.level ?? 'error',
      timestamp: event.timestamp,
      // 원본 message·exception 모두 폐기 — 누설 위험
      message: '[sanitize failed]',
    };
  }
}

/** breadcrumb 단독 hook (Sentry beforeBreadcrumb 옵션) */
export function sanitizeBreadcrumb(crumb: Record<string, unknown>): Record<string, unknown> {
  try {
    const seen = new WeakSet<object>();
    return sanitize(crumb, 0, seen) as Record<string, unknown>;
  } catch {
    return { type: 'default', level: 'error', message: '[sanitize failed]' };
  }
}
