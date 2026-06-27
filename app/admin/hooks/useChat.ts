/**
 * useChat — Chat UI 훅 (ChatManager reducer + SettingsManager 활용)
 *
 * 상태 전이 모두 `chatReducer` 에 위임 (chat-manager.ts). 이 훅은 side effect 만 담당:
 *   - DB / localStorage 동기화
 *   - SSE /api/chat/stream 수신 → ChatAction 디스패치
 *   - AbortController / watchdog / chunk 애니메이션 ref
 *   - 스크롤 / visibilitychange / focus / pagehide
 *
 * 로봇 사라짐 버그는 reducer 의 `enforceInvariant` 가 구조적으로 차단.
 */

'use client';

import { useReducer, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Message, Conversation, INIT_MESSAGE, makeConv, PendingAction } from '../types';
import { ConversationMeta } from '../components/Sidebar';
import { chatReducer, cleanMessages, FALLBACK_I18N_KEYS, isFallbackContent } from './chat-manager';
import { useTranslations } from '../../../lib/i18n';
import { useSetting } from './settings-manager';
import { useWakeLock } from './use-wake-lock';
import { CHAT_WATCHDOG_IDLE_MS, KEEPALIVE_BODY_LIMIT_BYTES } from '../../../lib/config';
import { safeJsonParse, logger } from '../../../lib/util';
import { apiGet, apiPost, apiDelete } from '../../../lib/api-fetch';

// SSE 이벤트 파서 — buffer에서 완성된 이벤트만 파싱, 나머지는 반환
function parseSSE(buffer: string): { events: { event: string; data: any }[]; remaining: string } {
  const events: { event: string; data: any }[] = [];
  const parts = buffer.split('\n\n');
  const remaining = parts.pop() || '';
  for (const block of parts) {
    if (!block.trim()) continue;
    const eventMatch = block.match(/^event:\s*(.+)$/m);
    const dataMatch = block.match(/^data:\s*(.+)$/m);
    if (eventMatch && dataMatch) {
      try { events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) }); } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
    }
  }
  return { events, remaining };
}

/** Hub page mode 컨텍스트 — anonymous 방문자가 hub instance 호출 시 전달.
 *  지정되면 useChat 가 /api/hub/<slug>/chat SSE 로 분기 + sessionId / apiToken 사용.
 *  단일 conv (sessionId sticky) — admin 의 multi-conv localStorage 패턴 우회. */
export interface UseChatHubContext {
  slug: string;
  apiToken: string;
  /** localStorage 안 sticky 세션 UUID — handleNewConv 시 갱신. */
  sessionId: string;
  onResetSession: () => void;
}

/** 대화 목록 메타 — admin/hub 공통 shape (convBackend 가 정규화). */
type ConvBackendMeta = { id: string; title: string; createdAt: number; updatedAt: number };

/** hub_messages(wire) → frontend Message. init·select 공용 (옛 중복 제거).
 *  reload 복원 시 라이브 RESULT 와 같은 shape — 뱃지(executedActions/toolResults/suggestions/libraryHits)는
 *  top-level 이어야 렌더가 읽는다 (옛 버그: data 에만 넣어 reload 후 액션 뱃지 사라짐). blocks 는 data 에서 렌더. */
function mapHubMessages(
  hubMsgs: Array<{ id: string; role: string; content?: string; dataJson?: string }>,
): Message[] {
  return hubMsgs.map(m => {
    const role = m.role === 'system' ? ('system' as const) : ('user' as const);
    if (!m.dataJson) {
      return { id: m.id, role, content: m.content ?? '' } as Message;
    }
    const d = safeJsonParse<Record<string, unknown>>(m.dataJson, {});
    return {
      id: m.id,
      role,
      content: m.content ?? '',
      executedActions: d.executedActions,
      toolResults: d.toolResults,
      libraryHits: d.libraryHits,
      suggestions: d.suggestions,
      // plan 승인 카드 등 — reload 시 복원. plan 본체는 plan_store(in-memory)라 같은 세션 내 실행 정상,
      // 재시작 후엔 plan 만료로 재클릭이 graceful reject (이중 실행 없음).
      pendingActions: d.pendingActions,
      data: d,
    } as Message;
  });
}

/** reload/refresh/select 가 DB(remote) 메시지로 로컬을 교체할 때, 로컬에서 이미 승인/거부/오류로
 *  확정된 pendingAction status 를 DB 의 pending 으로 되돌리지 않는다. #5 — 승인 직후 폴링·재조회·
 *  재시작 LOAD 가 in-flight 저장 전 DB(pending)를 불러와 승인 카드가 다시 뜨던 것. 로컬 확정 status
 *  우선 + 다음 저장에서 DB 도 치유. (hub 는 saveToDb skip 이라 localStorage 가 유일 소스 — init 병합으로 복원) */
const TERMINAL_PENDING = new Set(['approved', 'rejected', 'error', 'past-runat']);
function preserveLocalPendingStatus(remote: Message[], local: Message[]): Message[] {
  if (!local.length) return remote;
  const localById = new Map(local.map(m => [m.id, m]));
  return remote.map(rm => {
    if (!rm.pendingActions?.length) return rm;
    const lm = localById.get(rm.id);
    if (!lm?.pendingActions?.length) return rm;
    const localByPlan = new Map(lm.pendingActions.map(p => [p.planId, p]));
    return {
      ...rm,
      pendingActions: rm.pendingActions.map(rp => {
        const lp = localByPlan.get(rp.planId);
        // createdAt(로컬 stamp)은 비종결 카드에도 보존 — 리로드 후에도 만료 계산 유지.
        return lp && TERMINAL_PENDING.has(String(lp.status)) ? { ...rp, ...lp } : { ...rp, createdAt: lp?.createdAt ?? rp.createdAt };
      }),
    };
  });
}

/** system-init 히어로(👻 환영)는 client-only(백엔드 미영속). 백엔드 메시지로 LOAD/머지할 때 떨어뜨리지
 *  않게 로컬에 있으면 맨 앞에 보존 — 새 대화에서 채팅 시작 후 reconcile/refresh 가 돌아도 히어로가
 *  첫 메시지로 남아 위로 밀려나게(중간에 사라지던 것 차단). 로컬에 없으면(옛 대화 로드) 추가 안 함. */
function preserveHero(merged: Message[], local: Message[]): Message[] {
  const hero = local.find(m => m.id === 'system-init');
  if (hero && !merged.some(m => m.id === 'system-init')) return [hero, ...merged];
  return merged;
}

