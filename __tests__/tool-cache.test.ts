import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toolCacheKey, getCachedToolResult, setCachedToolResult, clearToolCache, toolCacheSize } from '../lib/tool-cache';

describe('tool-cache', () => {
  beforeEach(() => {
    clearToolCache();
    vi.useRealTimers();
  });

  describe('toolCacheKey', () => {
    it('동일 도구·동일 인자 → 동일 키', () => {
      const k1 = toolCacheKey('image_gen', { prompt: 'cat', size: '1024' });
      const k2 = toolCacheKey('image_gen', { prompt: 'cat', size: '1024' });
      expect(k1).toBe(k2);
    });

    it('인자 순서 무관 (stable hash) — { a, b } === { b, a }', () => {
      const k1 = toolCacheKey('test', { a: 1, b: 2 });
      const k2 = toolCacheKey('test', { b: 2, a: 1 });
      expect(k1).toBe(k2);
    });

    it('도구 이름 다르면 키 다름', () => {
      const k1 = toolCacheKey('image_gen', { prompt: 'cat' });
      const k2 = toolCacheKey('search_components', { prompt: 'cat' });
      expect(k1).not.toBe(k2);
    });

    it('인자 값 다르면 키 다름', () => {
      const k1 = toolCacheKey('image_gen', { prompt: 'cat' });
      const k2 = toolCacheKey('image_gen', { prompt: 'dog' });
      expect(k1).not.toBe(k2);
    });

    it('인자 없음 / 빈 객체 → 같은 키 (canonical 처리)', () => {
      const k1 = toolCacheKey('foo', undefined);
      const k2 = toolCacheKey('foo', {});
      expect(k1).toBe(k2);
    });

    it('중첩 객체도 stable — { a: { b: 1, c: 2 } } === { a: { c: 2, b: 1 } }', () => {
      const k1 = toolCacheKey('test', { a: { b: 1, c: 2 } });
      const k2 = toolCacheKey('test', { a: { c: 2, b: 1 } });
      expect(k1).toBe(k2);
    });

    it('배열 순서는 유의미 — [1,2] !== [2,1]', () => {
      const k1 = toolCacheKey('test', { arr: [1, 2] });
      const k2 = toolCacheKey('test', { arr: [2, 1] });
      expect(k1).not.toBe(k2);
    });
  });

  describe('cache hit/miss', () => {
    it('miss 시 null', () => {
      const key = toolCacheKey('foo', {});
      expect(getCachedToolResult(key)).toBeNull();
    });

    it('set 후 hit', () => {
      const key = toolCacheKey('foo', {});
      setCachedToolResult(key, { success: true, data: 'ok' });
      expect(getCachedToolResult(key)).toEqual({ success: true, data: 'ok' });
    });

    it('TTL 초과 시 자동 만료 + cache 정리', () => {
      vi.useFakeTimers();
      const key = toolCacheKey('foo', {});
      setCachedToolResult(key, { success: true, data: 'ok' });
      expect(getCachedToolResult(key)).not.toBeNull();
      // 60초 + 1ms 경과
      vi.advanceTimersByTime(60_001);
      expect(getCachedToolResult(key)).toBeNull();
    });
  });

  describe('실패 결과는 cache 안 함 (재시도 허용)', () => {
    it('success: false 는 set 무시', () => {
      const key = toolCacheKey('foo', {});
      setCachedToolResult(key, { success: false, error: 'timeout' });
      expect(getCachedToolResult(key)).toBeNull();
    });

    it('success 플래그 없는 결과는 cache 됨 (success: undefined != false)', () => {
      const key = toolCacheKey('foo', {});
      setCachedToolResult(key, { data: 'plain' });
      expect(getCachedToolResult(key)).toEqual({ data: 'plain' });
    });
  });

  describe('LRU evict (MAX_CACHE_SIZE=200 근사)', () => {
    it('200 초과 시 가장 오래된 entry 제거', () => {
      // 시간 차이를 만들기 위해 fake timer 사용 — entry ts 가 다르면 oldest 추출 가능
      vi.useFakeTimers();
      vi.setSystemTime(0);
      // 200개 채움
      for (let i = 0; i < 200; i++) {
        vi.setSystemTime(i * 10);
        setCachedToolResult(toolCacheKey('tool', { i }), { data: i });
      }
      expect(toolCacheSize()).toBe(200);
      // 201번째 추가 → 가장 오래된 (i=0) 제거
      vi.setSystemTime(2_000);
      setCachedToolResult(toolCacheKey('tool', { i: 200 }), { data: 200 });
      expect(toolCacheSize()).toBe(200);
      expect(getCachedToolResult(toolCacheKey('tool', { i: 0 }))).toBeNull();
      expect(getCachedToolResult(toolCacheKey('tool', { i: 200 }))).not.toBeNull();
    });
  });
});
