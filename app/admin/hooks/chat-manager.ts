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
import koMessages from '../../../language/ko.json';
import enMessages from '../../../language/en.json';
import { inlineFormatTagsToMarkdown } from '../../../lib/util/md';

// ── Fallback i18n keys — language/*.json 단일 source (2026-05-13) ───────────
// 사용자가 useTranslations 으로 변환 (useChat hook 안). reducer pure 영역에서는
// 한국어 폴백 FALLBACK 객체 사용 (옛 동작 유지) — isFallbackContent 가 ko + en 양쪽 매칭.
export const FALLBACK_I18N_KEYS = {
  EMPTY_REPLY: 'admin_chat.fallback_empty_reply',
  INVISIBLE: 'admin_chat.fallback_invisible',
  TIMEOUT: 'admin_chat.fallback_timeout',
  NETWORK: 'admin_chat.fallback_network',
  ABORTED: 'admin_chat.fallback_aborted',
} as const;

// reducer / pure module 영역의 폴백 — t() 호출 불가. ko 기본값 사용. isFallbackContent 가 lang 무관 매칭.
export const FALLBACK = {
  EMPTY_REPLY: (koMessages as any).admin_chat.fallback_empty_reply,
  INVISIBLE: (koMessages as any).admin_chat.fallback_invisible,
  TIMEOUT: (koMessages as any).admin_chat.fallback_timeout,
  NETWORK: (koMessages as any).admin_chat.fallback_network,
  ABORTED: (koMessages as any).admin_chat.fallback_aborted,
} as const;

// 비교용 — 모든 lang 의 fallback 값 합집합. 사용자가 lang 변경해도 옛 cache 메시지 식별 가능.
const FALLBACK_VALUE_SET = (() => {
  const set = new Set<string>();
  const langFiles: any[] = [koMessages, enMessages];
  const keys = ['fallback_empty_reply', 'fallback_invisible', 'fallback_timeout', 'fallback_network', 'fallback_aborted'];
  for (const file of langFiles) {
    const chat = file?.admin_chat;
    if (!chat) continue;
    for (const k of keys) {
      if (typeof chat[k] === 'string') set.add(chat[k]);
    }
  }
  return set;
})();

