/**
 * ChatManager — 프론트엔드 Chat 상태 매니저 (useReducer 기반)
 *
 * 배경: useChat 내부 7군데에서 setMessages(prev => prev.map(...)) 를 흩뿌려 호출하다가
 *   "터미널 상태인데 visible 콘텐츠 0" 조합이 만들어져 로봇 사라짐·빈 버블 버그 반복 발생.
 *
 * 해결: 모든 상태 전이를 단일 reducer 에 몰고, 반환 직전 인바리언트를 자동 강제.
 *   - `enforceInvariants`: 터미널 상태 (!isThinking && !executing && !streaming) 인데 visible 콘텐츠 0 이면
 *     자동 fallback 채워넣기. 구조적으로 "로봇 사라지고 빈 버블" 불가능.
 *   - 모든 SSE 이벤트·watchdog·abort·finally 가 ChatAction 으로 통일 → 전이 지점 단일화.
 *
 * 핵심 원칙:
 *   - reducer 는 순수 함수 — side effect 는 useChat 훅 안에 보존 (fetch, SSE loop, 타이머, DB sync).
 *   - Message 타입은 기존과 동일 (컴포넌트 쪽 변경 0) — isThinking/streaming/executing 3 플래그 유지.
 *   - 애니메이션 상태는 훅 ref 에 보관 — reducer 가 pos 받아 partial 반영.
 */

import type { Message, StepStatus, PendingAction } from '../types';

// ── Fallback 문구 — 한 곳에서만 관리 ────────────────────────────────────────
export const FALLBACK = {
  EMPTY_REPLY: '응답을 받지 못했습니다. 다시 시도해주세요.',
  INVISIBLE: '응답이 비어있습니다 (SSE 연결 누락 가능성)',
  TIMEOUT: '서버에서 2분 넘게 응답이 없습니다. SSE 연결 끊김 가능성 — 다시 시도해주세요.',
  NETWORK: '서버 네트워크 연결이 끊어졌습니다.',
  ABORTED: '중단되었습니다.',
} as const;

// ── 상태 라벨 (thinkingText 값) — ThinkingBlock 이 sentinel 비교로 분기. 단일 source ────
export const THINKING_STATUS = {
  DONE: '답변 완료',
  DELAYED: '응답 지연',
} as const;

// ── 판정 헬퍼 ──────────────────────────────────────────────────────────────
export function isTerminal(m: Message): boolean {
  return !m.isThinking && !m.executing && !m.streaming;
}

/** Suggestion 버튼 클릭 흔적 판정 — 실제 사용자 입력 아님.
 *  plan-confirm(✓ 실행) / plan-revise(⚙ 수정 제안) / 취소(✕ 취소) 등 SEND_SUGGESTION 경로로
 *  만들어진 user 메시지는 렌더 / shareContext walk-back / share title 등에서 제외.
 *  과거(2026-04-22 SEND_SUGGESTION 도입 전)에는 버튼 클릭도 SEND_USER 로 저장되어
 *  `✓ 실행` 등이 user 말풍선으로 남아있음 — 소급 필터로 정리. */
export function isSuggestionClickContent(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const c = content.trim();
  if (!c) return false;
  if (c === '✓ 실행' || c === '✓실행') return true;
  if (c === '✕ 취소' || c === '✕취소') return true;
  if (c.startsWith('⚙')) return true;
  return false;
}

export function isSuggestionClickUserMessage(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Record<string, unknown>;
  if (obj.role !== 'user') return false;
  return isSuggestionClickContent(obj.content);
}

/** 섹션 경계 블록 판정 — Header/Divider 는 긴 리포트에서 섹션 구분자로 쓰임.
 *  앞에 추가 여백(mt-5) 을 주면 가독성 크게 향상. admin 대화창 / share 페이지 공통 규칙. */
export function isSectionStartBlock(
  block: { type?: string; name?: string },
  index: number,
): boolean {
  if (index === 0) return false;
  if (block.type !== 'component') return false;
  return block.name === 'Header' || block.name === 'Divider';
}

