/**
 * 대화 메시지 union merge 테스트.
 *
 * `core/utils/message-merge.ts` 의 unionMergeMessages —
 * ConversationManager.save 안에서 모바일·PC 동시 쓰기 시 다른 기기 메시지 유실 방지.
 *
 * 핵심 invariant:
 *   - 동일 id 는 incoming 우선 (최신 데이터 덮어쓰기)
 *   - 다른 id 는 둘 다 보존 (union)
 *   - timestamp (id 안 숫자) 순 정렬 — out-of-order 저장 방어
 *   - id 없는 메시지는 incoming append
 */
import { describe, it, expect } from 'vitest';
import { unionMergeMessages } from '../core/utils/message-merge';

describe('unionMergeMessages — 다기기 동시 쓰기 방어', () => {
  describe('union 동작 — 동일 id 는 incoming 우선', () => {
    it('빈 배열끼리 → 빈 배열', () => {
      expect(unionMergeMessages([], [])).toEqual([]);
    });

    it('existing 만 있음 → existing 그대로', () => {
      const existing = [{ id: 'u-1700000000000', content: 'hi' }];
      expect(unionMergeMessages(existing, [])).toEqual(existing);
    });

    it('incoming 만 있음 → incoming 그대로', () => {
      const incoming = [{ id: 'u-1700000000000', content: 'hi' }];
      expect(unionMergeMessages([], incoming)).toEqual(incoming);
    });

    it('동일 id → incoming 의 값 우선 (existing 덮어쓰기)', () => {
      const existing = [{ id: 'u-1700000000000', content: 'old' }];
      const incoming = [{ id: 'u-1700000000000', content: 'new' }];
      const result = unionMergeMessages(existing, incoming);
      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toBe('new');
    });

    it('다른 id → 둘 다 보존 (union)', () => {
      const existing = [{ id: 'u-1700000000000', content: 'a' }];
      const incoming = [{ id: 's-1700000000001', content: 'b' }];
      const result = unionMergeMessages(existing, incoming);
      expect(result).toHaveLength(2);
      const ids = result.map((m: any) => m.id);
      expect(ids).toContain('u-1700000000000');
      expect(ids).toContain('s-1700000000001');
    });
  });

  describe('timestamp 순 정렬 — out-of-order 저장 방어', () => {
    it('timestamp 순으로 자동 정렬', () => {
      const existing = [
        { id: 'u-1700000000003', content: 'third' },
        { id: 'u-1700000000001', content: 'first' },
      ];
      const incoming = [
        { id: 's-1700000000002', content: 'second' },
      ];
      const result = unionMergeMessages(existing, incoming);
      expect(result.map((m: any) => m.content)).toEqual(['first', 'second', 'third']);
    });

    it('id 에 timestamp 없으면 맨 앞 (ts=0) — system-init 같은 케이스', () => {
      const existing = [
        { id: 'system-init', content: 'init' },
        { id: 'u-1700000000001', content: 'first' },
      ];
      const incoming = [
        { id: 's-1700000000002', content: 'second' },
      ];
      const result = unionMergeMessages(existing, incoming);
      expect(result[0]).toEqual({ id: 'system-init', content: 'init' });
    });
  });

  describe('id 없는 메시지 — append (순서 불확실하지만 보존)', () => {
    it('id 없는 incoming 메시지는 뒤에 append', () => {
      const existing = [{ id: 'u-1700000000001', content: 'first' }];
      const incoming = [{ content: 'no-id' }];
      const result = unionMergeMessages(existing, incoming);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'u-1700000000001', content: 'first' });
      expect(result[1]).toEqual({ content: 'no-id' });
    });

    it('reference 동일한 id 없는 메시지 → 중복 제거', () => {
      const sameRef = { content: 'shared' };
      const existing = [sameRef];
      const incoming = [sameRef];
      const result = unionMergeMessages(existing, incoming);
      expect(result).toHaveLength(1);
    });
  });

  describe('다기기 동시 쓰기 시나리오 — 모바일·PC 양쪽 메시지 보존', () => {
    it('PC 가 메시지 A, B 추가 + 모바일이 메시지 C 추가 → 셋 모두 보존', () => {
      // 시간선:
      //  - PC: 기존 [A,B] 가져옴 → 메시지 D 추가 → save([A,B,D])
      //  - 모바일: 기존 [A,B] 가져옴 → 메시지 C 추가 → save([A,B,C]) (PC 의 D 못 봄)
      //  - 서버 merge: PC 가 먼저 도달 → DB=[A,B,D]. 모바일 도달 → merge([A,B,D], [A,B,C]) → [A,B,C,D]
      const existing = [
        { id: 'u-1700000000001', content: 'A' },
        { id: 's-1700000000002', content: 'B' },
        { id: 's-1700000000004', content: 'D-from-pc' },
      ];
      const incoming = [
        { id: 'u-1700000000001', content: 'A' },
        { id: 's-1700000000002', content: 'B' },
        { id: 's-1700000000003', content: 'C-from-mobile' },
      ];
      const result = unionMergeMessages(existing, incoming);
      expect(result).toHaveLength(4);
      expect(result.map((m: any) => m.content)).toEqual([
        'A', 'B', 'C-from-mobile', 'D-from-pc',
      ]);
    });

    it('동일 message id 양쪽 동시 편집 → incoming(=서버 도달 늦은 쪽) 우선', () => {
      const existing = [
        { id: 'u-1700000000001', content: 'PC 가 먼저 저장한 내용' },
      ];
      const incoming = [
        { id: 'u-1700000000001', content: '모바일이 나중에 저장한 내용' },
      ];
      const result = unionMergeMessages(existing, incoming);
      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toBe('모바일이 나중에 저장한 내용');
    });
  });

  describe('edge cases — invalid 입력', () => {
    it('null / undefined 메시지 — id 없으므로 noIdMsgs 로', () => {
      const result = unionMergeMessages([null, undefined], [{ id: 'u-1700000000001' }]);
      // null/undefined 도 reference 비교 통과해 noIdMsgs 에 들어감
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.find((m: any) => m?.id === 'u-1700000000001')).toBeDefined();
    });

    it('id 가 빈 문자열 — id 없는 것으로 처리', () => {
      const existing = [{ id: '', content: 'a' }];
      const incoming = [{ id: 'u-1700000000001', content: 'b' }];
      const result = unionMergeMessages(existing, incoming);
      expect(result.find((m: any) => m.id === 'u-1700000000001')).toBeDefined();
    });

    it('id 가 number 타입 — string 아니므로 id 없는 것으로 처리', () => {
      const existing = [{ id: 1700000000001, content: 'a' }];
      const incoming = [{ id: 'u-1700000000001', content: 'b' }];
      const result = unionMergeMessages(existing, incoming);
      expect(result.find((m: any) => m.id === 'u-1700000000001')).toBeDefined();
    });
  });
});