/** lang 무관 fallback 메시지 식별 — opt cache (옛 lang 메시지) 도 정확히 매칭. */
export function isFallbackContent(content: unknown): boolean {
  return typeof content === 'string' && FALLBACK_VALUE_SET.has(content);
}

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
  // suggestionClick 플래그 = SEND_SUGGESTION 경로 픽(칩 텍스트)을 백엔드가 저장한 표시. 마커(✓/✕/⚙) 없는
  // 일반 옵션 텍스트도 이 플래그로 렌더 제외 — 리로드 시 픽이 user 말풍선으로 노출되던 것 차단.
  if (obj.suggestionClick === true) return true;
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
 *  블록 + 인라인 포맷 태그를 모두 escape — AI 가 답변에서 마크다운/HTML 을 설명하며 literal
 *  태그(`<strong>` 등)를 쓰면 rehypeRaw 가 실제 태그로 실행한다. 특히 짝 안 맞는 인라인 포맷
 *  태그는 닫힘 전까지 뒤 텍스트를 통째로 굵게/이탤릭 번지게 한다 (닫는 `</strong>` 이 코드펜스로
 *  갈려 안 닫히는 케이스). 굵게는 `**bold**`(→ renderMarkdown 이 <strong> 주입)로 충분하므로
 *  raw 인라인 HTML 은 literal 텍스트로 보여주는 게 안전. 이미 코드펜스(```) 안이면 건드리지 않음.
 *  (옛엔 인라인 태그를 "정상 렌더되도록" 일부러 뒀으나, 그게 bold 번짐의 root 라 escape 로 전환.) */
export function escapeHtmlTagMentions(text: string): string {
  if (!text) return text;
  // 짝 맞는 인라인 포맷 태그(<strong>x</strong> 등)는 먼저 마크다운으로 변환 → 굵게 의도 보존.
  // (변환 안 하면 아래 백틱 escape 가 `<strong>` 를 인라인코드(회색 박스)로 죽여 안 굵게가 된다.)
  text = inlineFormatTagsToMarkdown(text);
  const HTML_TAGS = [
    'header', 'footer', 'article', 'main', 'nav', 'section', 'aside',
    'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'form', 'input', 'select', 'option', 'textarea',
    'iframe', 'html', 'body', 'head', 'script', 'style', 'meta', 'link',
    'template', 'slot', 'canvas', 'svg',
    // 인라인/포맷 태그 — bold/italic 번짐의 root (특히 strong/em/b/i). 짝 안 맞으면 뒤 텍스트 오염.
    // ⚠️ 'br' 은 제외 — void element 라 짝-불일치 번짐이 원천 불가한데, 마크다운 표 셀 안 줄바꿈의
    // 표준 관행(`셀 내용<br>다음 줄`)이라 escape 하면 회색 칩으로 죽는다(2026-07-06 실측).
    // rehypeRaw 가 실제 <br> 로 렌더 = 의도된 줄바꿈.
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark',
    'small', 'sub', 'sup', 'code', 'pre', 'kbd', 'samp', 'var',
    'a', 'span', 'abbr', 'cite', 'q', 'blockquote', 'p', 'hr', 'img',
  ];
  const tagAlt = HTML_TAGS.join('|');
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
  toolResults?: Message['toolResults'];
  libraryHits?: Message['libraryHits'];
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
  | { type: 'BUILD_STEP'; id: string; step: string }
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
  | { type: 'PENDING_APPROVED'; msgId: string; planId: string; newRunAt?: string }
  | { type: 'PENDING_REJECTED'; msgId: string; planId: string }
  | { type: 'PENDING_PAST_RUNAT'; msgId: string; planId: string; originalRunAt?: string }
  | { type: 'PENDING_ERROR'; msgId: string; planId: string; errorMessage: string }
  // suggestion 클릭 시 해당 메시지의 suggestions 클리어 — 새로고침 후 재등장 방지
  | { type: 'CONSUME_SUGGESTIONS'; msgId: string }
  | { type: 'LOCK_SUGGESTION'; msgId: string; picked: string };

// ── 인바리언트 강제 ─────────────────────────────────────────────────────────
// 터미널 상태인데 visible 콘텐츠 0 이면 자동 fallback 채워넣기.
// reducer 반환 직전 모든 메시지에 적용 → 로봇 사라짐 구조적 차단.
function enforceInvariant(m: Message): Message {
  if (!isTerminal(m)) return m;
  // 터미널 system 답변(인사말 system-init 제외)은 항상 thinkingText 보유 → ThinkingBlock 의
  // `!complete && !thinkingText` null-return 을 피해 '답변완료' 라벨 유지. backend 가 thinkingText
  // 를 저장 안 해서(chat/stream save·hub schema 에 필드 없음) SSE 끊김 후 폴링 복구 / reload /
  // 대화 전환으로 DB 메시지를 LOAD 하면 라벨이 사라지던 것 — visible 콘텐츠 유무와 무관하게 채운다.
  // (LOAD 도 chatReducer → enforceInvariant 를 통과하므로 여기 한 곳에서 전 경로 일괄 해소.)
  const m2: Message = (m.role === 'system' && m.id !== 'system-init' && !m.thinkingText)
    ? { ...m, thinkingText: THINKING_STATUS.DONE }
    : m;
  if (hasVisible(m2)) return m2;
  return {
    ...m2,
    content: m2.content || m2.error || FALLBACK.EMPTY_REPLY,
    error: m2.error || FALLBACK.INVISIBLE,
    thinkingText: m2.thinkingText || THINKING_STATUS.DONE,
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

    case 'CHUNK_THINKING': {
      // "[도구 호출: name]" / "[계획 정리]" 마커는 본문에 줄줄이 쌓지 않고 단일 상태줄(statusText)만
      // 갱신 — 스피너 옆 한 줄이 '생각중 ↔ 도구 호출 중'으로 바뀌게. 실제 추론 텍스트만 본문 누적.
      const c = action.content;
      if (c.includes('[도구 호출:') || c.includes('[계획 정리]')) {
        // 단일 상태줄에 도구명까지 노출 — 한 줄만 갱신하므로 줄줄이 쌓이지 않는다. 마커 형식 "[도구 호출: name]".
        const toolName = c.match(/\[도구 호출:\s*([^\]]+)\]/)?.[1]?.trim();
        const status = c.includes('[계획 정리]')
          ? '계획 정리 중...'
          : (toolName ? `도구 호출 중: ${toolName}` : '도구 호출 중...');
        return state.map(m => m.id === action.id
          ? { ...m, isThinking: true, streaming: false, statusText: status }
          : m);
      }
      return state.map(m => m.id === action.id
        ? { ...m, isThinking: true, streaming: false, statusText: undefined, thinkingText: (m.thinkingText || '') + c }
        : m);
    }

    case 'BUILD_STEP':
      // Project Builder — advance_build 가 턴 도중 step 을 올릴 때 그 라이브 step 을 스트리밍 메시지에 기록.
      // buildSession 은 최종 AiResponse 에만 실려서, 없으면 빌드 카드 stepper/로더가 생성 내내(one-shot 13분)
      // 직전 step 에 frozen. statusText/thinkingText 와 별개 필드 = 카드 그룹핑(buildCardByMsg) 불간섭.
      return state.map(m => m.id === action.id ? { ...m, liveBuildStep: action.step } : m);

    case 'STEP': {
      // 도구 step 진행은 단일 상태줄로 — 마지막 step = '답변 준비 중', 그 외 = '도구 호출 중: <도구명>'.
      // 단일 줄만 갱신하므로 도구명을 노출해도 줄줄이 쌓이지 않는다(옛 제거 사유는 다중 줄 누적이었음).
      const stepName = (action.step.description || action.step.type || '').trim();
      const status = action.isLast
        ? '답변 준비 중...'
        : (stepName ? `도구 호출 중: ${stepName}` : '도구 호출 중...');
      return state.map(m => m.id === action.id
        ? {
            ...m,
            executing: true,
            isThinking: true,
            streaming: false,
            statusText: status,
            steps: [...(m.steps || []), action.step],
          }
        : m);
    }

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
            toolResults: p.toolResults && p.toolResults.length > 0 ? p.toolResults : undefined,
            libraryHits: p.libraryHits && p.libraryHits.length > 0 ? p.libraryHits : undefined,
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
          p.planId === action.planId
            ? {
                ...p,
                status: 'approved' as const,
                errorMessage: undefined,
                // 시간 변경 재예약 승인 — 카드의 실행 시각 표시(args.runAt)도 새 시간으로 (옛엔 원래 시간 고정)
                ...(action.newRunAt ? { args: { ...(p.args ?? {}), runAt: action.newRunAt } } : {}),
              }
            : p,
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

    case 'CONSUME_SUGGESTIONS':
      return state.map(m => m.id !== action.msgId ? m : { ...m, suggestions: undefined });

    case 'LOCK_SUGGESTION':
      // 칩 픽 — suggestions 유지(잠금 렌더용) + 픽 텍스트 기록. consumeSuggestions(제거)와 달리 칩이 남아 잠긴 상태로 보임.
      return state.map(m => m.id !== action.msgId ? m : { ...m, pickedSuggestion: action.picked });

    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

// ── 저장용 메시지 정리 ─────────────────────────────────────────────────────
// 진행 중 상태 (isThinking/executing/streaming) 제거 — 다른 기기에서 "중단되었습니다"
// 로 박제되는 문제 차단.
/** 영속(DB·localStorage) 시 pendingActions[].args 의 중첩 객체/배열 제거 — save_page 의 spec.body 등
 *  페이지 본문이 채팅 프리뷰(data.blocks)와 승인 args(spec)에 **이중 저장**되어 대화 본문이 비대해지면
 *  저장 요청 자체가 실패(Failed to fetch, body 거대)한다. 전체 args 는 백엔드 plan_store 가 planId 로
 *  보관하고 승인은 planId 로 처리하며, 카드 표시는 slug/path/title/jobId 등 scalar 만 읽으므로 scalar 만
 *  남기고 중첩은 drop (일반 규칙 — 도구별 하드코딩 X). 거대 페이지 발행 대화도 저장 성공 → cross-device 동기. */
function leanPendingArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object') return args;
  const lean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || typeof v !== 'object') { lean[k] = v; continue; }
    // 작은 중첩은 보존 (크기 기준 — 도구별 하드코딩 X): 스케줄 카드의 pipeline(주문 스텝 상세 표시)
    // 같은 소형 구조는 리로드 후에도 카드에 살아야 함. 비대 방지 대상 = save_page spec.body 급 거대 중첩.
    try {
      const s = JSON.stringify(v);
      if (s.length <= 2000) lean[k] = v;
    } catch { /* 직렬화 불가(순환 등) 중첩 값 = drop — 카드 표시는 scalar 로 충분 */ }
  }
  return lean;
}

export function cleanMessages(msgs: Message[]): Message[] {
  return msgs.filter(m =>
    !m.isThinking && !m.executing && !m.streaming
    // system-init 히어로(👻 환영)는 client-only — 영속·비교에서 제외. 화면엔 preserveHero(로드 시 재부착)로
    // 표시되므로 persist 할 이유 0. 옛엔 cleanMessages 가 이걸 안 걸러 DB 에 저장됨(187/189 대화) →
    // preserveHero 가 로드마다 다시 붙이고 그 직렬화 형태가 save↔load 마다 미묘히 달라(executedActions:[] 등)
    // save_conversation 의 messages 비교(4cb0593)가 어긋남 → 무변경 F5 에도 updated_at bump = 목록 점프 root.
    && m.id !== 'system-init'
    // fallback/에러 메시지("응답이 비어있습니다" 등)는 DB 저장·복원에서 제외. 옛 = 클라이언트가
    // fallback 을 systemId 로 저장 → 서버가 같은 id 로 저장하는 진짜 답과 race → fallback 이 나중에
    // 쓰이면 진짜 답을 덮어써서 "F5 해도 계속 SSE 에러" 영구화. 이제 fallback 은 세션 내 표시만 하고
    // 영속 0 → 서버 완료 후 refresh/F5 시 진짜 답이 단독 source 라 안정 복구.
    && !(m.role === 'system' && isFallbackContent(m.content)),
  ).map(m =>
    m.pendingActions?.some(p => p.args && typeof p.args === 'object')
      ? { ...m, pendingActions: m.pendingActions.map(p => p.args ? { ...p, args: leanPendingArgs(p.args) } : p) }
      : m,
  );
}