/** AI 가 설명 텍스트에 HTML 태그 이름을 백틱 없이 써서 rehype-raw 가 실제 HTML 요소로
 *  파싱해버리는 문제 방어. 예: "`</header>`로 교정" 이라고 써야 하는데 "</header>로 교정"
 *  으로 쓰면 `</header>` 가 빈 HTML 요소로 렌더되어 앞 글자가 사라져 보임.
 *  블록 레벨 태그 (markdown 내부에서 쓰이지 않는) 만 선별 escape — strong/em/br/a/code 등
 *  인라인 태그는 정상 렌더되도록 그대로 둠. 이미 코드펜스(```) 안에 있으면 건드리지 않음. */
export function escapeHtmlTagMentions(text: string): string {
  if (!text) return text;
  const BLOCK_TAGS = [
    'header', 'footer', 'article', 'main', 'nav', 'section', 'aside',
    'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'form', 'input', 'select', 'option', 'textarea',
    'iframe', 'html', 'body', 'head', 'script', 'style', 'meta', 'link',
    'template', 'slot', 'canvas', 'svg',
  ];
  const tagAlt = BLOCK_TAGS.join('|');
  const tagPattern = new RegExp(`</?(?:${tagAlt})(?:\\s[^>]*)?\\/?>`, 'gi');
  // 코드펜스 블록은 건너뛰고 바깥 텍스트만 처리
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((p, i) => {
    if (i % 2 === 1) return p; // 코드펜스 원본 유지
    return p.replace(tagPattern, m => `\`${m}\``);
  }).join('');
}

export function hasVisible(m: Message): boolean {
  if (m.content && m.content.trim()) return true;
  if (m.error) return true;
  // blocks 는 "개수 > 0" 만으로 visible 판정하면 안 됨 — text 블록이 빈 문자열이면 렌더 시 아무것도 안 보임
  // (RESULT 애니메이션 초기 상태: blocks=[{type:'text', text:''}] 가 length=1 이지만 실질 빈 버블)
  // → 블록별로 "실제 렌더될 내용" 이 하나라도 있어야 visible
  const blocks = (m.data as { blocks?: unknown[] } | undefined)?.blocks;
  if (Array.isArray(blocks)) {
    const meaningful = blocks.some((b) => {
      if (!b || typeof b !== 'object') return false;
      const bo = b as Record<string, unknown>;
      if (bo.type === 'text') return typeof bo.text === 'string' && bo.text.trim().length > 0;
      if (bo.type === 'html') return typeof bo.htmlContent === 'string' && bo.htmlContent.length > 0;
      if (bo.type === 'component') return !!bo.name; // 컴포넌트 블록은 name 만 있으면 렌더 — UI 가 props 책임
      return false;
    });
    if (meaningful) return true;
  }
  if ((m.pendingActions?.length ?? 0) > 0) return true;
  if ((m.suggestions?.length ?? 0) > 0) return true;
  // user 메시지는 content 없어도 image 만으로 visible
  if (m.role === 'user' && m.image) return true;
  // system-init 같은 히어로 메시지는 ID 기반으로 예외 처리
  if (m.id === 'system-init') return true;
  return false;
}

// ── 액션 타입 ──────────────────────────────────────────────────────────────
export type ResultPayload = {
  reply?: string;
  thoughts?: string;
  executedActions?: string[];
  data?: any;
  error?: string;
  suggestions?: Message['suggestions'];
  pendingActions?: PendingAction[];
};

