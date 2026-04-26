/**
 * CONDITION 평가 테스트.
 *
 * `core/utils/condition.ts` 의 evaluateCondition — pipeline CONDITION step + cron oneShot 자동 취소
 * 양쪽에서 사용. 자동매매 로직 핵심이라 정확성 보장 필수 (잘못된 분기 = 오발주 위험).
 *
 * 이전엔 task-manager / schedule-manager 에 inline 중복 구현 + 미묘한 차이 (bothNumeric 가드 /
 * 비숫자 `<` 처리 / exists 의 빈 문자열) 가 있어 silent inconsistency. 단일 source 통합 후 테스트.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../core/utils/condition';

describe('evaluateCondition — 자동매매 안전 정책', () => {
  describe('숫자 비교 (자동매매 핵심 — 가격·수량)', () => {
    it('"75000" < 80000 → true (string→number 변환)', () => {
      expect(evaluateCondition('75000', '<', 80000)).toBe(true);
    });
    it('80000 >= "75000" → true', () => {
      expect(evaluateCondition(80000, '>=', '75000')).toBe(true);
    });
    it('75000 == "75000" → true (string vs number 자동 매칭)', () => {
      expect(evaluateCondition(75000, '==', '75000')).toBe(true);
    });
    it('75000.5 < 75001 → true (소수 비교)', () => {
      expect(evaluateCondition(75000.5, '<', 75001)).toBe(true);
    });
    it('0 < 1 → true (0 처리)', () => {
      expect(evaluateCondition(0, '<', 1)).toBe(true);
    });
    it('-1000 < 0 → true (음수 처리)', () => {
      expect(evaluateCondition(-1000, '<', 0)).toBe(true);
    });
  });

  describe('비숫자 비교 — string compare 절대 안 함 (자동매매 안전)', () => {
    it('"abc" < "xyz" → false (string compare 회피 — undefined 동작)', () => {
      expect(evaluateCondition('abc', '<', 'xyz')).toBe(false);
    });
    it('"abc" > "xyz" → false', () => {
      expect(evaluateCondition('abc', '>', 'xyz')).toBe(false);
    });
    it('"75000원" < 80000 → false (단위 섞이면 numeric 변환 실패)', () => {
      expect(evaluateCondition('75000원', '<', 80000)).toBe(false);
    });
  });

  describe('==, != — string equality fallback', () => {
    it('"buy" == "buy" → true', () => {
      expect(evaluateCondition('buy', '==', 'buy')).toBe(true);
    });
    it('"buy" != "sell" → true', () => {
      expect(evaluateCondition('buy', '!=', 'sell')).toBe(true);
    });
    it('null == "" → false (string 비교는 "null" vs "")', () => {
      expect(evaluateCondition(null, '==', '')).toBe(false);
    });
  });

  describe('exists / not_exists — 빈 문자열 = not exists (sysmod 빈 응답 케이스)', () => {
    it('exists: "value" → true', () => {
      expect(evaluateCondition('value', 'exists')).toBe(true);
    });
    it('exists: 0 → true (숫자 0 은 값 존재)', () => {
      expect(evaluateCondition(0, 'exists')).toBe(true);
    });
    it('exists: "" → false (빈 응답 = 데이터 없음)', () => {
      expect(evaluateCondition('', 'exists')).toBe(false);
    });
    it('exists: null → false', () => {
      expect(evaluateCondition(null, 'exists')).toBe(false);
    });
    it('exists: undefined → false', () => {
      expect(evaluateCondition(undefined, 'exists')).toBe(false);
    });
    it('not_exists: "" → true', () => {
      expect(evaluateCondition('', 'not_exists')).toBe(true);
    });
    it('not_exists: null → true', () => {
      expect(evaluateCondition(null, 'not_exists')).toBe(true);
    });
  });

  describe('includes / not_includes — 문자열 검색 (뉴스·상태 검사)', () => {
    it('"매수 체결 완료" includes "체결" → true', () => {
      expect(evaluateCondition('매수 체결 완료', 'includes', '체결')).toBe(true);
    });
    it('"매수 실패" not_includes "성공" → true', () => {
      expect(evaluateCondition('매수 실패', 'not_includes', '성공')).toBe(true);
    });
    it('숫자도 string 변환 후 검색 — 25000 includes "25" → true', () => {
      expect(evaluateCondition(25000, 'includes', '25')).toBe(true);
    });
  });

  describe('자동매매 시나리오 — 실전 패턴', () => {
    it('현재가 < 매수목표 → 매수 진행 (oneShot 자동매매 핵심)', () => {
      const currentPrice = 74500;
      const targetPrice = 75000;
      expect(evaluateCondition(currentPrice, '<', targetPrice)).toBe(true);
    });
    it('현재가 >= 익절가 → 매도 진행', () => {
      const currentPrice = 82000;
      const sellPrice = 80000;
      expect(evaluateCondition(currentPrice, '>=', sellPrice)).toBe(true);
    });
    it('체결 결과 includes "정상" → 알림 진행', () => {
      const result = '주문 정상 체결';
      expect(evaluateCondition(result, 'includes', '정상')).toBe(true);
    });
    it('잔고 exists → 매도 가능 검사', () => {
      expect(evaluateCondition(100, 'exists')).toBe(true);
      expect(evaluateCondition(0, 'exists')).toBe(true); // 0주도 응답은 있음
      expect(evaluateCondition(null, 'exists')).toBe(false); // null = 조회 실패
    });
    it('휴장일 ("Y" includes "Y") → 자동매매 skip', () => {
      const isHoliday = 'Y';
      expect(evaluateCondition(isHoliday, '==', 'Y')).toBe(true);
    });
  });

  describe('edge cases — 잘못된 op·undefined expected', () => {
    it('알 수 없는 op → false', () => {
      expect(evaluateCondition(1, 'unknown_op' as any, 1)).toBe(false);
    });
    it('expected undefined + 비교 op → numeric 비교 불가 → false', () => {
      expect(evaluateCondition(1, '<', undefined)).toBe(false);
    });
    it('exists 는 expected 무관 — undefined 넘겨도 정상', () => {
      expect(evaluateCondition('value', 'exists', undefined)).toBe(true);
    });
  });

  describe('미묘한 동작 — 이전 inline 구현 차이 흡수', () => {
    it('actual=null, op=== → string compare ("null" vs ""): false', () => {
      expect(evaluateCondition(null, '==', '')).toBe(false);
    });
    it('actual=null, op=== expected=null → string "null" === "null": true', () => {
      expect(evaluateCondition(null, '==', null)).toBe(true);
    });
    it('actual=undefined, op=!=, expected=undefined → false (둘 다 "undefined")', () => {
      expect(evaluateCondition(undefined, '!=', undefined)).toBe(false);
    });
    it('boolean: true == "true" → true (string compare)', () => {
      expect(evaluateCondition(true, '==', 'true')).toBe(true);
    });
    it('boolean: false != "true" → true', () => {
      expect(evaluateCondition(false, '!=', 'true')).toBe(true);
    });
  });
});