export function useChat(aiModel: string, onRefresh: () => void, hubContext?: UseChatHubContext) {
  const t = useTranslations();
  const [messages, dispatch] = useReducer(chatReducer, [INIT_MESSAGE]);
  // 최신 messages ref — queueMicrotask / async 콜백에서 stale closure 회피
  const messagesRef = useRef<Message[]>([INIT_MESSAGE]);
  messagesRef.current = messages;
  // 대화 load(열어보기)로 채워진 변경은 updatedAt 갱신 안 함 — 단순 열람이 목록 최상단으로 올라가던 #2.
  // handleSelectConv 가 여는 대화 id 설정, 새 메시지 전송(handleSubmit) 이 해제. (값=대화 id, save effect 가 비교)
  const suppressBumpRef = useRef<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // 모바일 화면 자동 잠금 방지 — AI 응답 중 SSE 끊김 / "로봇 사라짐" 방지.
  // loading=true 동안만 유지. 응답 후 사용자가 답변 읽는 동안 = 터치/스크롤 발생해
  // OS 자동 잠금이 일어나지 않음. 일정 시간 후 잠금 = OS default 정공.
  useWakeLock(loading);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvIdState] = useState('');
  // localStorage key — hub page mode 이면 hub-{slug} suffix 붙여 admin 영역과 분리.
  // 단일 단말 안에서 admin 본인 + hub 방문자 chat 가 섞이지 않게 함. 분리하지 않으면
  // hub 방문자 chat 가 admin 사이드바에 나오거나 admin chat 이 hub UI 에 나오는 incident 발생.
  const convStorageKey = hubContext ? `firebat_conversations__hub-${hubContext.slug}` : 'firebat_conversations';
  const activeConvStorageKey = hubContext ? `firebat_active_conv__hub-${hubContext.slug}` : 'firebat_active_conv';

  // 대화 데이터소스 — admin(/api/conversations) vs hub(/api/hub/<slug>/sessions)를 한 번만 결정.
  // init·select·create·delete 가 이걸 통해 호출 → 대화 로직이 admin·hub 한 코드 (if(hubContext) 떡칠 제거).
  // chat send / 저장 / refresh 는 별개 (저장은 admin 만, hub 는 backend auto-save). storage-key 분리 유지.
  const convBackend = useMemo(() => {
    if (hubContext) {
      const hf = (op: string, extra?: Record<string, unknown>) =>
        fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': hubContext.apiToken,
            'X-Session-Id': hubContext.sessionId,
          },
          body: JSON.stringify({ op, ...(extra ?? {}) }),
        }).then(r => r.json()).catch(() => null);
      return {
        async listConversations(): Promise<ConvBackendMeta[] | null> {
          const r = await hf('list-conversations');
          if (!r?.success) return null;
          return (r.conversations ?? []).map((c: { id: string; title?: string; createdAt: number; updatedAt?: number }) => ({
            id: c.id, title: c.title || '새 대화', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt,
          }));
        },
        async listMessages(id: string): Promise<Message[]> {
          const r = await hf('list-messages', { id });
          return r?.success ? mapHubMessages(r.messages ?? []) : [];
        },
        async createConversation(): Promise<Conversation | null> {
          const r = await hf('create-conversation');
          if (!r?.success || !r.conversationId) return null;
          const now = Date.now();
          return { id: r.conversationId, title: '새 대화', createdAt: now, updatedAt: now, messages: [INIT_MESSAGE] };
        },
        async deleteConversation(id: string): Promise<void> {
          await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/sessions`, {
            method: 'POST', keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Token': hubContext.apiToken,
              'X-Session-Id': hubContext.sessionId,
            },
            body: JSON.stringify({ op: 'delete-conversation', id }),
          }).catch(() => {});
        },
      };
    }
    return {
      async listConversations(): Promise<ConvBackendMeta[] | null> {
        const r = await apiGet<{ success?: boolean; conversations?: ConvBackendMeta[] }>('/api/conversations', { category: 'useChat' }).catch(() => null);
        return r?.success ? (r.conversations ?? []) : null;
      },
      async listMessages(id: string): Promise<Message[]> {
        const r = await apiGet<{ success?: boolean; conversation?: { messages?: Message[] } }>(`/api/conversations?id=${encodeURIComponent(id)}`, { category: 'useChat' }).catch(() => null);
        return r?.success && r.conversation ? (r.conversation.messages ?? []) : [];
      },
      async createConversation(): Promise<Conversation | null> {
        return makeConv();
      },
      async deleteConversation(id: string): Promise<void> {
        await apiDelete(`/api/conversations?id=${encodeURIComponent(id)}`, { category: 'useChat' }).catch(() => {});
      },
    };
  }, [hubContext]);
  const [planModeAdmin, setPlanModeRaw] = useSetting('firebat_plan_mode');
  // hub mode 안 visitor 도 plan mode 사용 가능해야 — settings prefix (`hub-<slug>` localStorage)
  // 가 admin 영역과 별도라 admin 설정 영향 0.
  const [inputMode, setInputMode] = useSetting('firebat_input_mode');
  // hub visitor 도 plan mode 사용 가능 — settings prefix (`hub-<slug>`) 별도라
  // admin 의 plan_mode 영향 0. setPlanMode 그대로 노출.
  const planMode = planModeAdmin;
  const setPlanMode = setPlanModeRaw;

  // activeConvId 는 훅 밖 useSetting 초기화 타이밍 race 가 있어 useState + 수동 동기화 유지
  const setActiveConvId = useCallback((id: string) => {
    setActiveConvIdState(id);
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem(activeConvStorageKey, id);
      else localStorage.removeItem(activeConvStorageKey);
    }
  }, []);

  const chatEndRef = useRef<HTMLDivElement>(null);
  // chunk-flow 애니메이션
  const chunkAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelChunkAnim = () => {
    if (chunkAnimRef.current) { clearInterval(chunkAnimRef.current); chunkAnimRef.current = null; }
  };
  // 요청 중단용 AbortController
  const abortRef = useRef<AbortController | null>(null);
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
  // Watchdog — N분 넘게 무응답이면 강제 터미널 + 에러 뱃지
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogOnFireRef = useRef<(() => void) | null>(null);
  const cancelWatchdog = () => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    watchdogOnFireRef.current = null;
  };
  // idle timeout — SSE 이벤트가 이 시간 동안 안 오면 죽은 연결로 간주.
  // CHAT_WATCHDOG_IDLE_MS = 2분 (lib/config.ts). 이미지 생성은 20~30초/장, 3장이면 ~90초.
  // 총 응답 시간 제한이 아니라 "조용한 시간" 제한이므로 이벤트만 꾸준히 오면 계속 연장됨.
  const resetWatchdog = () => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const onFire = watchdogOnFireRef.current;
    if (!onFire) return;
    watchdogRef.current = setTimeout(onFire, CHAT_WATCHDOG_IDLE_MS);
  };

  // ── 초기화: DB 우선 로드 (다기기 동기화 보장). 실패 시에만 localStorage 폴백 ──
  // Hub mode 이면 admin /api/conversations 호출 skip + /api/hub/<slug>/sessions 호출.
  // hub_conversations DB 에서 다기기 동기화 + 본격 multi-conv 동작.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 서버(admin: /api/conversations · hub: sessions) 우선 → 실패 시 localStorage 폴백.
      // convBackend 단일 경로 — admin·hub 분기 없음 (데이터소스만 convBackend 안에서 갈림).
      const remote = await convBackend.listConversations();
      if (cancelled) return;
      if (remote) {
        remote.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
        const savedActiveId = localStorage.getItem(activeConvStorageKey) ?? '';
        const activeId = remote.find(r => r.id === savedActiveId)?.id ?? remote[0]?.id ?? '';
        let activeMessages: Message[] = [];
        if (activeId) {
          activeMessages = await convBackend.listMessages(activeId);
          if (cancelled) return;
        }
        // cleanMessages 적용 후 conversations + dispatch LOAD 에 동일 값 주입 (save effect bump 방지).
        // 기존 localStorage 의 확정(approved/rejected) pendingAction status 보존 — reload 시 서버 pending
        // 으로 되돌려 승인 카드가 재출현하던 #5 차단 (admin·hub 공통; hub 는 localStorage 가 유일 소스).
        const priorActive = safeJsonParse<Conversation[]>(localStorage.getItem(convStorageKey) ?? '', [])
          .find(c => c.id === activeId)?.messages ?? [];
        // F5 복원도 hero 보존 — 백엔드 메시지엔 system-init 없으니 로컬(mount=[INIT_MESSAGE])에서 앞에 보존.
        // (reconcile·select 엔 넣고 정작 F5=init 엔 빠뜨려 새 대화 F5 시 유령 사라지던 것.)
        const cleanedActive = preserveHero(
          preserveLocalPendingStatus(cleanMessages(activeMessages), priorActive),
          messagesRef.current,
        );
        const fullList: Conversation[] = remote.map(r => ({
          id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt,
          messages: r.id === activeId ? cleanedActive : [],
        }));
        setConversations(fullList);
        localStorage.setItem(convStorageKey, JSON.stringify(fullList));
        if (activeId) {
          setActiveConvId(activeId);
          suppressBumpRef.current = activeId; // F5 복원 = 열어보기 → save effect updatedAt bump 방지(#2, handleSelectConv 와 동일 가드). 메시지 전송 시 해제.
          dispatch({ type: 'LOAD', messages: cleanedActive });
        }
        return;
      }
      // 서버 fetch 실패 → localStorage 폴백 (admin·hub 공통)
      if (cancelled) return;
      const raw = localStorage.getItem(convStorageKey);
      if (!raw) return;
      try {
        const convs = safeJsonParse<Conversation[]>(raw, []);
        if (convs.length === 0) return;
        setConversations(convs);
        const savedActiveId = localStorage.getItem(activeConvStorageKey) ?? '';
        const mostRecent = convs.reduce((a, b) => ((b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt) ? b : a));
        const active = convs.find(c => c.id === savedActiveId) ?? mostRecent;
        setActiveConvId(active.id);
        suppressBumpRef.current = active.id; // F5 폴백 복원 = 열어보기 → bump 방지(#2)
        dispatch({ type: 'LOAD', messages: preserveHero(cleanMessages(active.messages), messagesRef.current) });
      } catch (e) {
        logger.warn('useChat', 'localStorage 폴백 파싱 실패', { error: e });
        localStorage.removeItem(convStorageKey);
      }
    })();
    return () => { cancelled = true; };
  }, [setActiveConvId, hubContext, convBackend, activeConvStorageKey, convStorageKey]);

  // ── 대화 저장 — localStorage 는 messages 변경마다, DB 는 확정 시점에만 ──
  useEffect(() => {
    if (!activeConvId || conversations.length === 0) return;
    const cleanMsgs = cleanMessages(messages);
    const firstUser = cleanMsgs.find(m => m.role === 'user');
    const title = firstUser?.content
      ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
      : '새 대화';
    const now = Date.now();
    setConversations(prev => {
      const cur = prev.find(c => c.id === activeConvId);
      if (!cur) return prev;
      const prevSerialized = JSON.stringify(cur.messages ?? []);
      const newSerialized = JSON.stringify(cleanMsgs);
      const contentChanged = prevSerialized !== newSerialized;
      // 메시지·제목 모두 동일하면 early return — 불필요한 re-render + 사이드바 깜빡임 방지
      if (!contentChanged && cur.title === title) return prev;
      // 단순 열어보기(load 채움)면 updatedAt 갱신 안 함 — 메시지 안 보냈는데 목록 최상단 올라가던 #2.
      // (F5 점프의 영속 원인은 백엔드 save_conversation 이었고 거기서 root fix — 이건 within-session 가드.)
      const isLoadFill = suppressBumpRef.current === activeConvId;
      const updated = prev.map(c =>
        c.id === activeConvId
          ? { ...c, messages: cleanMsgs, title, ...(contentChanged && !isLoadFill ? { updatedAt: now } : {}) }
          : c,
      );
      updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
      localStorage.setItem(convStorageKey, JSON.stringify(updated));
      return updated;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // DB 저장 — 명시 호출. union merge 로 안전.
  // **실패 시 1회 retry + 콘솔 경고** (v0.1, 2026-04-27): silent .catch 로 묻혀서 pending status 손실 진단 불가했던 문제 가시화.
  // Hub mode 이면 saveToDb 자체 skip — /api/conversations 는 admin 인증 필수라 401 silent fail.
  // hub backend (/api/hub/<slug>/chat) 가 hub_conversations DB 자동 기록해 영속화 OK.
  const saveToDbRef = useRef<(convId: string, msgs: Message[]) => void>(() => {});
  saveToDbRef.current = (convId: string, msgs: Message[]) => {
    if (hubContext) return;
    if (!convId) return;
    const cleanMsgs = cleanMessages(msgs);
    const firstUser = cleanMsgs.find(m => m.role === 'user');
    const title = firstUser?.content
      ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
      : '새 대화';
    const convMeta = conversations.find(c => c.id === convId);
    const createdAt = convMeta?.createdAt ?? Date.now();
    const body = JSON.stringify({ id: convId, title, messages: cleanMsgs, createdAt });
    // **CRITICAL**: keepalive: true 는 브라우저 64KB body 한도 강제 — 초과 시 fetch 즉시 TypeError(Failed to fetch).
    // 큰 대화 (Html block 누적 / 한글 많은 인터랙티브 데모 등 60KB+ 흔함) 는 keepalive 끄고 일반 fetch 사용.
    // ⚠️ 한도는 **바이트** 기준 — `body.length`(문자 수, UTF-16)로 재면 한글(1자=3바이트)이 많을 때
    //    문자 수는 한도 미만인데 실제 바이트는 초과해 keepalive 가 켜진 채 TypeError 나던 버그. byte 로 측정.
    const bodyBytes = new TextEncoder().encode(body).length;
    const useKeepalive = bodyBytes < KEEPALIVE_BODY_LIMIT_BYTES;
    const attempt = (retries: number, keepalive: boolean): Promise<void> => fetch('/api/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      ...(keepalive ? { keepalive: true } : {}),
    }).then(res => {
      if (res.status === 409) {
        setConversations(prev => {
          const updated = prev.filter(c => c.id !== convId);
          localStorage.setItem(convStorageKey, JSON.stringify(updated));
          return updated;
        });
        if (activeConvId === convId) {
          setActiveConvId('');
          dispatch({ type: 'LOAD', messages: [INIT_MESSAGE] });
        }
        return;
      }
      if (!res.ok && retries > 0) {
        logger.warn('useChat', `DB save HTTP ${res.status} — ${retries}회 재시도`, { bodyBytes, keepalive });
        return new Promise<void>(resolve => setTimeout(() => attempt(retries - 1, keepalive).finally(resolve), 500));
      }
      if (!res.ok) logger.error('useChat', `DB save 최종 실패 HTTP ${res.status} — pending status 손실 위험 (body ${bodyBytes}B)`, null);
    }).catch(err => {
      // 진단 로그 3단계 — "용량 초과(keepalive 한도)" vs "진짜 버그/네트워크" 를 bodyBytes 로 구분.
      //  ① keepalive 실패 → ② 일반 fetch 로 graceful 전환(본문 한도 없음, 보통 성공) → ③ 그것도 실패면 경고.
      if (keepalive) {
        // ①+② — body 가 한도(60KB) 미만인데도 keepalive 실패 = 동시 keepalive 누적 64KB 초과 또는 네트워크.
        logger.warn('useChat', `DB save: ① keepalive 실패 → ② 일반 fetch 로 전환 (body ${bodyBytes}B / keepalive 한도 ~64KB 누적)`, { bodyBytes, error: err });
        return attempt(1, false);
      }
      if (retries > 0) {
        logger.warn('useChat', `DB save: 일반 fetch 실패 — ${retries}회 재시도 (body ${bodyBytes}B)`, { bodyBytes, error: err });
        return new Promise<void>(resolve => setTimeout(() => attempt(retries - 1, false).finally(resolve), 500));
      }
      // ③ — 일반 fetch(한도 없음)까지 실패 = 진짜 문제(서버 다운/프록시/본문 거부). bodyBytes 로 용량 원인 판별.
      logger.error('useChat', `DB save 최종 실패 ③ 일반 fetch 도 실패 — pending status 손실 위험 (body ${bodyBytes}B)`, err);
    });
    void attempt(1, useKeepalive);
  };

  // DB 재조회 — 사이드바 펼침·탭 전환·visibility change 등 여러 지점에서 호출
  // 활성 conv 의 DB 메시지를 로컬과 머지·LOAD — admin·hub **공통 reconcile** (refreshConversations 가 백엔드별로
  // fetch 후 호출 → 한 곳 고치면 양쪽 적용). 모바일 백그라운드 throttle 로 SSE 끊겨도 백엔드는 완주·영속
  // (admin=/api/chat/stream route save / hub=grpc detached spawn append_system_message) → 복귀 시 DB 완료본 복구.
  // preserveLocalPendingStatus 로 승인 status 보존. hub_messages 도 full data(blocks/suggestions/pendingActions)라 퇴화 0.
  // (잔여: 로컬이 streaming:true 로 멈춰있고 hub 로컬 id ≠ 백엔드 uuid 면 force-load 미발동 — 별도 id 정렬 안건.)
  const reconcileActiveConv = useCallback((remoteMsgsRaw: Message[], remoteUpdatedAt: number) => {
    if (!activeConvId) return;
    const convMeta = conversations.find(c => c.id === activeConvId);
    if (!convMeta) return;
    const localUpdatedAt = convMeta.updatedAt ?? convMeta.createdAt ?? 0;
    const hasInflight = messagesRef.current.some(m => m.isThinking || m.executing || m.streaming);
    const hasFallback = messagesRef.current.some(m =>
      m.role === 'system' && !m.isThinking && isFallbackContent(m.content),
    );
    const remoteMsgs = cleanMessages(remoteMsgsRaw);
    // per-message 보강 체크 — 로컬이 fallback/inflight 이고 DB 에 완료본 있으면 force LOAD.
    const shouldForceLoad = (hasInflight || hasFallback) && remoteMsgs.some(rm => {
      const local = messagesRef.current.find(lm => lm.id === rm.id);
      if (!local) return false;
      const localEmpty = !local.content?.trim() && !(local.data as any)?.blocks?.length;
      const localIsError = isFallbackContent(local.content);
      const localInflight = local.isThinking || local.executing || local.streaming;
      const remoteHasContent = (typeof rm.content === 'string' && rm.content.trim().length > 0) || ((rm.data as any)?.blocks?.length ?? 0) > 0;
      return (localEmpty || localIsError || localInflight) && remoteHasContent;
    });
    // 스트리밍 진행 중인데 DB 완료본 없으면 스킵 (LOAD 시 in-flight 메시지 유실 방지).
    if (hasInflight && !shouldForceLoad) {
      dispatch({ type: 'LOAD', messages: messagesRef.current.map(m => ({ ...m })) });
      return;
    }
    if (!shouldForceLoad && remoteUpdatedAt <= localUpdatedAt) return;
    const remoteMerged = preserveHero(preserveLocalPendingStatus(remoteMsgs, messagesRef.current), messagesRef.current);
    dispatch({ type: 'LOAD', messages: remoteMerged });
    setConversations(prev => {
      const updated = prev.map(c => c.id === activeConvId
        ? { ...c, messages: remoteMerged, updatedAt: remoteUpdatedAt }
        : c);
      updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
      localStorage.setItem(convStorageKey, JSON.stringify(updated));
      return updated;
    });
  }, [activeConvId, conversations, convStorageKey]);

  const refreshConversations = useCallback(async () => {
    if (hubContext) {
      // hub: 목록 재조회(휴지통 복원·삭제 즉시 반영) + 활성 대화 메시지 reconcile(background-resume).
      const remote = await convBackend.listConversations();
      if (!remote) return;
      setConversations(prev => {
        const merged = remote.map(r => {
          const local = prev.find(p => p.id === r.id);
          return {
            id: r.id, title: r.title, createdAt: r.createdAt,
            // 로컬이 더 최근(메시지 직후 등)이면 유지 — 폴링이 DB 옛 updatedAt 으로 끌어내려 순서 튐 방지.
            updatedAt: Math.max(r.updatedAt ?? r.createdAt, local?.updatedAt ?? 0),
            messages: local?.messages ?? [],
          };
        });
        merged.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
        return merged;
      });
      // 활성 대화 메시지 재조회 — admin 과 동일 reconcile. 옛엔 목록만 갱신·메시지는 local 보존이라 미복구였음.
      if (activeConvId) {
        const remoteUpdatedAt = remote.find(r => r.id === activeConvId)?.updatedAt ?? 0;
        const remoteMsgs = await convBackend.listMessages(activeConvId);
        reconcileActiveConv(remoteMsgs, remoteUpdatedAt);
      }
      return;
    }
    // admin: 1) 목록 재조회 — 타기기에서 삭제된 대화 제거.
    try {
      const listData = await apiGet<{ success?: boolean; conversations?: Array<{ id: string }> }>(
        '/api/conversations',
        { category: 'useChat' },
      );
      if (listData.success && Array.isArray(listData.conversations)) {
        const remoteIds = new Set<string>(listData.conversations.map(r => r.id));
        setConversations(prev => {
          const filtered = prev.filter(c => {
            if (remoteIds.has(c.id)) return true;
            if (c.id === activeConvId) return true;
            const hasRealMessages = c.messages && c.messages.some(m => m.id !== 'system-init' && m.role === 'user');
            return !hasRealMessages;
          });
          if (filtered.length === prev.length) return prev;
          localStorage.setItem(convStorageKey, JSON.stringify(filtered));
          return filtered;
        });
      }
    } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
    // 2) 활성 conv 단일 갱신 — 공통 reconcile 로 위임.
    if (!activeConvId) return;
    try {
      const data = await apiGet<{ success?: boolean; conversation?: { messages?: Message[]; updatedAt?: number } }>(
        `/api/conversations?id=${encodeURIComponent(activeConvId)}`,
        { category: 'useChat' },
      ).catch(() => null);
      if (!data || !data.success || !data.conversation) return;
      reconcileActiveConv(data.conversation.messages ?? [], data.conversation.updatedAt ?? 0);
    } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
  }, [activeConvId, hubContext, convBackend, convStorageKey, reconcileActiveConv]);

  // 복귀 시 재조회 (visible / focus) — admin·hub 공통.
  // 통합(contract C1): 옛 pagehide/hidden flush(sendBeacon 재저장) 제거. admin chat-stream route 가
  // 매 턴 서버측 영속(client disconnect 시에도 relay 완주 후 save)이라 flush 는 redundant 였고 —
  // hub 엔 없던 admin 전용 분기. 그 flush 가 F5 무전송에도 conversations 재저장→updated_at bump→목록 점프
  // 원인이었음. 제거 = admin 도 hub 처럼 server-authoritative(분리 해소) + 점프 구조적 소멸.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshConversations();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refreshConversations);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refreshConversations);
    };
  }, [refreshConversations]);

  // fallback 메시지 (TIMEOUT/INVISIBLE/EMPTY_REPLY/NETWORK) 표시 시 DB 자동 polling.
  // race: SSE 60초 timeout 직후 백엔드 67초에 DB write → visibilitychange 한 번만 발화 시 놓침.
  // 5초 간격으로 3분간 refreshConversations 호출 → DB 에 응답 들어오면 force LOAD 자동.
  const fallbackFingerprint = messages
    .filter(m => m.role === 'system' && !m.isThinking && isFallbackContent(m.content))
    .map(m => m.id).join(',');
  useEffect(() => {
    if (!activeConvId || !fallbackFingerprint) return;
    let attempts = 0;
    // 5s × 120 = 10분 — CLI 플랜 실행(도구 16+ 호출)은 watchdog(2분) 넘겨 false-timeout 떠도
    // 서버는 계속 돌아 DB 저장하므로, 긴 실행까지 답이 자동 복구되게 폴링 창 넉넉히 (옛 3분 → 부족).
    const MAX_ATTEMPTS = 120;
    const interval = setInterval(() => {
      attempts++;
      void refreshConversations();
      if (attempts >= MAX_ATTEMPTS) clearInterval(interval);
    }, 5000);
    return () => clearInterval(interval);
  }, [activeConvId, fallbackFingerprint, refreshConversations]);

  // ── 스크롤 ─────────────────────────────────────────────────────────────────
  const isNearBottomRef = useRef(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // 하단 강제 — sentinel scrollIntoView 는 모바일에서 layout viewport 기준이라 주소창/키보드만큼
  // 짧게 멈춤(끝까지 안 내려감). 스크롤 컨테이너를 scrollHeight 로 직접 내려 진짜 바닥 보장.
  // rAF 로 새 메시지·스피너 레이아웃 settle 후 측정 (fire 시점엔 높이 미반영).
  const scrollToBottom = useCallback((smooth = true) => {
    const el = chatContainerRef.current;
    if (!el) { chatEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' }); return; }
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }, []);

  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && isNearBottomRef.current) {
      scrollToBottom(true);
    }
    prevMsgCountRef.current = messages.length;
  }, [messages, scrollToBottom]);

  // ── 대화 관리 ──────────────────────────────────────────────────────────────
  const handleNewConv = useCallback(() => {
    // 빈 새 대화가 이미 있으면 재사용 — "새 대화" 연타로 빈 대화가 무한 생성·저장되던 것 방지.
    // (메시지가 들어가야 진짜 대화로 목록에 누적되는 흐름 복원)
    const existingEmpty = conversations.find(c => !(c.messages ?? []).some(m => m.id !== 'system-init' && m.role === 'user'));
    if (existingEmpty) {
      setActiveConvId(existingEmpty.id);
      dispatch({ type: 'LOAD', messages: existingEmpty.messages?.length ? existingEmpty.messages : [INIT_MESSAGE] });
      return;
    }
    // admin = client-side makeConv / hub = backend create-conversation. convBackend 가 흡수.
    void (async () => {
      const newConv = await convBackend.createConversation();
      if (!newConv) {
        logger.warn('useChat', 'create-conversation 실패');
        return;
      }
      setConversations(prev => {
        const updated = [...prev, newConv];
        localStorage.setItem(convStorageKey, JSON.stringify(updated));
        return updated;
      });
      setActiveConvId(newConv.id);
      dispatch({ type: 'LOAD', messages: newConv.messages });
    })();
  }, [convBackend, setActiveConvId, convStorageKey]);

  const handleSelectConv = useCallback((id: string) => {
    if (id === activeConvId) return;
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setActiveConvId(id);
    suppressBumpRef.current = id; // 열어보기만으로 목록 최상단 올라가는 것 방지(#2) — 새 메시지 전송 시 해제
    dispatch({ type: 'LOAD', messages: cleanMessages(conv.messages) }); // 캐시 즉시 표시

    // 서버 최신 messages fetch (admin: /api/conversations / hub: sessions list-messages) — convBackend 단일 경로.
    // 캐시 비었거나 서버가 더 많으면 서버 우선. hub 비활성 conv 는 init 때 미로드(캐시 빔)라 항상 서버 채움.
    const localRealMsgCount = conv.messages.filter(m => m.id !== 'system-init').length;
    void (async () => {
      const remoteMsgs = cleanMessages(await convBackend.listMessages(id));
      const remoteRealMsgCount = remoteMsgs.filter(m => m.id !== 'system-init').length;
      // 서버에 실제 메시지가 없으면(빈 새 대화) 로컬 welcome([INIT_MESSAGE])을 []로 덮지 않는다 — 환영문 유지.
      if (remoteRealMsgCount === 0) return;
      if (!(localRealMsgCount === 0 || remoteRealMsgCount > localRealMsgCount)) return;
      const remoteMerged = preserveHero(preserveLocalPendingStatus(remoteMsgs, conv.messages), conv.messages);
      dispatch({ type: 'LOAD', messages: remoteMerged });
      setConversations(prev => {
        const cur = prev.find(c => c.id === id);
        if (cur && JSON.stringify(cur.messages ?? []) === JSON.stringify(remoteMerged)) return prev;
        const updated = prev.map(c => (c.id === id ? { ...c, messages: remoteMerged } : c));
        localStorage.setItem(convStorageKey, JSON.stringify(updated));
        return updated;
      });
    })();
  }, [activeConvId, conversations, setActiveConvId, convBackend, convStorageKey]);

  const handleDeleteConv = useCallback((id: string) => {
    // admin: DELETE /api/conversations / hub: sessions delete-conversation(keepalive). convBackend 흡수.
    // 삭제 후 'firebat-refresh-trash' emit → Sidebar 가 휴지통 reload (즉시 노출 race fix).
    void (async () => {
      await convBackend.deleteConversation(id);
      try { window.dispatchEvent(new Event('firebat-refresh-trash')); } catch { /* SSR 무시 */ }
    })();
    const wasActive = id === activeConvId;
    const remaining = conversations.filter(c => c.id !== id);
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== id);
      localStorage.setItem(convStorageKey, JSON.stringify(updated));
      return updated;
    });
    if (!wasActive) return;
    if (remaining.length === 0) {
      setActiveConvId('');
      dispatch({ type: 'LOAD', messages: [INIT_MESSAGE] });
      return;
    }
    // 가장 최근(updatedAt) 대화를 활성화 — handleSelectConv 로 위임(캐시 LOAD + 백엔드 fetch 동일 경로).
    // 옛엔 next.messages(미오픈 conv = 빈 캐시)만 LOAD → 빈 화면("새 대화") → F5 라야 정상. 이제 select 와 동일하게 서버 채움.
    // 가드(id===activeConvId)는 next.id != 삭제된 activeConvId 라 통과. activeConvId state 갱신 전이라 OK.
    const next = remaining.reduce((a, b) => ((b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt) ? b : a));
    handleSelectConv(next.id);
  }, [conversations, activeConvId, setActiveConvId, convBackend, convStorageKey, handleSelectConv]);

  // ── 전송 ───────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (overrideText?: string, isSuggestion?: boolean, meta?: { planExecuteId?: string; planReviseId?: string }) => {
    const text = overrideText ?? input;
    if (!text.trim() || loading) return;
    suppressBumpRef.current = null; // 메시지 전송 = 실제 활동 → updatedAt 갱신 허용 (열어보기 suppress 해제)

    // AI 모델 미선택 가드 — 사용자 메시지는 표시하되 system bubble 에 안내 에러 즉시 표시.
    // 채팅창은 활성이라 사용자가 자유롭게 입력 가능, 전송 시점에 안내.
    // hub mode 는 가드 skip — backend HubService.SendMessage 가 instance.model_id 자동 사용 (visitor 가 모델 설정 영역 0).
    if (!aiModel && !hubContext) {
      const id = Date.now().toString();
      const systemId = `s-${id}`;
      // hook 안 — useTranslations 호출 X (호출은 React Component 안만). localStorage 직접 분기.
      const lang = (typeof window !== 'undefined' ? localStorage.getItem('firebat_ui_lang') : null) === 'en' ? 'en' : 'ko';
      const errMsg = lang === 'en'
        ? '⚙ Open Settings → AI tab, configure an API key or CLI authentication, then select a model.'
        : '⚙ 설정 → AI 탭에서 API 키 입력 또는 CLI 인증 후 모델을 선택해 주세요.';
      dispatch({ type: 'SEND_USER', userId: `u-${id}`, systemId, content: text, image: attachedImage || undefined });
      dispatch({ type: 'ERROR', id: systemId, error: errMsg });
      setInput('');
      setAttachedImage(null);
      return;
    }

    const userPrompt = text;
    // 첨부 이미지 — 임시 영역 (/user/attachments/) 업로드 후 slug URL 만 메시지에 사용.
    // base64 dataUrl 그대로 사용하면 messages body 크기 ↑ → keepalive 64KB 한도 초과 →
    // 모바일 첨부 첫 시도 실패 (옛 root cause). 30일 후 cleanup cron 이 자동 삭제.
    // 업로드 실패 시 base64 fallback 폐기 — 옛 root cause 복원 차단. 사용자에게 에러 표시.
    let imageData: string | null = attachedImage;
    if (imageData && imageData.startsWith('data:') && inputMode !== 'image') {
      try {
        // hub mode: 익명 visitor 가 호출 가능한 hub-scoped endpoint 사용. admin endpoint
        // (`/api/media/attach-temp`) 는 withAuth 강제라 401 → 첨부 silent fail root cause.
        const upUrl = hubContext
          ? `/api/hub/${encodeURIComponent(hubContext.slug)}/media/attach-temp`
          : '/api/media/attach-temp';
        const upHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (hubContext) {
          upHeaders['X-Api-Token'] = hubContext.apiToken;
          upHeaders['X-Session-Id'] = hubContext.sessionId;
        }
        const upRes = await fetch(upUrl, {
          method: 'POST',
          headers: upHeaders,
          body: JSON.stringify({ dataUrl: imageData }),
        });
        const upJson = await upRes.json() as { success?: boolean; data?: { url?: string }; error?: string };
        if (upJson?.success && upJson?.data?.url) {
          imageData = upJson.data.url;
        } else {
          alert(`첨부 이미지 업로드 실패: ${upJson?.error ?? '응답 오류'}`);
          return;
        }
      } catch (err) {
        alert(`첨부 이미지 업로드 실패 (네트워크): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setInput('');
    setAttachedImage(null);
    const id = Date.now().toString();
    const systemId = `s-${id}`;

    // conversationId 를 첫 턴부터 확보 — setActiveConvId 는 비동기 state 라 같은 함수 안에서
    // activeConvId 는 빈 값 그대로 (stale closure). 지역 변수로 잡아 요청 body 에 첫 턴부터 포함.
    // 이게 빠지면 첫 턴 backend hr.resolve(회상)·CLI session_id 저장이 conv_id=None 으로 죽어
    // 대화 초반 맥락이 영구 소실됨.
    let effectiveConvId = activeConvId;
    if (!effectiveConvId) {
      const newConv = makeConv();
      setConversations(prev => {
        const updated = [...prev, newConv];
        localStorage.setItem(convStorageKey, JSON.stringify(updated));
        return updated;
      });
      setActiveConvId(newConv.id);
      effectiveConvId = newConv.id;
    }

    // 사용자가 submit 한 시점 = 항상 하단 강제. 옛 동작 = dispatch 후 setRef → useEffect
    // race 로 자동 스크롤 effect 가 옛 false ref 값 보고 skip 하던 부분. dispatch 보다 먼저 ref
    // 갱신해 effect 가 새 length 변화 시 ref=true 그대로 read.
    // AI 답변 stream 중에는 chunk 가 messages length 변화 없어 자동 scroll 발화 0 → 사용자
    // 가 직접 내리며 보게 (옛 직접 호출 X).
    isNearBottomRef.current = true;
    if (isSuggestion) {
      dispatch({ type: 'SEND_SUGGESTION', systemId });
    } else {
      dispatch({ type: 'SEND_USER', userId: `u-${id}`, systemId, content: userPrompt, image: imageData || undefined });
    }

    // ── 이미지 모드 (LLM 우회) ─────────────────────────────────────────
    // inputMode='image' 면 입력 텍스트를 prompt 로 직접 image_gen → /api/media/generate.
    // suggestion·meta(plan-confirm/plan-revise)·attached image 는 모두 무시 (이미지 모드에선 의미 X).
    // StatusManager job 은 server 가 발행 → ActiveJobsIndicator 자동 표시.
    if (inputMode === 'image' && !isSuggestion && !meta?.planExecuteId && !meta?.planReviseId) {
      setLoading(true);
      scrollToBottom(true);
      try {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const json: { success?: boolean; data?: any; error?: string } = await apiPost<{ success?: boolean; data?: any; error?: string }>(
          '/api/media/generate',
          { prompt: userPrompt },
          { signal: ctrl.signal, category: 'useChat' },
        ).catch((err: any) => ({ success: false, error: err?.message ?? '네트워크 오류' }));
        if (!json.success || !json.data) {
          dispatch({ type: 'ERROR', id: systemId, error: json.error || '이미지 생성 실패' });
        } else {
          const d = json.data;
          // render_image 와 동일 포맷 — components.tsx 의 ImageComp 가 variants/blurhash/thumbnailUrl 자동 활용
          const block = {
            type: 'Image',
            src: d.url,
            alt: userPrompt.slice(0, 80),
            ...(d.width ? { width: d.width } : {}),
            ...(d.height ? { height: d.height } : {}),
            ...(d.variants ? { variants: d.variants } : {}),
            ...(d.blurhash ? { blurhash: d.blurhash } : {}),
            ...(d.thumbnailUrl ? { thumbnailUrl: d.thumbnailUrl } : {}),
          };
          dispatch({
            type: 'RESULT',
            id: systemId,
            payload: { reply: '', data: { blocks: [block] }, executedActions: ['image_gen'] },
            hasAnimation: false,
            lastTextIdx: -1,
          });
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          dispatch({ type: 'ABORTED', id: systemId });
        } else {
          dispatch({ type: 'NETWORK_ERROR', id: systemId, message: err?.message || '네트워크 오류' });
        }
      } finally {
        dispatch({ type: 'FINALIZE', id: systemId });
        setLoading(false);
        abortRef.current = null;
      }
      return;
    }

    // 명령 전송 직후엔 무조건 하단으로 — isNearBottomRef 는 dispatch 전에 갱신해 useEffect 자동
    // scroll 발화. 추가 명시 — 컨테이너 scrollHeight 직접 (모바일 진짜 바닥). 한 번 더 늦게도 호출해
    // 스피너·thinking 높이 늘어난 뒤 위치 재보정.
    scrollToBottom(true);
    setTimeout(() => scrollToBottom(true), 120);

    // 저장 시점 1: 유저 메시지 DB 즉시 반영 (다음 프레임에 최신 messages ref 로)
    const convIdForSave = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (convIdForSave) {
      queueMicrotask(() => saveToDbRef.current(convIdForSave, messagesRef.current));
    }
    setLoading(true);

    try {
      const chatHistory = messages
        .filter(m => m.id !== 'system-init' && !m.isThinking)
        .map(m => {
          const role = m.role === 'system' ? 'model' : 'user';
          let content = (m.content || '').trim();
          if (!content && m.data && Array.isArray(m.data.blocks)) {
            const texts = m.data.blocks
              .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text as string);
            content = texts.join('\n').trim();
          }
          return { role, content: content || '(빈 응답)' };
        })
        .filter(h => h.content && h.content !== '(빈 응답)');

      const previousResponseId: string | undefined = undefined;

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      cancelWatchdog();
      // onFire 핸들러 등록 — SSE 이벤트 올 때마다 resetWatchdog 가 이걸로 재스케줄
      watchdogOnFireRef.current = () => {
        ctrl.abort();
        cancelChunkAnim();
        dispatch({ type: 'TIMEOUT', id: systemId });
        setLoading(false);
      };
      resetWatchdog();

      // Hub page mode 분기 — hubContext 가 있으면 /api/hub/<slug>/chat 호출 (익명 + apiToken).
      // 옛 admin 의 /api/chat/stream 호출 분기 = hubContext 없을 때.
      const isHubMode = !!hubContext;
      const endpoint = isHubMode
        ? `/api/hub/${encodeURIComponent(hubContext.slug)}/chat`
        : '/api/chat/stream';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isHubMode) {
        headers['X-Api-Token'] = hubContext.apiToken;
        headers['X-Session-Id'] = hubContext.sessionId;
      }
      const body: Record<string, unknown> = isHubMode
        ? {
            message: userPrompt,
            planMode,
            // 클라 발급 메시지 id — admin systemId/userId 패턴 미러. hub_messages id 가 로컬과 정렬되어
            // background-resume reconcile 이 streaming-stuck 케이스도 매칭(옛엔 백엔드 uuid 라 불일치).
            aiMsgId: systemId,
            userMsgId: `u-${id}`,
            ...(meta?.planExecuteId ? { planExecuteId: meta.planExecuteId } : {}),
            ...(meta?.planReviseId ? { planReviseId: meta.planReviseId } : {}),
          }
        : {
            prompt: userPrompt,
            config: { model: aiModel },
            history: chatHistory,
            mode: 'tools',
            planMode,
            systemId,
            userId: `u-${id}`,
            // suggestion 픽 = 히스토리엔 저장하되(AI 맥락) 렌더는 제외 — 백엔드가 user 메시지에 suggestionClick
            // 플래그를 달게 해서 isSuggestionClickUserMessage 가 리로드 시 버블을 숨김.
            ...(isSuggestion ? { userSuggestion: true } : {}),
            ...(meta?.planExecuteId ? { planExecuteId: meta.planExecuteId } : {}),
            ...(meta?.planReviseId ? { planReviseId: meta.planReviseId } : {}),
            ...(effectiveConvId ? { conversationId: effectiveConvId } : {}),
            ...(imageData ? { image: imageData } : {}),
            ...(previousResponseId ? { previousResponseId } : {}),
          };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify(body),
      });

      // SSE 아닌 일반 JSON 응답 (401 / 403 / 500 / CORS 등) — content-type 으로 판별 후
      // 즉시 ERROR dispatch. 옛 = 일반 JSON body 를 SSE parser 가 읽어서 events=0 → done →
      // invariant INVISIBLE fallback. 모바일 (삼성 인터넷 등) 안 header 누락 시 401 → invariant
      // "응답이 비어있습니다 (SSE 연결 누락 가능성)" 표시되어 root cause 가려지는 영역 fix.
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.includes('text/event-stream')) {
        let errMsg = `요청 실패 (HTTP ${res.status})`;
        try {
          const errJson = await res.json();
          if (errJson?.error) errMsg = String(errJson.error);
        } catch { /* body 가 JSON 아님 — 기본 메시지 유지 */ }
        dispatch({ type: 'ERROR', id: systemId, error: errMsg });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림을 읽을 수 없습니다.');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          // SSE chunk 도착 = 살아있음 → watchdog 재스케줄 (idle timeout 방식)
          resetWatchdog();
        }
        if (done && buffer.trim()) buffer += '\n\n';

        const parsed = parseSSE(buffer);
        buffer = parsed.remaining;

        for (const ev of parsed.events) {
          if (ev.event === 'chunk') {
            const chunkType = ev.data.type as 'text' | 'thinking' | 'build_step';
            const chunkContent = (ev.data.content as string) ?? '';
            if (!chunkContent) continue;
            if (chunkType === 'build_step') {
              // Project Builder — 턴 도중 advance_build 가 올린 라이브 빌드 step. 본문/생각 누적 X,
              // 카드 stepper/로더만 갱신(생성 13분 동안 "구현" 표시 → frozen 해소).
              try {
                const sess = JSON.parse(chunkContent) as { step?: string };
                if (sess?.step) dispatch({ type: 'BUILD_STEP', id: systemId, step: sess.step });
              } catch { /* malformed build_step — 무시 */ }
              continue;
            }
            if (chunkType === 'thinking') dispatch({ type: 'CHUNK_THINKING', id: systemId, content: chunkContent });
            else dispatch({ type: 'CHUNK_TEXT', id: systemId, content: chunkContent });
          } else if (ev.event === 'step') {
            const stepStart = ev.data.status === 'start';
            dispatch({ type: 'STEP', id: systemId, step: ev.data, isLast: !stepStart });
          } else if (ev.event === 'result') {
            const pendingActions = (ev.data.data?.pendingActions as PendingAction[] | undefined)
              ?.map(p => ({ ...p, createdAt: p.createdAt ?? Date.now() })); // 수신 시각 stamp — 카드 만료 표시 기준
            const blocksData = ev.data.data?.blocks as Array<{ type: string; text?: string }> | undefined;
            const hasBlocks = Array.isArray(blocksData) && blocksData.length > 0;
            const hasAnyOutput = !!(ev.data.executedActions?.length) || hasBlocks || !!(pendingActions?.length);
            const fullReply: string = ev.data.reply
              || (ev.data.error ? ''
                : hasAnyOutput ? '실행이 완료되었습니다.'
                : t(FALLBACK_I18N_KEYS.EMPTY_REPLY));
            const shouldAnimate = !!fullReply && !ev.data.error;
            const lastTextIdx = hasBlocks ? (() => {
              for (let i = blocksData!.length - 1; i >= 0; i--) if (blocksData![i].type === 'text') return i;
              return -1;
            })() : -1;

            cancelChunkAnim();

            // 기존에 RESULT 도착 후 setInterval(25ms) 로 text 를 progressive append 하던 애니메이션이 있었으나:
            //   - 백그라운드 탭 브라우저가 타이머를 1초로 throttle → 25ms 기대 tick 이 사실상 느려짐
            //   - 그 사이 FINALIZE + DB 저장이 blocks[0].text='' 상태로 박제 → 복귀 시 빈 버블
            //   - CLI 모드는 어차피 10~100초 대기 후 한 번에 도착 — "타이핑 느낌" 효과 실익도 적음
            // → 애니메이션 제거. RESULT 도착 즉시 최종 text 저장. chunk 이벤트 기반 실시간 스트리밍은 유지 (OpenAI API 등).
            dispatch({
              type: 'RESULT',
              id: systemId,
              payload: {
                reply: fullReply,
                thoughts: ev.data.thoughts,
                executedActions: ev.data.executedActions,
                toolResults: ev.data.toolResults,
                libraryHits: ev.data.libraryHits,
                data: ev.data.data,
                error: ev.data.error,
                suggestions: ev.data.suggestions,
                pendingActions,
              },
              hasAnimation: false, // 항상 full reply 즉시 세팅
              lastTextIdx,
            });
            if (ev.data.executedActions?.length) {
              onRefresh();
              window.dispatchEvent(new Event('firebat-refresh'));
            }
          } else if (ev.event === 'error') {
            cancelChunkAnim();
            dispatch({ type: 'ERROR', id: systemId, error: ev.data.error });
          }
        }
        if (done) break;
      }
    } catch (err: any) {
      cancelChunkAnim();
      cancelWatchdog();
      if (err?.name === 'AbortError') dispatch({ type: 'ABORTED', id: systemId });
      else dispatch({ type: 'NETWORK_ERROR', id: systemId, message: err.message });
    } finally {
      cancelWatchdog();
      // 스트림 종료 안전망 — 여전히 in-flight 면 reducer 의 FINALIZE + enforceInvariant 가 자동 복구
      dispatch({ type: 'FINALIZE', id: systemId });
      abortRef.current = null;
      setLoading(false);
      // 저장 시점 2: AI 응답 완료 직후 DB 반영.
      // ⚠️ 직전 dispatch(FINALIZE) 는 React batched commit 이라 microtask 보다 늦게 적용될 수 있음.
      // queueMicrotask 안에서 messagesRef.current 가 pre-FINALIZE 라 system 메시지가 아직 streaming:true →
      // cleanMessages 필터링 → DB 에 user 만 저장되어 AI 답변 영구 손실. (2026-05-11 진단)
      // chatReducer 를 동기 호출해 finalized snapshot 을 만들어 race 차단.
      const convIdForSave2 = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
      if (convIdForSave2) {
        const finalizedMsgs = chatReducer(messagesRef.current, { type: 'FINALIZE', id: systemId });
        saveToDbRef.current(convIdForSave2, finalizedMsgs);
      }
    }
  }, [input, loading, activeConvId, messages, aiModel, onRefresh, attachedImage, planMode, inputMode, setActiveConvId, hubContext]);

  // 레거시 JSON 모드의 handleConfirmPlan / handleRejectPlan 은 v0.1, 2026-04-22 제거됨.
  // 현재는 propose_plan 도구 → PlanCard (render_* blocks) → suggestions 의 plan-confirm 버튼으로
  // handleSubmit(text, true, { planExecuteId }) 호출 — 모두 Function Calling 경로.

  // pending 상태 변경 후 DB 저장 — 새로고침 시 status 사라짐 방지.
  // dispatch 직후 messagesRef 가 React 재렌더 전이라 stale 가능 → 새 status 를 직접 계산해 즉시 save.
  // **이중 저장 + 검증** (v0.1, 2026-04-27): 사용자가 승인 → 리빌드 → 다시 들어가니 버튼 재등장 케이스 방어.
  // 1) localStorage 즉시 동기 갱신 — useEffect 비동기 갱신 race 우회.
  // 2) DB POST 응답 await 후 실패 시 콘솔 경고 + 1회 retry — silent .catch 로 묻혔던 문제 가시화.
  const persistPendingChange = useCallback((msgId: string, planId: string, patch: Partial<{ status: 'approved' | 'rejected' | 'past-runat' | 'error'; errorMessage: string; originalRunAt: string }>) => {
    const convId = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (!convId) return;
    const updated = messagesRef.current.map(m =>
      m.id !== msgId
        ? m
        : { ...m, pendingActions: m.pendingActions?.map(p => p.planId === planId ? { ...p, ...patch } : p) },
    );
    // 1) localStorage 즉시 동기 갱신 — 새로고침 시 로컬 캐시가 우선 로드되므로 status 보존 보장
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(convStorageKey) : null;
      if (raw) {
        const convs = safeJsonParse<Conversation[]>(raw, []);
        const next = convs.map(c => c.id === convId ? { ...c, messages: cleanMessages(updated), updatedAt: Date.now() } : c);
        localStorage.setItem(convStorageKey, JSON.stringify(next));
      }
    } catch (e) { logger.warn('useChat', 'localStorage pending status update 실패', { error: e }); }
    // 2) DB POST — 실패 시 1회 retry. 그래도 실패면 콘솔 경고 (조용히 묻히지 않게).
    saveToDbRef.current(convId, updated);
  }, [activeConvId]);

  // Pending tool 개별 승인
  const handleApprovePending = useCallback(async (msgId: string, planId: string, action?: 'now' | 'reschedule', newRunAt?: string) => {
    try {
      type CommitResult = { success: boolean; code?: string; error?: string; originalRunAt?: string };
      let data: CommitResult;
      if (hubContext) {
        // hub 방문자 — /api/hub/<slug>/plan (op=commit). hub 는 schedule_task 미허용이라 action/runAt 무관.
        const res = await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': hubContext.apiToken,
            'X-Session-Id': hubContext.sessionId,
          },
          body: JSON.stringify({ op: 'commit', planId }),
        });
        data = await res.json().catch(() => ({ success: false, error: '실행 실패' }));
      } else {
        const qs = new URLSearchParams({ planId });
        if (action) qs.set('action', action);
        data = await apiPost<CommitResult>(
          `/api/plan/commit?${qs.toString()}`,
          newRunAt ? { runAt: newRunAt } : {},
          { category: 'useChat' },
        ).catch((err: any) => ({ success: false, error: err?.message ?? '실행 실패' }));
      }
      if (data.success) {
        dispatch({ type: 'PENDING_APPROVED', msgId, planId });
        onRefresh();
        window.dispatchEvent(new Event('firebat-refresh'));
        persistPendingChange(msgId, planId, { status: 'approved' });
      } else if (data.code === 'PAST_RUNAT') {
        dispatch({ type: 'PENDING_PAST_RUNAT', msgId, planId, originalRunAt: data.originalRunAt });
        persistPendingChange(msgId, planId, { status: 'past-runat', originalRunAt: data.originalRunAt });
      } else {
        const errorMessage = data.error || '실행 실패';
        dispatch({ type: 'PENDING_ERROR', msgId, planId, errorMessage });
        persistPendingChange(msgId, planId, { status: 'error', errorMessage });
      }
    } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
  }, [onRefresh, persistPendingChange, hubContext]);

  // Pending tool 개별 거부
  const handleRejectPending = useCallback(async (msgId: string, planId: string) => {
    try {
      if (hubContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': hubContext.apiToken,
            'X-Session-Id': hubContext.sessionId,
          },
          body: JSON.stringify({ op: 'reject', planId }),
        });
      } else {
        await apiPost(`/api/plan/reject?planId=${encodeURIComponent(planId)}`, undefined, { category: 'useChat' });
      }
      dispatch({ type: 'PENDING_REJECTED', msgId, planId });
      persistPendingChange(msgId, planId, { status: 'rejected' });
    } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
  }, [persistPendingChange, hubContext]);

  // Suggestion 클릭 시 해당 메시지의 suggestions 클리어 + DB 즉시 저장 — 새로고침 시 카드 재등장 차단
  const consumeSuggestions = useCallback((msgId: string) => {
    const convId = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (!convId) {
      dispatch({ type: 'CONSUME_SUGGESTIONS', msgId });
      return;
    }
    const updated = messagesRef.current.map(m =>
      m.id !== msgId ? m : { ...m, suggestions: undefined },
    );
    saveToDbRef.current(convId, updated);
    dispatch({ type: 'CONSUME_SUGGESTIONS', msgId });
  }, [activeConvId]);

  // 칩 픽 잠금 — consumeSuggestions(칩 제거)와 달리 칩은 남기고 픽 텍스트만 기록(잠금 강조 렌더용). DB 즉시 저장.
  const lockSuggestion = useCallback((msgId: string, picked: string) => {
    const convId = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (convId) {
      const updated = messagesRef.current.map(m => m.id !== msgId ? m : { ...m, pickedSuggestion: picked });
      saveToDbRef.current(convId, updated);
    }
    dispatch({ type: 'LOCK_SUGGESTION', msgId, picked });
  }, [activeConvId]);

  const convMetas: ConversationMeta[] = conversations.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));

  return {
    messages, input, setInput, loading,
    attachedImage, setAttachedImage,
    conversations: convMetas, activeConvId,
    chatEndRef, chatContainerRef, handleScroll,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit,
    handleApprovePending, handleRejectPending, consumeSuggestions, lockSuggestion,
    handleStop,
    planMode, setPlanMode,
    inputMode, setInputMode,
    refreshConversations, // 사이드바 펼침·탭 전환 등 on-demand 동기화용
  };
}