export type ChatAction =
  // 대화 로드·전환
  | { type: 'LOAD'; messages: Message[] }
  // 전송: user + pending system 동시 push
  | { type: 'SEND_USER'; userId: string; systemId: string; content: string; image?: string }
  // suggestion 전송 — user 없이 pending system 만 push
  | { type: 'SEND_SUGGESTION'; systemId: string }
  // SSE 이벤트 (Function Calling 모드. 레거시 'plan' 이벤트는 v0.1, 2026-04-22 삭제됨)
  | { type: 'CHUNK_TEXT'; id: string; content: string }
  | { type: 'CHUNK_THINKING'; id: string; content: string }
  | { type: 'STEP'; id: string; step: StepStatus; isLast: boolean }
  | { type: 'RESULT'; id: string; payload: ResultPayload; hasAnimation: boolean; lastTextIdx: number }
  | { type: 'RESULT_ANIM_TICK'; id: string; partial: string; lastTextIdx: number }
  | { type: 'ERROR'; id: string; error: string }
  // 종료 지점 — 공통 정리
  | { type: 'ABORTED'; id: string }
  | { type: 'TIMEOUT'; id: string }
  | { type: 'NETWORK_ERROR'; id: string; message: string }
  | { type: 'FINALIZE'; id: string } // finally 블록: 여전히 in-flight 면 강제 터미널 + 인바리언트
  // Pending action (schedule_task 등)
  | { type: 'PENDING_APPROVED'; msgId: string; planId: string }
  | { type: 'PENDING_REJECTED'; msgId: string; planId: string }
  | { type: 'PENDING_PAST_RUNAT'; msgId: string; planId: string; originalRunAt?: string }
  | { type: 'PENDING_ERROR'; msgId: string; planId: string; errorMessage: string };

// ── 인바리언트 강제 ─────────────────────────────────────────────────────────
// 터미널 상태인데 visible 콘텐츠 0 이면 자동 fallback 채워넣기.
// reducer 반환 직전 모든 메시지에 적용 → 로봇 사라짐 구조적 차단.
function enforceInvariant(m: Message): Message {
  if (!isTerminal(m)) return m;
  if (hasVisible(m)) return m;
  return {
    ...m,
    content: m.content || m.error || FALLBACK.EMPTY_REPLY,
    error: m.error || FALLBACK.INVISIBLE,
    thinkingText: m.thinkingText || THINKING_STATUS.DONE,
  };
}

// ── reducer ────────────────────────────────────────────────────────────────
export function chatReducer(state: Message[], action: ChatAction): Message[] {
  const next = applyAction(state, action);
  // 모든 전이 후 인바리언트 자동 강제 — 변경된 메시지만 검사하면 되지만
  // 비용이 미미해서 전체 스윕. 터미널 아닌 메시지엔 no-op.
  return next.map(enforceInvariant);
}

