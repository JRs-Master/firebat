import { describe, it, expect } from 'vitest';
import { TaskManager } from '../core/managers/task-manager';

/**
 * resolveValue 테스트 — 자동매매 pipeline 의 backbone.
 *
 * 과거 silent breakage 패턴:
 *   - $prev.key 가 객체일 때 String(obj) → "[object Object]" 박힘 → 다음 step 뻑남
 *   - LLM_TRANSFORM 결과가 단일 string 일 때 $prev.text 패턴이 리터럴 유지
 *   - 문자열 내 $prev / $prev.key 치환이 빠지는 케이스
 *
 * 본 테스트가 잡는 것: 위 모든 분기 + 미래의 silent breakage.
 */

// resolveValue 는 this 상태 안 씀 — 빈 mock 으로 충분.
// FirebatCore 등 cascade 의존성 import 회피 위해 unknown as any.
const tm = new TaskManager({} as any, {} as any, {} as any);

describe('resolveValue — $prev 치환', () => {
  describe('단일 $prev', () => {
    it('prev 가 string 이면 그대로 반환', () => {
      expect(tm.resolveValue('$prev', 'hello')).toBe('hello');
    });

    it('prev 가 객체면 JSON.stringify', () => {
      expect(tm.resolveValue('$prev', { a: 1 })).toBe('{"a":1}');
    });

    it('prev 가 number 면 JSON.stringify', () => {
      expect(tm.resolveValue('$prev', 42)).toBe('42');
    });
  });

  describe('$prev.key 단독 (exact match — 원본 값 보존)', () => {
    it('객체에서 key 추출 — 객체 그대로 반환 (다음 step 이 객체 수용 가능)', () => {
      expect(tm.resolveValue('$prev.user', { user: { id: 1, name: 'a' } }))
        .toEqual({ id: 1, name: 'a' });
    });

    it('객체에서 string 추출', () => {
      expect(tm.resolveValue('$prev.title', { title: '삼성전자' }))
        .toBe('삼성전자');
    });

    it('객체에서 number 추출', () => {
      expect(tm.resolveValue('$prev.price', { price: 75000 }))
        .toBe(75000);
    });

    it('prev 가 string 일 때 $prev.text 같은 패턴 — string 자체 폴백 (LLM_TRANSFORM 결과 호환)', () => {
      expect(tm.resolveValue('$prev.text', 'plain string'))
        .toBe('plain string');
    });

    it('속성 없고 prev 가 객체 — 원본 패턴 유지 (caller 가 처리)', () => {
      expect(tm.resolveValue('$prev.missing', { other: 1 }))
        .toBe('$prev.missing');
    });
  });

  describe('문자열 안 $prev 치환', () => {
    it('"가격: $prev.price 원" 패턴', () => {
      expect(tm.resolveValue('가격: $prev.price 원', { price: 75000 }))
        .toBe('가격: 75000 원');
    });

    it('객체 값은 JSON.stringify (이전 silent breakage fix — "[object Object]" 박힘 방지)', () => {
      expect(tm.resolveValue('데이터: $prev.user', { user: { id: 1 } }))
        .toBe('데이터: {"id":1}');
    });

    it('여러 $prev.key 치환', () => {
      expect(tm.resolveValue('$prev.title — $prev.price 원', { title: '삼성', price: 75000 }))
        .toBe('삼성 — 75000 원');
    });

    it('단독 $prev (key 없음) 도 문자열 안에서 치환', () => {
      expect(tm.resolveValue('결과: $prev', 'OK'))
        .toBe('결과: OK');
    });

    it('단독 $prev — prev 가 객체면 JSON 박힘', () => {
      expect(tm.resolveValue('결과: $prev', { a: 1 }))
        .toBe('결과: {"a":1}');
    });

    it('속성 없는 key 는 원본 패턴 유지', () => {
      expect(tm.resolveValue('$prev.missing 값', { other: 1 }))
        .toBe('$prev.missing 값');
    });

    it('prev 가 string 인데 .key 패턴 → string 폴백 (LLM_TRANSFORM 호환)', () => {
      expect(tm.resolveValue('text: $prev.text', 'plain'))
        .toBe('text: plain');
    });
  });

  describe('객체·배열 재귀', () => {
    it('객체 안 $prev.key 모두 치환', () => {
      const result = tm.resolveValue(
        { symbol: '$prev.symbol', qty: '$prev.qty' },
        { symbol: '005930', qty: 10 },
      );
      expect(result).toEqual({ symbol: '005930', qty: 10 });
    });

    it('배열 안 $prev.key 도 치환', () => {
      const result = tm.resolveValue(
        ['$prev.a', '$prev.b'],
        { a: 1, b: 2 },
      );
      expect(result).toEqual([1, 2]);
    });

    it('중첩 구조 재귀', () => {
      const result = tm.resolveValue(
        { order: { symbol: '$prev.symbol', meta: { ts: '$prev.ts' } } },
        { symbol: '005930', ts: 12345 },
      );
      expect(result).toEqual({ order: { symbol: '005930', meta: { ts: 12345 } } });
    });
  });

  describe('치환 대상 아닌 값 통과', () => {
    it('숫자·boolean·null 그대로', () => {
      expect(tm.resolveValue(42, {})).toBe(42);
      expect(tm.resolveValue(true, {})).toBe(true);
      expect(tm.resolveValue(null, {})).toBeNull();
    });

    it('$prev 안 들어간 string 은 그대로', () => {
      expect(tm.resolveValue('hello', { x: 1 })).toBe('hello');
    });
  });

  describe('array index path — sysmod array 응답 (chk-holiday 등) 일반 메커니즘', () => {
    const holidayResp = {
      output: [
        { bass_dt: '20260427', opnd_yn: 'Y' },
        { bass_dt: '20260428', opnd_yn: 'Y' },
        { bass_dt: '20260429', opnd_yn: 'N' },
      ],
    };

    it('$prev.output[0].opnd_yn — exact match (객체 응답에서 인덱스 + 키)', () => {
      expect(tm.resolveValue('$prev.output[0].opnd_yn', holidayResp)).toBe('Y');
      expect(tm.resolveValue('$prev.output[2].opnd_yn', holidayResp)).toBe('N');
    });

    it('$prev.output[0] — 인덱스만 (객체 그대로)', () => {
      expect(tm.resolveValue('$prev.output[0]', holidayResp)).toEqual({ bass_dt: '20260427', opnd_yn: 'Y' });
    });

    it('$prev.output[-1].opnd_yn — 음수 인덱스 (마지막)', () => {
      expect(tm.resolveValue('$prev.output[-1].opnd_yn', holidayResp)).toBe('N');
    });

    it('$stepN.items[0].name — step 결과의 array', () => {
      const stepResults = [undefined, undefined, { items: [{ name: '삼성전자' }, { name: 'LG' }] }];
      expect(tm.resolveValue('$step2.items[0].name', undefined, stepResults)).toBe('삼성전자');
      expect(tm.resolveValue('$step2.items[1].name', undefined, stepResults)).toBe('LG');
    });

    it('문자열 내 보간 — "오늘 개장: $prev.output[0].opnd_yn"', () => {
      expect(tm.resolveValue('오늘 개장: $prev.output[0].opnd_yn', holidayResp))
        .toBe('오늘 개장: Y');
    });

    it('범위 밖 인덱스 → 패턴 그대로 (preserve)', () => {
      expect(tm.resolveValue('$prev.output[99].opnd_yn', holidayResp))
        .toBe('$prev.output[99].opnd_yn');
    });

    it('점 표기 인덱스도 OK — $prev.output.0.opnd_yn', () => {
      expect(tm.resolveValue('$prev.output.0.opnd_yn', holidayResp)).toBe('Y');
    });
  });
});
