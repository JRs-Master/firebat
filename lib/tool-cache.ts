/**
 * Tool Call Cache — 도구 호출 idempotency + per-turn duplicate guard.
 *
 * 배경: AI 가 timeout/error 응답 받고 같은 인자로 retry 하는 패턴 (CLI 모드 image_gen 비용 폭탄 사건).
 * 백엔드는 정상 처리됐는데 응답만 늦은 상태에서 AI 가 retry → 중복 부작용 발생.
 *
 * 해결: 모든 도구 호출에 일반적으로 적용되는 2-Layer 가드.
 *
 *   Layer 1 — Cross-turn idempotency cache (60초 TTL)
 *     같은 (toolName + argsHash) 가 60초 내 호출됐으면 직전 결과 그대로 반환.
 *     AI 가 retry 해도 백엔드는 한 번만 실행. 추가 비용 0.
 *
 *   Layer 2 — Per-turn duplicate set
 *     한 turn 안에서 같은 (toolName + argsHash) 두 번째 호출 차단.
 *     AI 한테 "이미 호출됨" 즉시 응답 → AI 가 결과 사용하거나 다른 인자로 진행.
 *
 * 일반 로직 — 도구 이름·인자 형태·비용 무관. 모든 도구에 동등 적용.
 */

import { createHash } from 'crypto';

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_SIZE = 200;

interface CachedEntry {
  result: Record<string, unknown>;
  ts: number;
}

const cache = new Map<string, CachedEntry>();

/** Stable hash — key 순서 무관, 동일 객체는 동일 hash. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function toolCacheKey(name: string, args: Record<string, unknown> | undefined): string {
  const canonical = stableStringify(args ?? {});
  const hash = createHash('sha256').update(name + ':' + canonical).digest('hex').slice(0, 16);
  return `${name}:${hash}`;
}

/** Cache miss 면 null. Hit 면 cached result. */
export function getCachedToolResult(key: string): Record<string, unknown> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

/** 호출 성공 시만 cache. error 결과는 cache 안 함 (다음 호출은 재시도 가능). */
export function setCachedToolResult(key: string, result: Record<string, unknown>): void {
  // 명시적 실패는 cache 에서 제외 — AI 가 다른 시점에 retry 시 (인프라 회복 등) 재시도 가능
  if (result.success === false) return;
  // 크기 제한 — 가장 오래된 entry 제거 (LRU 근사)
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { result, ts: Date.now() });
}

/** 디버깅·테스트용 — 강제 비우기 */
export function clearToolCache(): void {
  cache.clear();
}

/** 디버깅용 — 현재 cache 크기 */
export function toolCacheSize(): number {
  return cache.size;
}