function applyAction(state: Message[], action: ChatAction): Message[] {
  switch (action.type) {
    case 'LOAD':
      return action.messages;

    case 'SEND_USER':
      return [
        ...state,
        { id: action.userId, role: 'user', content: action.content, image: action.image },
        { id: action.systemId, role: 'system', isThinking: true },
      ];

    case 'SEND_SUGGESTION':
      return [...state, { id: action.systemId, role: 'system', isThinking: true }];

    case 'CHUNK_TEXT':
      return state.map(m => m.id === action.id
        ? { ...m, isThinking: false, streaming: true, statusText: undefined, content: (m.content || '') + action.content }
        : m);

    case 'CHUNK_THINKING':
      return state.map(m => m.id === action.id
        ? { ...m, isThinking: true, streaming: false, statusText: undefined, thinkingText: (m.thinkingText || '') + action.content }
        : m);

    case 'STEP':
      return state.map(m => m.id === action.id
        ? {
            ...m,
            executing: true,
            isThinking: true,
            streaming: false,
            statusText: action.isLast ? '결과 정리 중...' : (action.step.description || m.statusText),
            steps: [...(m.steps || []), action.step],
          }
        : m);

    case 'RESULT': {
      const p = action.payload;
      const hasBlocks = Array.isArray(p.data?.blocks) && p.data.blocks.length > 0;
      // 애니메이션용 — 마지막 text 블록은 빈 문자열로 초기화
      let newData = p.data;
      if (action.hasAnimation && hasBlocks && action.lastTextIdx >= 0) {
        newData = {
          ...p.data,
          blocks: p.data.blocks.map((b: any, i: number) =>
            i === action.lastTextIdx ? { ...b, text: '' } : b,
          ),
        };
      }
      return state.map(m => m.id === action.id
        ? {
            ...m,
            isThinking: false,
            executing: false,
            streaming: false,
            statusText: undefined,
            thinkingText: THINKING_STATUS.DONE,
            thoughts: p.thoughts,
            // blocks 애니메이션 대상이면 m.content 건들지 않고 blocks 내부 text 만 애니메이션
            content: action.hasAnimation && action.lastTextIdx >= 0 && hasBlocks
              ? m.content
              : (action.hasAnimation ? '' : (p.reply ?? m.content)),
            executedActions: p.executedActions || [],
            data: newData,
            error: p.error,
            suggestions: p.suggestions && p.suggestions.length > 0 ? p.suggestions : undefined,
            pendingActions: p.pendingActions?.map(pa => ({ ...pa, status: pa.status ?? 'pending' })),
          }
        : m);
    }

    case 'RESULT_ANIM_TICK':
      return state.map(m => {
        if (m.id !== action.id) return m;
        if (action.lastTextIdx >= 0 && m.data && Array.isArray((m.data as any).blocks)) {
          const blocks = ((m.data as any).blocks as any[]).slice();
          blocks[action.lastTextIdx] = { ...blocks[action.lastTextIdx], text: action.partial };
          return { ...m, data: { ...(m.data as any), blocks } };
        }
        return { ...m, content: action.partial };
      });

    case 'ERROR':
      return state.map(m => m.id === action.id
        ? {
            ...m,
            isThinking: false,
            executing: false,
            streaming: false,
            thinkingText: THINKING_STATUS.DONE,
            error: action.error,
            content: m.content || '',
          }
        : m);

    case 'ABORTED':
      return state.map(m => m.id === action.id
        ? {
            ...m,
            isThinking: false,
            executing: false,
            streaming: false,
            thinkingText: THINKING_STATUS.DONE,
            content: m.content || FALLBACK.ABORTED,
          }
        : m);

    case 'TIMEOUT':
      return state.map(m => {
        if (m.id !== action.id) return m;
        if (isTerminal(m)) return m; // 이미 완료 — 건드리지 않음
        return {
          ...m,
          isThinking: false,
          executing: false,
          streaming: false,
          thinkingText: THINKING_STATUS.DELAYED,
          error: m.error || FALLBACK.TIMEOUT,
        };
      });

    case 'NETWORK_ERROR':
      return state.map(m => m.id === action.id
        ? {
            ...m,
            isThinking: false,
            executing: false,
            streaming: false,
            thinkingText: THINKING_STATUS.DONE,
            error: action.message,
            content: m.content || FALLBACK.NETWORK,
          }
        : m);

    case 'FINALIZE':
      // 스트림 종료 후 안전망 — 여전히 in-flight 이거나 invisible 이면 인바리언트가 자동 복구
      return state.map(m => {
        if (m.id !== action.id) return m;
        if (isTerminal(m)) return m; // 이미 완료 — 인바리언트만 통과시킴
        return {
          ...m,
          isThinking: false,
          executing: false,
          streaming: false,
          thinkingText: m.thinkingText || THINKING_STATUS.DONE,
        };
      });

    case 'PENDING_APPROVED':
      return state.map(m => m.id !== action.msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p =>
          p.planId === action.planId ? { ...p, status: 'approved' as const, errorMessage: undefined } : p,
        ),
      });

    case 'PENDING_REJECTED':
      return state.map(m => m.id !== action.msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p =>
          p.planId === action.planId ? { ...p, status: 'rejected' as const } : p,
        ),
      });

    case 'PENDING_PAST_RUNAT':
      return state.map(m => m.id !== action.msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p =>
          p.planId === action.planId ? { ...p, status: 'past-runat' as const, originalRunAt: action.originalRunAt } : p,
        ),
      });

    case 'PENDING_ERROR':
      return state.map(m => m.id !== action.msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p =>
          p.planId === action.planId ? { ...p, status: 'error' as const, errorMessage: action.errorMessage } : p,
        ),
      });

    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

// ── 저장용 메시지 정리 ─────────────────────────────────────────────────────
// 진행 중 상태 (isThinking/executing/streaming) 제거 — 다른 기기에서 "중단되었습니다"
// 로 박제되는 문제 차단.
export function cleanMessages(msgs: Message[]): Message[] {
  return msgs.filter(m => !m.isThinking && !m.executing && !m.streaming);
}
