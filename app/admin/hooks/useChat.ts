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
import { alertDialog } from '../components/Dialog';
import { useTranslations } from '../../../lib/i18n';
import { useSetting } from './settings-manager';
import { useWakeLock } from './use-wake-lock';
import { CHAT_WATCHDOG_IDLE_MS } from '../../../lib/config';
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
/** convBackend transport 결과 shape — admin/hub 공통. */
type PlanCommitResult = { success: boolean; code?: string; error?: string; originalRunAt?: string };
type UploadResult = { success?: boolean; data?: { url?: string }; error?: string };
type ChatEndpoint = { url: string; headers: Record<string, string> };
/** chat send 의 owner-무관 입력 — convBackend.chatBody 가 owner 별 wire shape 로 변환(단일 주입 지점). */
type ChatBodyParams = {
  userPrompt: string;
  model: string;
  planMode: unknown;
  systemId: string;
  userMsgId: string;
  history: Array<{ role: string; content: unknown; image?: string | null; imageMimeType?: string | null }>;
  isSuggestion: boolean;
  planExecuteId?: string;
  planReviseId?: string;
  conversationId?: string;
  image?: string | null;
  previousResponseId?: string;
};

/** hub message (row wire) → frontend Message. canonical join — columns (id/role/content) ∪ data_json.
 *  Same as Rust split_message/join_message: data_json = rich (badges at top, blocks under data, createdAt, ...).
 *  Columns id/role/content are authoritative (override). Byte-identical to admin get_conversation's join. */
function mapHubMessages(
  hubMsgs: Array<{ id: string; role: string; content?: string; dataJson?: string }>,
): Message[] {
  return hubMsgs.map(m => {
    const role = m.role === 'system' ? ('system' as const) : ('user' as const);
    const rich = safeJsonParse<Record<string, unknown>>(m.dataJson ?? '', {});
    return {
      ...(rich && typeof rich === 'object' ? rich : {}),
      id: m.id,
      role,
      content: m.content ?? '',
    } as Message;
  });
}

/** When reload/refresh/select replaces local with DB (remote) messages, do not revert a pendingAction status
 *  that is already terminal locally (approved/rejected/error) back to the DB's "pending". Without this, polling/
 *  refetch/restart LOAD right after an approval could load the DB (pending, before the in-flight save) and the
 *  approval card would reappear. Local terminal status wins; the next save heals the DB too. */
const TERMINAL_PENDING = new Set(['approved', 'rejected', 'error', 'past-runat']);

// Preserve the active session's in-memory terminal status (approved/rejected) so reconcile/refresh does not
// overwrite it with backend "pending" — a race guard while the saveMessage/saveToDb POST is in flight. The DB
// is the persistence authority → after reload/new-build it holds the terminal status, so cards never resurrect.
// (admin·hub identical — both persist to the backend.)
function preserveLocalPendingStatus(remote: Message[], local: Message[]): Message[] {
  const localById = new Map(local.map(m => [m.id, m]));
  return remote.map(rm => {
    if (!rm.pendingActions?.length) {
      // Remote copy LOST its pendingActions (e.g. a duplicate turn overwrote the row with an
      // empty response — 2026-07-15 codex 실측: 재요청이 같은 세션 resume 으로 도구 0 응답을
      // 만들어 행을 덮음) — keep the local card instead of wiping it; the next persistMessage
      // (approve/reject) heals the DB copy.
      const lm = localById.get(rm.id);
      return lm?.pendingActions?.length ? { ...rm, pendingActions: lm.pendingActions } : rm;
    }
    const lm = localById.get(rm.id);
    const localByPlan = lm?.pendingActions
      ? new Map(lm.pendingActions.map(p => [p.planId, p]))
      : new Map<string, PendingAction>();
    return {
      ...rm,
      pendingActions: rm.pendingActions.map(rp => {
        const lp = localByPlan.get(rp.planId);
        // Preserve createdAt (local stamp) even on non-terminal cards — keeps expiry calc valid after reload.
        return lp && TERMINAL_PENDING.has(String(lp.status)) ? { ...rp, ...lp } : { ...rp, createdAt: lp?.createdAt ?? rp.createdAt };
      }),
    };
  });
}

