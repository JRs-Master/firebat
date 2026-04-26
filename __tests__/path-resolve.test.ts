import { describe, it, expect } from 'vitest';
import { resolveFieldPath } from '../core/utils/path-resolve';

/**
 * resolveFieldPath — 객체·배열 path 해석.
 *
 * cron runWhen 의 휴장일 가드, pipeline $prev.path, AI 가 sysmod array 응답
 * 결과에서 특정 인덱스 값 추출하는 일반 메커니즘. 새 유틸 도입 시 silent breakage
 * 방지용.
 */

describe('resolveFieldPath', () => {
  describe('점 표기 (단순 객체 path)', () => {
    it('단일 키', () => {
      expect(resolveFieldPath({ foo: 1 }, 'foo')).toBe(1);
    });
    it('중첩 키', () => {
      expect(resolveFieldPath({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
    });
    it('빈 path → 객체 그대로', () => {
      const obj = { a: 1 };
      expect(resolveFieldPath(obj, '')).toBe(obj);
    });
    it('없는 키 → undefined', () => {
      expect(resolveFieldPath({ foo: 1 }, 'bar')).toBeUndefined();
    });
    it('중간이 null → undefined', () => {
      expect(resolveFieldPath({ a: null }, 'a.b')).toBeUndefined();
    });
  });

  describe('대괄호 array index — 한투 chk-holiday 같은 응답 패턴', () => {
    it('output[0].opnd_yn — 첫 일자 개장 여부', () => {
      const apiResp = {
        output: [
          { bass_dt: '20260427', opnd_yn: 'Y', bzdy_yn: 'Y' },
          { bass_dt: '20260428', opnd_yn: 'Y', bzdy_yn: 'Y' },
        ],
      };
      expect(resolveFieldPath(apiResp, 'output[0].opnd_yn')).toBe('Y');
      expect(resolveFieldPath(apiResp, 'output[1].bass_dt')).toBe('20260428');
    });

    it('output[0] 만 — 객체 그대로 반환', () => {
      const apiResp = { output: [{ x: 1 }, { x: 2 }] };
      expect(resolveFieldPath(apiResp, 'output[0]')).toEqual({ x: 1 });
    });

    it('다차원 array — foo[1][2]', () => {
      const obj = { foo: [['a', 'b', 'c'], ['d', 'e', 'f']] };
      expect(resolveFieldPath(obj, 'foo[1][2]')).toBe('f');
    });

    it('점 표기로 인덱스 — output.0.x (대괄호 없이)', () => {
      const obj = { output: [{ x: 'first' }] };
      expect(resolveFieldPath(obj, 'output.0.x')).toBe('first');
    });
  });

  describe('음수 index — 뒤에서 N번째', () => {
    it('items[-1] — 마지막 요소', () => {
      const obj = { items: [1, 2, 3, 4] };
      expect(resolveFieldPath(obj, 'items[-1]')).toBe(4);
    });
    it('items[-2].name', () => {
      const obj = { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
      expect(resolveFieldPath(obj, 'items[-2].name')).toBe('b');
    });
    it('범위 초과 음수 → undefined', () => {
      expect(resolveFieldPath({ items: [1] }, 'items[-5]')).toBeUndefined();
    });
  });

  describe('edge case', () => {
    it('array 인데 비정수 키 → undefined', () => {
      expect(resolveFieldPath({ arr: [1, 2] }, 'arr.foo')).toBeUndefined();
    });
    it('범위 밖 양수 index → undefined', () => {
      expect(resolveFieldPath({ arr: [1] }, 'arr[5]')).toBeUndefined();
    });
    it('object 의 숫자 string 키 — payload[0] 가 array 가 아니어도 OK', () => {
      const obj = { payload: { '0': 'zero', '1': 'one' } };
      expect(resolveFieldPath(obj, 'payload[0]')).toBe('zero');
      expect(resolveFieldPath(obj, 'payload.1')).toBe('one');
    });
    it('null 입력 → undefined (빈 path 제외)', () => {
      expect(resolveFieldPath(null, 'foo')).toBeUndefined();
    });
    it('빈 segment ("foo..bar") 무시', () => {
      expect(resolveFieldPath({ foo: { bar: 1 } }, 'foo..bar')).toBe(1);
    });
  });
});
