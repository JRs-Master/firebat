/**
 * 공용 토큰·시크릿 redactor — 로그·Sentry·외부 노출 가능 출력 모두 통과.
 *
 * 일반 로직 — 특정 keyspace 분기 X. 알려진 토큰 prefix 패턴과 시크릿 키 이름 패턴
 *  으로 광범위 mask. False positive (긴 base64 문자열 etc.) 는 보수적으로 mask.
 *
 * 사용:
 *   - logger.info/warn/error meta 객체에 적용 → 로그 파일·콘솔 누설 방지.
 *   - Training JSONL 에 적용 → 파인튜닝 데이터 보호.
 *   - Sentry beforeSend 에서 동일 패턴 활용 (observability/pii-sanitizer.ts 가 별도 구현).
 */

const SENSITIVE_KEY_RE = /(password|passwd|secret|token|api[-_]?key|authorization|bearer|credential|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|session[-_]?id|cookie|vault)/i;

const TOKEN_PATTERNS: RegExp[] = [
  /fbat_[a-f0-9]{16,}/gi,
  /fbt_[a-f0-9]{16,}/gi,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b/g,    // Telegram bot token
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,  // JWT
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b[A-Za-z0-9+/=_-]{40,}\b/g,             // 보수적 — 긴 base64 like
];

const MASK = '[REDACTED]';

/** 문자열 안의 알려진 토큰 패턴을 mask. 원본 문자열이 아니면 String 변환 후 적용. */
export function redactString(s: unknown): string {
  if (s === null || s === undefined) return '';
  let out = typeof s === 'string' ? s : String(s);
  for (const pat of TOKEN_PATTERNS) out = out.replace(pat, MASK);
  return out;
}

/** 객체의 모든 string value 에 redactString 적용 + 민감 키 이름은 value 통째 mask.
 *  깊이 8 + 순환 참조 방어 + 결정적 출력. */
export function redactMeta<T = unknown>(value: T, depth = 0, seen?: WeakSet<object>): T {
  if (depth > 8) return ('[max depth]' as unknown) as T;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return (redactString(value) as unknown) as T;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function' || t === 'symbol') return (undefined as unknown) as T;
  const s = seen ?? new WeakSet<object>();
  if (Array.isArray(value)) {
    if (s.has(value)) return ('[circular]' as unknown) as T;
    s.add(value);
    return (value.map(v => redactMeta(v, depth + 1, s)) as unknown) as T;
  }
  if (t === 'object') {
    const obj = value as unknown as Record<string, unknown>;
    if (s.has(obj)) return ('[circular]' as unknown) as T;
    s.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = MASK;
      } else {
        out[k] = redactMeta(v, depth + 1, s);
      }
    }
    return (out as unknown) as T;
  }
  return value;
}
