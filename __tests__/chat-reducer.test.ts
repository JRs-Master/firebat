import { describe, it, expect } from 'vitest';
import { chatReducer, FALLBACK, THINKING_STATUS, isTerminal, hasVisible } from '../app/admin/hooks/chat-manager';
import type { Message } from '../app/admin/types';

/**
 * chat-manager reducer 인바리언트 — 로봇 사라짐 (4번 fix) 의 backbone.
 *
 * 핵심 보장: 터미널 상태 (!isThinking && !executing && !streaming) 인데 visible 콘텐츠 0 이면
 *   자동 fallback 채워넣기 → 빈 버블 / 로봇 사라짐 구조적 불가능.
 *
 * 본 테스트가 잡는 것: 미래의 누군가 RESULT/ERROR/TIMEOUT 액션 본문 수정 시 invariant 누락.
 */

const userMsg = (id: string, content: string): Message => ({ id, role: 'user', content });
const systemPending = (id: string): Message => ({ id, role: 'system', isThinking: true });

describe('chat-manager reducer 인바리언트', () => {
  describe('SEND_USER — user + pending system 동시 push', () => {
    it('빈 state 에 user 메시지 + thinking system 추가', () => {
      const next = chatReducer([], { type: 'SEND_USER', userId: 'u-1', systemId: 's-1', content: '안녕' });
      expect(next).toHaveLength(2);
      expect(next[0]).toMatchObject({ id: 'u-1', role: 'user', content: '안녕' });
      expect(next[1]).toMatchObject({ id: 's-1', role: 'system', isThinking: true });
    });
  });

  describe('터미널 상태 + visible 0 = 자동 fallback', () => {
    it('RESULT payload 가 reply / blocks / suggestions 모두 비어도 visible 보장', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, {
        type: 'RESULT',
        id: 's-1',
        payload: {},  // 모든 필드 비어있음 (서버 SSE drop 시뮬레이션)
        hasAnimation: false,
        lastTextIdx: -1,
      });
      expect(next).toHaveLength(1);
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      expect(hasVisible(m)).toBe(true);
      // fallback content 또는 error 둘 중 하나는 채워져야 함
      expect(m.content || m.error).toBeTruthy();
    });

    it('ERROR 액션 — error 메시지 필수, fallback 보장', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'ERROR', id: 's-1', error: '서버 연결 실패' });
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      expect(m.error).toBe('서버 연결 실패');
      expect(hasVisible(m)).toBe(true);
    });

    it('TIMEOUT — fallback 메시지 자동', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'TIMEOUT', id: 's-1' });
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      expect(hasVisible(m)).toBe(true);
      expect(m.content || m.error).toBeTruthy();
    });

    it('ABORTED — fallback 메시지 자동', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'ABORTED', id: 's-1' });
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      expect(hasVisible(m)).toBe(true);
    });

    it('NETWORK_ERROR — fallback 메시지 자동', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'NETWORK_ERROR', id: 's-1', message: 'fetch fail' });
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      expect(hasVisible(m)).toBe(true);
    });

    it('FINALIZE — 여전히 in-flight 면 강제 터미널 + 인바리언트', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'FINALIZE', id: 's-1' });
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      expect(hasVisible(m)).toBe(true);
    });
  });

  describe('정상 RESULT 는 fallback 없이 통과', () => {
    it('reply 채워진 RESULT — invariant 트리거 안 함', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, {
        type: 'RESULT',
        id: 's-1',
        payload: { reply: '정상 응답입니다.' },
        hasAnimation: false,
        lastTextIdx: -1,
      });
      const m = next[0];
      expect(m.content).toBe('정상 응답입니다.');
      // FALLBACK 메시지가 끼어들지 않아야 함
      expect(m.content).not.toBe(FALLBACK.EMPTY_REPLY);
      expect(m.content).not.toBe(FALLBACK.INVISIBLE);
    });

    it('blocks 채워진 RESULT — visible 인정', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, {
        type: 'RESULT',
        id: 's-1',
        payload: { data: { blocks: [{ type: 'component', name: 'Image', src: '/foo.png' }] } },
        hasAnimation: false,
        lastTextIdx: -1,
      });
      const m = next[0];
      expect(hasVisible(m)).toBe(true);
      // text 안 들어가도 component block 으로 visible — fallback 안 끼어듬
      expect(m.error).toBeUndefined();
    });

    it('text 블록만 있고 빈 문자열이면 visible 아님 → invariant 트리거', () => {
      // RESULT 애니메이션 초기 상태: blocks=[{type:'text', text:''}] 가 length=1 이지만 실질 빈 버블
      // hasAnimation=false 라 직접 RESULT 후 빈 text 만 있으면 invariant 발동해야 함
      const state = [systemPending('s-1')];
      const next = chatReducer(state, {
        type: 'RESULT',
        id: 's-1',
        payload: { data: { blocks: [{ type: 'text', text: '' }] } },
        hasAnimation: false,
        lastTextIdx: 0,
      });
      const m = next[0];
      expect(isTerminal(m)).toBe(true);
      // 빈 text 블록만 있는 상태 — invariant 발동으로 visible 보장
      expect(hasVisible(m)).toBe(true);
    });
  });

  describe('CHUNK 단계 — 비터미널 상태 (invariant 발동 X)', () => {
    it('CHUNK_TEXT — streaming 중, 인바리언트 안 발동 (visible 0 이어도 OK)', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'CHUNK_TEXT', id: 's-1', content: 'hi' });
      const m = next[0];
      expect(m.streaming).toBe(true);
      expect(m.content).toBe('hi');
    });

    it('CHUNK_THINKING — thinking 유지, content 안 채움', () => {
      const state = [systemPending('s-1')];
      const next = chatReducer(state, { type: 'CHUNK_THINKING', id: 's-1', content: '추론 중…' });
      const m = next[0];
      expect(m.isThinking).toBe(true);
      expect(m.thinkingText).toBe('추론 중…');
    });
  });

  describe('LOAD — 기존 메시지 그대로 (인바리언트는 적용)', () => {
    it('LOAD 시 터미널 + 빈 visible 메시지 있으면 fallback 채워짐', () => {
      const broken: Message = {
        id: 's-old',
        role: 'system',
        // isThinking false, executing false, streaming false, content 없음 → 인바리언트 트리거
      };
      const next = chatReducer([], { type: 'LOAD', messages: [broken] });
      expect(hasVisible(next[0])).toBe(true);
    });

    it('LOAD 시 정상 메시지는 그대로', () => {
      const ok = userMsg('u-1', 'hello');
      const next = chatReducer([], { type: 'LOAD', messages: [ok] });
      expect(next[0].content).toBe('hello');
    });
  });

  describe('user 메시지 invariant', () => {
    it('user 메시지 image 만 있어도 visible (content 없어도)', () => {
      const m: Message = { id: 'u-1', role: 'user', image: 'data:image/png;base64,...' };
      expect(hasVisible(m)).toBe(true);
    });
  });

  describe('FALLBACK 상수 안정성 (UI 가 같은 값 의존)', () => {
    it('FALLBACK / THINKING_STATUS 키 export 유지', () => {
      expect(FALLBACK.EMPTY_REPLY).toBeTruthy();
      expect(FALLBACK.INVISIBLE).toBeTruthy();
      expect(FALLBACK.TIMEOUT).toBeTruthy();
      expect(FALLBACK.NETWORK).toBeTruthy();
      expect(FALLBACK.ABORTED).toBeTruthy();
      expect(THINKING_STATUS.DONE).toBeTruthy();
      expect(THINKING_STATUS.DELAYED).toBeTruthy();
    });
  });
});
