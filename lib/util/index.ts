/**
 * Utility 모듈 re-export — Phase 1 정공 (2026-05-13).
 *
 * 호출 site 가 `import { safeJsonParse, TIME, shortId, buildUrl } from '@/lib/util'` 단일 import.
 *
 * 카테고리:
 * - `json`     : safeJsonParse / parseJsonOrThrow / safeJsonStringify
 * - `time`     : TIME / formatRelativeTime / formatDate / nowIso / daysSince
 * - `id`       : shortId / safeUuid / prefixedId / normalizeSlug
 * - `url`      : buildUrl / buildPath / parseQuery
 */

export * from './json';
export * from './time';
export * from './id';
export * from './url';