/** The system-init hero (👻 welcome) is client-only (not backend-persisted). When LOAD/merging from backend
 *  messages, keep it at the front if present locally — so after starting a chat in a new conversation, a
 *  reconcile/refresh keeps the hero as the first message (pushed up, not vanishing mid-list). If absent locally
 *  (loading an old conversation), don't add it. */
function preserveHero(merged: Message[], local: Message[]): Message[] {
  const hero = local.find(m => m.id === 'system-init');
  if (hero && !merged.some(m => m.id === 'system-init')) return [hero, ...merged];
  return merged;
}

/** Reconcile the local conversation list against the owner's backend list — one path for admin & hub
 *  (convBackend injects the owner via auth; this logic is owner-agnostic). Rebuilds from the backend list
 *  (locally-derived title + cached messages preserved), keeps active/unsaved local-only convs (lazy admin
 *  creation), drops convs deleted elsewhere, sorts by recency. */
function reconcileConvList(prev: Conversation[], remote: ConvBackendMeta[], activeConvId: string): Conversation[] {
  const remoteIds = new Set(remote.map(r => r.id));
  // Keep a local conv missing from the backend only if it's active or unsaved-empty (a brand-new conv not yet
  // persisted); otherwise it was deleted elsewhere → drop.
  const survivors = prev.filter(c => {
    if (remoteIds.has(c.id)) return true;
    if (c.id === activeConvId) return true;
    const hasRealMessages = c.messages?.some(m => m.id !== 'system-init' && m.role === 'user');
    return !hasRealMessages;
  });
  const localById = new Map(survivors.map(c => [c.id, c] as const));
  const merged: Conversation[] = remote.map(r => {
    const local = localById.get(r.id);
    return {
      id: r.id,
      title: local?.title || r.title,           // locally-derived title (instant) wins; DB title for fresh/other-session
      createdAt: r.createdAt,
      updatedAt: Math.max(r.updatedAt ?? r.createdAt, local?.updatedAt ?? 0),
      messages: local?.messages ?? [],          // empty for restored/elsewhere convs → filled on select
    };
  });
  for (const c of survivors) if (!remoteIds.has(c.id)) merged.push(c);  // local-only (active/unsaved) appended
  merged.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
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
      const hubPlan = (op: string, planId: string): Promise<PlanCommitResult> =>
        fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': hubContext.apiToken,
            'X-Session-Id': hubContext.sessionId,
          },
          body: JSON.stringify({ op, planId }),
        }).then(r => r.json()).catch(() => ({ success: false, error: '실행 실패' }));
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
        // id = conversation id (the message carries its own id for the row upsert).
        async saveMessage(convId: string, message: unknown): Promise<void> {
          await hf('save-message', { id: convId, message }).catch(() => {});
        },
        // hub has no schedule_task → action/newRunAt ignored.
        async commitPlan(planId: string, _action?: 'now' | 'reschedule', _newRunAt?: string): Promise<PlanCommitResult> {
          return hubPlan('commit', planId);
        },
        async rejectPlan(planId: string): Promise<void> {
          await hubPlan('reject', planId);
        },
        async uploadAttachment(dataUrl: string): Promise<UploadResult> {
          return fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/media/attach-temp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubContext.apiToken, 'X-Session-Id': hubContext.sessionId },
            body: JSON.stringify({ dataUrl }),
          }).then(r => r.json());
        },
        chatEndpoint(): ChatEndpoint {
          return {
            url: `/api/hub/${encodeURIComponent(hubContext.slug)}/chat`,
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubContext.apiToken, 'X-Session-Id': hubContext.sessionId },
          };
        },
        // hub wire shape — conv is session-derived (no conversationId in body); model/history backend-managed.
        chatBody(p: ChatBodyParams): Record<string, unknown> {
          return {
            message: p.userPrompt,
            planMode: p.planMode,
            aiMsgId: p.systemId,
            userMsgId: p.userMsgId,
            ...(p.planExecuteId ? { planExecuteId: p.planExecuteId } : {}),
            ...(p.planReviseId ? { planReviseId: p.planReviseId } : {}),
          };
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
      async saveMessage(convId: string, message: unknown): Promise<void> {
        await fetch('/api/conversations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: convId, message }),
        }).catch(() => {});
      },
      async commitPlan(planId: string, action?: 'now' | 'reschedule', newRunAt?: string): Promise<PlanCommitResult> {
        const qs = new URLSearchParams({ planId });
        if (action) qs.set('action', action);
        return apiPost<PlanCommitResult>(
          `/api/plan/commit?${qs.toString()}`,
          newRunAt ? { runAt: newRunAt } : {},
          { category: 'useChat' },
        ).catch((err: any) => ({ success: false, error: err?.message ?? '실행 실패' }));
      },
      async rejectPlan(planId: string): Promise<void> {
        await apiPost(`/api/plan/reject?planId=${encodeURIComponent(planId)}`, undefined, { category: 'useChat' }).catch(() => {});
      },
      async uploadAttachment(dataUrl: string): Promise<UploadResult> {
        return fetch('/api/media/attach-temp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        }).then(r => r.json());
      },
      chatEndpoint(): ChatEndpoint {
        return { url: '/api/chat/stream', headers: { 'Content-Type': 'application/json' } };
      },
      // admin wire shape — prompt/config/history + systemId/userId (route maps to its RPC).
      chatBody(p: ChatBodyParams): Record<string, unknown> {
        return {
          prompt: p.userPrompt,
          config: { model: p.model },
          history: p.history,
          mode: 'tools',
          planMode: p.planMode,
          systemId: p.systemId,
          userId: p.userMsgId,
          ...(p.isSuggestion ? { userSuggestion: true } : {}),
          ...(p.planExecuteId ? { planExecuteId: p.planExecuteId } : {}),
          ...(p.planReviseId ? { planReviseId: p.planReviseId } : {}),
          ...(p.conversationId ? { conversationId: p.conversationId } : {}),
          ...(p.image ? { image: p.image } : {}),
          ...(p.previousResponseId ? { previousResponseId: p.previousResponseId } : {}),
        };
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

  // ── Init: DB-first load (guarantees multi-device sync); fall back to localStorage only on failure ──
  // In hub mode, skip the admin /api/conversations call and use /api/hub/<slug>/sessions instead —
  // the conversation store gives multi-device sync + full multi-conv behaviour.
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
        // After cleanMessages, feed the same value to conversations + dispatch LOAD (avoids a save-effect bump).
        // Preserve terminal (approved/rejected) pendingAction status from localStorage — stops the approval card
        // from reappearing when reload reverts to the server's "pending" (admin·hub shared).
        const priorActive = safeJsonParse<Conversation[]>(localStorage.getItem(convStorageKey) ?? '', [])
          .find(c => c.id === activeId)?.messages ?? [];
        // F5 restore also preserves the hero — backend messages have no system-init, so keep it from local
        // (mount=[INIT_MESSAGE]). (It was added on reconcile/select but missed on F5=init → hero vanished on new-chat F5.)
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

  // ── Persist conversation — localStorage on every messages change, DB only at commit points ──
  useEffect(() => {
    if (!activeConvId || conversations.length === 0) return;
    const cleanMsgs = cleanMessages(messages);
    const firstUser = cleanMsgs.find(m => m.role === 'user');
    const derivedTitle = firstUser?.content
      ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
      : null;
    const now = Date.now();
    setConversations(prev => {
      const cur = prev.find(c => c.id === activeConvId);
      if (!cur) return prev;
      // Keep the existing title when the loaded messages momentarily lack a user message (e.g. a select
      // transition with an empty cache) — never downgrade a real title back to '새 대화'. Re-derive only
      // when a user message is present.
      const title = derivedTitle ?? cur.title ?? '새 대화';
      const prevSerialized = JSON.stringify(cur.messages ?? []);
      const newSerialized = JSON.stringify(cleanMsgs);
      const contentChanged = prevSerialized !== newSerialized;
      // early-return if both messages and title are unchanged — avoids needless re-render + sidebar flicker.
      if (!contentChanged && cur.title === title) return prev;
      // A plain open (load fill) does not bump updatedAt — otherwise just viewing pushed the conv to the top (#2).
      // (The persistent cause of F5 jump was backend save_conversation, fixed at the root; this is the in-session guard.)
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

  // Turn persistence is server-side for both admin & hub — the chat route appends the user message upfront
  // (AI-error-safe) and the AI message after (relay completes even on client disconnect). No frontend turn-save.
  // Single-message client-state (approve/reject, suggestion clear/lock) persists via persistMessage → convBackend.

  // Re-fetch from DB — called from several places (sidebar expand, tab switch, visibility change, ...).
  // Merge+LOAD the active conv's DB messages with local — admin·hub shared reconcile (refreshConversations
  // fetches per-backend then calls this → fix once, both apply). Even if SSE drops on mobile background throttle,
  // the backend finishes and persists (admin=/api/chat/stream route save / hub=grpc detached append_system_message)
  // → on return the completed DB copy is restored. preserveLocalPendingStatus keeps approval status; rows store
  // full data (blocks/suggestions/pendingActions) so there is no degradation on reload.
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
    // One path for admin & hub — convBackend injects the owner (admin session / hub token); the reconcile
    // logic below is owner-agnostic, so testing one surface covers both. (No hubContext branch.)
    const remote = await convBackend.listConversations();
    if (remote) {
      setConversations(prev => {
        const merged = reconcileConvList(prev, remote, activeConvId);
        const sig = (l: Conversation[]) => l.map(c => `${c.id}:${c.title}:${c.updatedAt}`).join('|');
        if (merged.length === prev.length && sig(merged) === sig(prev)) return prev; // unchanged → skip re-render
        localStorage.setItem(convStorageKey, JSON.stringify(merged));
        return merged;
      });
    }
    // active conv message reconcile (background-resume) — shared.
    if (activeConvId) {
      const remoteUpdatedAt = remote?.find(r => r.id === activeConvId)?.updatedAt ?? 0;
      reconcileActiveConv(await convBackend.listMessages(activeConvId), remoteUpdatedAt);
    }
  }, [activeConvId, convBackend, convStorageKey, reconcileActiveConv]);

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
    // 캐시 즉시 표시 + 유령(system-init 환영) 재부착 — init/F5(307) 와 대칭. select 만 빠져 선택 시 유령 안 뜨던 것.
    dispatch({ type: 'LOAD', messages: preserveHero(cleanMessages(conv.messages), [INIT_MESSAGE]) });

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
        // Single owner-injected upload (convBackend.uploadAttachment): admin /api/media/attach-temp /
        // hub /api/hub/<slug>/media/attach-temp (anonymous visitor endpoint; admin one is withAuth → 401).
        const upJson = await convBackend.uploadAttachment(imageData);
        if (upJson?.success && upJson?.data?.url) {
          imageData = upJson.data.url;
        } else {
          void alertDialog({ title: t('chat_input.attach_fail_title'), message: t('chat_input.attach_fail_upload', { detail: String(upJson?.error ?? 'no response') }), danger: true });
          return;
        }
      } catch (err) {
        void alertDialog({ title: t('chat_input.attach_fail_title'), message: t('chat_input.attach_fail_network', { detail: err instanceof Error ? err.message : String(err) }), danger: true });
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

    // Turn persistence is server-side (chat route): user message upfront (AI-error-safe) + AI message after.
    // Same as hub → no frontend saveToDb. (localStorage conv cache is still updated by the [messages] effect.)
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

      // Endpoint + headers + body from the single owner-injected layer (convBackend). The owner-specific wire
      // shape lives in convBackend.chatBody (admin prompt/config vs hub message) — handleSubmit stays owner-agnostic.
      // Client-issued message ids (systemId / u-<id>) mirror across admin·hub so reconcile matches stored rows.
      const { url: endpoint, headers } = convBackend.chatEndpoint();
      const body = convBackend.chatBody({
        userPrompt,
        model: aiModel,
        planMode,
        systemId,
        userMsgId: `u-${id}`,
        history: chatHistory,
        isSuggestion: !!isSuggestion,
        planExecuteId: meta?.planExecuteId,
        planReviseId: meta?.planReviseId,
        conversationId: effectiveConvId,
        image: imageData,
        previousResponseId,
      });
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
            // propose_plan = 제안(승인 대기)이지 실행이 아님 → 빈 reply fallback 을 "계획을 수립했습니다"로.
            // 단 PlanCard 블록이 실제로 렌더되면 카드가 곧 답변이라 대용 문구 생략(사족).
            const isPlanProposal = Array.isArray(ev.data.executedActions) && ev.data.executedActions.includes('propose_plan');
            const hasPlanCard = Array.isArray(blocksData)
              && blocksData.some(b => b.type === 'component' && (b as { name?: string }).name === 'PlanCard');
            const fullReply: string = ev.data.reply
              || (ev.data.error ? ''
                : isPlanProposal ? (hasPlanCard ? '' : '계획을 수립했습니다.')
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
      // AI 응답 영속 = chat route 가 server-side (post-system append, client disconnect 시에도 relay 완주 후).
      // 옛 프론트 saveToDb (turn-end 저장) 폐기 — admin·hub 둘 다 server-authoritative.
    }
  }, [input, loading, activeConvId, messages, aiModel, onRefresh, attachedImage, planMode, inputMode, setActiveConvId, hubContext]);

  // 레거시 JSON 모드의 handleConfirmPlan / handleRejectPlan 은 v0.1, 2026-04-22 제거됨.
  // 현재는 propose_plan 도구 → PlanCard (render_* blocks) → suggestions 의 plan-confirm 버튼으로
  // handleSubmit(text, true, { planExecuteId }) 호출 — 모두 Function Calling 경로.

  // Persist a single message (client-state: approve/reject, suggestion clear, pick lock, etc.) — admin·hub shared.
  // One path = convBackend.saveMessage → ConversationManager.append(owner). Re-saving the whole conversation for
  // one status flip is wasteful → upsert only the changed message (the message carries its own id for the row
  // upsert; convId locates the conv). DB is the authority → reconcile reads it so cards/chips never resurrect.
  const persistMessage = useCallback((convId: string, msg: Message) => {
    // promise 반환 — 승인 직후 onRefresh(reconcile 읽기)가 이 쓰기를 추월하지 않게 콜러가 await 가능.
    return convBackend.saveMessage(convId, msg);
  }, [convBackend]);

  // Persist after a pending-status change (approve/reject) — prevents card resurrection after reload/new-build.
  // messagesRef can be stale right after dispatch (before React re-render) → compute the new status directly and save now.
  const persistPendingChange = useCallback((msgId: string, planId: string, patch: Partial<{ status: 'approved' | 'rejected' | 'past-runat' | 'error'; errorMessage: string; originalRunAt: string }>, argsPatch?: Record<string, unknown>) => {
    const convId = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (!convId) return;
    const updated = messagesRef.current.map(m =>
      m.id !== msgId
        ? m
        : {
            ...m,
            pendingActions: m.pendingActions?.map(p => p.planId === planId
              ? { ...p, ...patch, ...(argsPatch ? { args: { ...(p.args ?? {}), ...argsPatch } } : {}) }
              : p),
          },
    );
    // 1) update the localStorage conv cache synchronously — it loads first on reload, so status shows immediately (optimistic).
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(convStorageKey) : null;
      if (raw) {
        const convs = safeJsonParse<Conversation[]>(raw, []);
        const next = convs.map(c => c.id === convId ? { ...c, messages: cleanMessages(updated), updatedAt: Date.now() } : c);
        localStorage.setItem(convStorageKey, JSON.stringify(next));
      }
    } catch (e) { logger.warn('useChat', 'localStorage pending status update 실패', { error: e }); }
    // 2) backend persistence — append only the changed message. promise 반환(콜러 await 용).
    const updatedMsg = updated.find(m => m.id === msgId);
    return updatedMsg ? persistMessage(convId, updatedMsg) : Promise.resolve();
  }, [activeConvId, persistMessage]);

  // Pending tool 개별 승인
  const handleApprovePending = useCallback(async (msgId: string, planId: string, action?: 'now' | 'reschedule', newRunAt?: string) => {
    try {
      // Single owner-injected commit (convBackend.commitPlan): admin /api/plan/commit / hub /api/hub/<slug>/plan.
      // hub ignores action/newRunAt (no schedule_task). Result handling below is shared.
      const data = await convBackend.commitPlan(planId, action, newRunAt);
      if (data.success) {
        const rescheduled = action === 'reschedule' && newRunAt ? newRunAt : undefined;
        dispatch({ type: 'PENDING_APPROVED', msgId, planId, newRunAt: rescheduled });
        // persist 를 refresh 보다 먼저 + await — onRefresh 의 reconcile 이 DB 를 읽으므로,
        // fire-and-forget 이면 읽기가 쓰기를 추월해 승인 카드가 사라질 수 있음(2026-07-15 실측).
        // 재예약이면 카드 실행 시각(args.runAt)도 새 시간으로 영속 (옛엔 원래 시간이 계속 표시)
        await persistPendingChange(msgId, planId, { status: 'approved' }, rescheduled ? { runAt: rescheduled } : undefined);
        onRefresh();
        window.dispatchEvent(new Event('firebat-refresh'));
      } else if (data.code === 'PAST_RUNAT') {
        dispatch({ type: 'PENDING_PAST_RUNAT', msgId, planId, originalRunAt: data.originalRunAt });
        persistPendingChange(msgId, planId, { status: 'past-runat', originalRunAt: data.originalRunAt });
      } else {
        const errorMessage = data.error || '실행 실패';
        dispatch({ type: 'PENDING_ERROR', msgId, planId, errorMessage });
        persistPendingChange(msgId, planId, { status: 'error', errorMessage });
      }
    } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
  }, [onRefresh, persistPendingChange, convBackend]);

  // Pending tool 개별 거부 — single owner-injected reject (convBackend.rejectPlan).
  const handleRejectPending = useCallback(async (msgId: string, planId: string) => {
    try {
      await convBackend.rejectPlan(planId);
      dispatch({ type: 'PENDING_REJECTED', msgId, planId });
      persistPendingChange(msgId, planId, { status: 'rejected' });
    } catch (e) { logger.debug('chat', 'operation 실패', { error: e }); }
  }, [persistPendingChange, convBackend]);

  // On suggestion click, clear that message's suggestions + persist the single message — stops the card from
  // reappearing on refresh (admin·hub shared).
  const consumeSuggestions = useCallback((msgId: string) => {
    const convId = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (convId) {
      const updatedMsg = messagesRef.current.find(m => m.id === msgId);
      if (updatedMsg) persistMessage(convId, { ...updatedMsg, suggestions: undefined });
    }
    dispatch({ type: 'CONSUME_SUGGESTIONS', msgId });
  }, [activeConvId, persistMessage]);

  // Lock a picked chip — unlike consumeSuggestions (which removes chips), keeps the chips and records only the
  // picked text (for the locked-highlight render). Persists the single message.
  const lockSuggestion = useCallback((msgId: string, picked: string) => {
    const convId = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem(activeConvStorageKey) : null);
    if (convId) {
      const updatedMsg = messagesRef.current.find(m => m.id === msgId);
      if (updatedMsg) persistMessage(convId, { ...updatedMsg, pickedSuggestion: picked });
    }
    dispatch({ type: 'LOCK_SUGGESTION', msgId, picked });
  }, [activeConvId, persistMessage]);

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
